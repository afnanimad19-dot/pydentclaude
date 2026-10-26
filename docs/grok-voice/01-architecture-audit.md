# Fast-track Phase 1 — architecture audit (2026-10-26)

Base: `claude/program-handover-new-chat-gwfazu` @ `995efe4`, branch
`feature/grok-voice-inbound-outbound`. Companion to
`docs/phase2b-shared-fxo/01-inspection-and-gaps.md` (shared-line specifics).

## How a call works today

* **Config:** everything per-agent lives in `agents` (+ `voice_settings`
  JSONB). `livekitAgentConfig()` (src/lib/livekit.ts) compiles the live
  config — prompt sections, models, tools, timers — served to the worker by
  `/api/livekit/agent-config` (worker-token auth, workspace-pinned) at the
  start of EVERY call. No sync step; edits apply on the next call.
* **Worker:** one deployed LiveKit agent (`livekit-agent/agent.py`,
  `pydent-agent`) dispatched into every room with `{pydentAgentId, ws}`
  metadata. Pipeline engine: `inference.STT/LLM/TTS` (LiveKit Inference —
  LiveKit Cloud credentials, no per-provider keys). Tools call back into
  `/api/agents/tool-exec`; knowledge via `search_knowledge` (Central
  Knowledge, Phase 2C); booking/reschedule/cancel/lookup via booking-server
  (exact-duplicate guard = idempotent booking); transfer, silence watchdog,
  call-ending modes; outbound rooms add the strict answered-gate +
  `record_opening_consent`.
* **Lifecycle:** intent row in `voice_calls` (outbound) → LiveKit webhook
  (`room_started/finished`, `egress_ended`; signature-verified per workspace)
  → worker call-log post closes the record, the campaign lead, the line
  reservation and (new) the queue item.
* **Outbound (Phase 2A/2B):** `/api/livekit/outbound` (admin-only) →
  shared-line controller (`shared-line-server.ts`: admission → atomic
  per-line reservation → consumed attestation → final re-check) → campaign
  dialer (`outbound-call-server.ts`: approval → eligibility → DNC →
  recording-before-dial → S4 calling slot → `createSipParticipant`).
* **Call-initiation paths (complete list, verified by grep):**
  1. `placeCampaignCall` → `SipClient.createSipParticipant` — the ONLY SIP
     dial path; reachable solely through `placeLineGuardedCall`.
  2. LEGACY `/api/vapi/outbound` (Vapi cloud) — was unauthenticated; now
     admin-gated + DNC-checked (this branch). Dies with Vapi shutdown V1.
  3. LEGACY workflow "call" steps → `placeOutboundCall` (Vapi cloud) — now
     DNC-checked (this branch).
  Neither legacy path can touch the FXO line (Vapi numbers only).
* **Migrations:** 0069 (leads/DNC/approval), 0070 (shared line), 0071 (queue,
  this branch) — ALL staged in `supabase/pending/`, applied nowhere;
  `supabase/migrations/` is a hash-pinned closed world ending at 0068. Until
  applied, outbound structurally refuses (`db_unavailable`).

## What this fast-track adds

| Area | Change |
| --- | --- |
| Voice engine | `src/lib/voice-engine.ts` + worker mirror: per-agent `pipeline` \| `grok-realtime` (`xai/grok-voice-3.0` via LiveKit Inference `RealtimeModel` — same LiveKit credentials, verified against xAI + LiveKit docs). Connect-time-only fallback; no mid-call switching; engine + fallback recorded on the call record. |
| Receptionist safety | Worker identity pin (`verified_phone`): lookups/reschedules/cancels are tied to the captured caller number; prompt gains an IDENTITY & PRIVACY rule. |
| Outbound service | `call_queue` (staged 0071) + `call-queue.ts`/`-server.ts`: reminders/confirmations/follow-ups/callbacks/outreach as scheduled items over campaign leads; calling-hours gate (Asia/Dubai default), retry with backoff, per-attempt idempotency, close-out by call key. Every dial still goes through the full guarded path; `queue-run` is an explicit admin action (no cron — K-1 keeps automation disabled). |
| Safety fixes (T1) | DNC read fails closed in the dialer; legacy Vapi route admin-gated + DNC; workflow calls DNC-checked; fresh line-row reads around admission; attestation consumed per reservation; `service_relationship` consent basis for transactional calls. |
| Dashboard | Voice-engine selector (agent model card); shared FXO line status card (8 states, operator attest + maintenance; never shows "Available"). |

Unchanged on purpose: inbound pipeline (webhook/session/number routing),
Laura dispatch, `from-dlink`, `livekit-india-test`, all telephony, all
deploys, all migrations.
