# Fast-track Phase 10 — delivery report (2026-10-26)

Branch `feature/grok-voice-inbound-outbound` (from `995efe4`). Labels:
**IMPLEMENTED** (code on this branch) · **TESTED** (covered by the offline
suite) · **BLOCKED** (cannot proceed without an external prerequisite) ·
**NOT VERIFIED** (claim needs real-world evidence) · **REQUIRES APPROVAL**
(separately-approved step, untouched).

## A. Architecture audit — IMPLEMENTED (docs/grok-voice/01-architecture-audit.md)

## B/C. Grok Voice integration + provider interface — IMPLEMENTED, TESTED (offline)

* Verified against official docs (not invented): Grok Voice Agent API is
  OpenAI-Realtime-compatible speech-to-speech; flagship pinned id
  `grok-voice-3.0`, reachable in LiveKit Agents as **LiveKit Inference
  `RealtimeModel` model `xai/grok-voice-3.0`** (uses the existing LiveKit
  Cloud credentials — no new secret) or the `livekit-agents[xai]` plugin
  (`XAI_API_KEY`, self-billing). Arabic supported (incl. `ar-AE`), function
  tools supported, server-VAD barge-in, G.711/PCM/Opus. `grok-voice-latest`
  (moving alias) and `grok-voice-2.0` (deprecated) are REFUSED by the pinned
  registry.
* `src/lib/voice-engine.ts` (+ worker mirror in `livekit-agent/agent.py`):
  engine selection per agent, connect-time-only fallback to the pipeline
  (visible, recorded on the call record), refusal when fallback is disabled,
  NO mid-call switching (a mid-call engine swap could lose context or
  duplicate tool actions — a fatal engine error ends the call cleanly
  instead). Streaming audio, interruptions, tools, knowledge, timeouts ride
  the existing AgentSession machinery unchanged.
* NOT VERIFIED: actual Grok call quality/latency and tool-calling behavior on
  a live session — needs the browser/web-test session (below). AMD on the
  realtime engine is deliberately not started (unverified compatibility).

## D. Inbound receptionist — IMPLEMENTED (capabilities pre-existing + hardened), partially TESTED

Existing worker already covers: intent handling, knowledge search, slot
availability, booking (idempotent: exact-duplicate refusal), reschedule,
cancel, human transfer, English/Arabic (auto language switch; Grok Voice adds
native ar-AE), interruption handling, silence check-ins, disconnect handling.
Added: patient **identity pin** (sensitive tools run against the captured
caller number; a model-supplied different number is ignored) and the
IDENTITY & PRIVACY prompt rule. No invented availability (slots only from
`get_available_slots`), no diagnoses (style guardrails unchanged).

**BLOCKED: browser-based live testing.** A web test session needs the running
deployment + the workspace's LiveKit project credentials; neither exists in
this container, and redeploying the worker/app is REQUIRES APPROVAL. Create
the Grok test agent by duplicating Laura in the dashboard and setting Voice
engine → "Realtime — Grok Voice 3.0" (stored in `voice_settings` — no
migration needed), then use the existing web-test call. Production Laura
dispatch untouched.

## E. Outbound calling — IMPLEMENTED, TESTED (offline)

`call_queue` (staged 0071) + queue runner: individual calls, reminders,
confirmations, follow-ups, callbacks, approved outreach — each item rides a
campaign lead, so ALL ten mandated gates run on every dial: workspace auth
(admin route) → campaign approval (S1) → consent (attested eligibility; new
`service_relationship` basis for transactional calls) → DNC (canonical, fail
closed) → **calling hours** (Asia/Dubai default Mon–Sat 09:00–18:00,
per-campaign override) → destination validation (UAE mobiles only) →
duplicate prevention (per-attempt idempotency + one live item per lead +
one reservation per line) → concurrency (two DB partial unique indexes) →
physical-line availability (attested idle only; unknown blocks) → atomic
shared-line reservation. Outcome tracking: queue status + lead status +
`voice_calls` + line audit events. Retry: `no_answer`/`sip_failed` only, with
backoff, capped; reached humans and DNC blocks are terminal. No alternate
outbound API: the queue calls `placeLineGuardedCall` exclusively (tested).

## F. Shared-line safety improvements — IMPLEMENTED, TESTED (offline)

All T1 findings fixed on this branch: DNC fail-open on DB error (HIGH) →
refuses; stale line-row admission (MEDIUM) → fresh reads around every check;
attestation reuse (LOW) → consumed per reservation; legacy unauthenticated
`/api/vapi/outbound` (CRITICAL) → admin-gated + DNC-filtered (full removal
stays with Vapi shutdown V3); workflow calls → DNC-checked. Standing
invariants retained: inbound priority, unknown-never-idle, expiry never
releases a live call, late events can't corrupt newer reservations, DB
failures refuse. **A recent operator attestation is not continuous
monitoring** — automated outbound initiation remains structurally disabled
(no cron; idle requires a fresh attestation) until K-1 is resolved.

## G. Dashboard — IMPLEMENTED

Voice-engine selector + realtime voice/fallback controls in the agent model
card; shared FXO line status card on the campaigns page (all 8 states, attest
/ maintenance / refresh; wording never claims "Available"; documents the
inbound-busy limitation). Queue admin UI is API-first for now (`queue-add`,
`queue-run`, `queue-status` actions) — a visual queue table is future work.

## H. Automated tests — TESTED

**1010/1010 pass** (`npm test`), +27 new across `voice-engine.test.mjs`,
`call-queue.test.mjs`, `receptionist-safety.test.mjs`, extended
`shared-line.test.mjs`: provider selection/fallback/refusal, pinned registry,
no-mid-call-switch (source-level), identity pin, booking idempotency, inbound
priority, unknown state, concurrency (DB-constraint + source-level),
reservation expiry, late webhooks, DNC enforcement (incl. fail-closed reads),
consent bases, calling hours, retry policy, duplicate prevention, tenant
scoping, provider/database failures, disconnect close-out. `tsc`, `eslint`
and `next build` green. Caveat carried over from T1: DB-level atomicity rests
on staged SQL text until 0069–0071 are applied and exercised (offline-only
convention); the worker's Python is compile-checked, not session-tested.

## I. Deployment requirements (each REQUIRES APPROVAL)

1. Apply migrations 0069 + 0070 + 0071 (move to `migrations/`, re-pin
   a7-manifest; booking branch renumbers to 0072+).
2. Merge/deploy the app branch (Netlify NO-GO rules stand until builds are
   locked); worker redeploy via the manual GitHub workflow.
3. LiveKit→Pi path, outbound trunk, Asterisk context, supervised tests T1–T4
   (see docs/phase2b-shared-fxo/05-deployment-readiness.md — unchanged).
4. Grok live validation: one web-test call on a duplicated Laura agent, then
   latency/quality review before any patient-facing use.

## J. Remaining blockers

Unchanged from the T1 report (G-1 items are now FIXED on this branch): K-1
physical line-state source; K-5 answer supervision (NOT VERIFIED — SIP 200 OK
is still presumed pre-answer); K-6 LiveKit→Pi path; canary DB read path down
(72D + apply verification); live browser testing environment; retention
policy (P3).

## K. Production readiness — **NOT PRODUCTION-READY**

The build being green proves compilation, not readiness. Outbound stays
blocked on physical line verification and answer supervision; the Grok engine
is unvalidated on a live call; migrations are unapplied. Inbound Laura is
untouched and unaffected by this branch until a deploy is approved.
