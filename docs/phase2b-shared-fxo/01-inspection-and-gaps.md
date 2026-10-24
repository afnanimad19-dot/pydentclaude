# Phase 2B shared FXO line — A. repository inspection, B. gap analysis

Date: 2026-10-24. Branch: `claude/program-handover-new-chat-gwfazu`
(based on `claude/phase2e-outbound-recorded-calls` @ `aece238`, itself on
`claude/phase2c-knowledge-integration` @ `4ed4763`). Working tree was clean at
inspection. The outbound PR (draft PR #3) is **not merged and not deployed**;
migration 0069 is staged in `supabase/pending/`, **applied nowhere**.

## A. What already exists (preserved, not duplicated)

| Concern | Where | State |
| --- | --- | --- |
| Outbound campaign dialer | `src/lib/outbound-call.ts` (pure gate) + `src/lib/outbound-call-server.ts` (LiveKit/Azure/Supabase bindings) | Fail-closed, ordered gate: direction → active → **explicit admin approval** → halt streak → lead pending → canonical phone → **verified marketing eligibility** → **DNC** → worker agent → outbound trunk → recording env → single live call. Recording egress starts **before** the SIP dial. |
| Lead tables | staged `supabase/pending/0069_outbound_campaign_leads.sql` | `campaign_leads` (status machine pending→claimed/calling→done/failed/blocked; three separate consent facts), `voice_dnc` (permanent, campaign-independent), `campaigns.approved_at/approved_by/halted_reason`, `voice_numbers.livekit_outbound_trunk_id`. Partial unique index = one `calling` lead per workspace (S4). |
| Call scheduling | `placeCampaignCall` — one call per invocation, oldest pending lead, compare-and-set claim, stale-`calling` sweep (15 min). | No line-level scheduling; workspace-level single call only. |
| Call lifecycle | intent row in `voice_calls` pre-dial → LiveKit webhook (`room_started`/`room_finished`/`egress_ended`, signature-verified per workspace) → worker call-log post (`/api/livekit/call-log`, worker-token auth) closes the lead, writes consent + DNC. | Sound; no reservation linkage. |
| LiveKit SIP integration | `SipClient.createSipParticipant(trunkId, +E164, room)`; identity `sip-out-<lead8>`; `voice_numbers.livekit_outbound_trunk_id` server-written only, empty = disabled. | No trunk exists yet (provisioning is a separately-approved step). |
| Webhook auth | LiveKit webhook: per-workspace signature verification. Call-log: `resolveWorkerToken` (env or per-workspace `livekit_config.worker_token`). | Reused as-is. |
| Recording | `startRoomCompositeEgress` → Azure (env `RECORDING_AZURE_*`), pre-dial, P2 halt after 3 consecutive recording failures, size-verification (`verify-recording`). | Reused as-is. |
| DNC & consent | canonical phone everywhere (S2); `voice_dnc` checked pre-dial and written on declined/opt-out; structured marketing-eligibility attestation; worker `record_opening_consent` tool; strict answered-gate (`wait_for_sip_answer`, identity + `sip.callStatus == "active"`, S3). | Reused as-is. |
| Security fixes S1–S4 | `aece238` | S1 admin-only approval; S2 canonical phones; S3 strict answered gate; S4 DB-enforced single calling slot. All preserved. |
| Tests | `tests/outbound-call.test.mjs` (+ full suite, 963 passing at `aece238`) | Conventions: pure-logic tests + source-level invariants; offline only. |

## B. Gap analysis vs. the single-FXO shared-line requirement

The existing implementation assumes the outbound trunk is a dedicated
resource. The clinic's reality is **one analog FXO loop shared with
production inbound (Laura)**. Missing pieces, now added in this phase:

1. **No line-level state model.** `another_call_live` counts workspace
   outbound calls; nothing represents the physical line (inbound occupancy,
   cooldown, maintenance, unknown). → `src/lib/shared-line.ts` state model
   (IDLE / INBOUND_ACTIVE / OUTBOUND_RESERVED / OUTBOUND_DIALING /
   OUTBOUND_ACTIVE / COOLDOWN / UNKNOWN / UNAVAILABLE).
2. **No inbound priority.** The dialer never looked at inbound calls at all.
   → live inbound `voice_calls` rows block admission (wide 60-min window,
   fail closed); read errors count as inbound-present.
3. **Unknown treated as idle.** Previously, absence of rows permitted a dial.
   → UNKNOWN now blocks; "idle" requires a **fresh observation from a trusted
   source** (today only `operator_attested`; no D-Link interface is verified —
   see deliverable K), so automated initiation is structurally disabled.
4. **No line reservation.** The S4 lead slot is per-workspace and lead-table
   specific. → `line_reservations` with a per-line partial unique index
   (atomic across workers), TTL expiry, crash cleanup that never releases a
   verifiably live call, reconciliation with `voice_calls`.
5. **No idempotency.** Rapid duplicate `start-next` requests raced the lead
   claim. → mandatory idempotency key, unique per workspace, replays refused.
6. **No cooldown.** → post-termination cooldown (default 60 s) before the
   next admission.
7. **No destination policy.** `canonicalPhone` accepted any 7–15 digit
   number. → UAE-mobile-only policy, own-number and special-service
   rejection, enforced app-side **and again in the proposed Asterisk context**
   (03-asterisk-outbound-context.md).
8. **No maintenance mode.** → `shared_lines.maintenance`.
9. **No line audit trail.** → append-only `shared_line_events`.
10. **Asterisk side**: only the permissive `[from-phoenix]` (`_X.` →
    `Dial(PJSIP/9${EXTEN}@dlink-pbx)`) exists, trusted-IP only, no auth, no
    destination restrictions, no channel/duration caps. It must **not** be
    exposed to LiveKit. → proposed `[from-pydent-outbound]` (document only;
    no production change in this phase).

Nothing existing was modified destructively: the dialer, its gate, the
recording pipeline, the webhook, number routing and the worker's inbound path
are untouched (asserted by tests). The new controller sits **in front of**
`placeCampaignCall`, strictly narrowing admission.
