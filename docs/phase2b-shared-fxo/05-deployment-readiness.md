# Phase 2B shared FXO line — F(phase). deployment readiness: I. safety checklist, J. pilot plan, K. hardware unknowns

Date: 2026-10-24. **Verdict: NOT production-ready.** The application-side
controller is implemented and tested offline, but physical line availability,
outbound call completion and answer supervision are all unverified (K-1,
K-5), the safety migrations are unapplied, and no telephony leg exists.
Nothing here claims otherwise.

## I. Production safety checklist (all boxes must be checked, each change separately approved)

Application:
- [ ] Migration 0069 applied (move from `supabase/pending/` → `migrations/`,
      re-review + re-pin a7-manifest) — until then outbound refuses.
- [ ] Migration 0070 applied (same procedure) — until then every admission is
      `db_unavailable` (fail closed).
- [ ] Code reviewed & merged per the program's PR process (PR #3 + this
      phase; PR #2 Netlify NO-GO still stands — merging a deployed branch
      must be assumed to auto-deploy).
- [ ] `RECORDING_AZURE_*` present in the deploy context (recording is
      mandatory pre-dial).
- [ ] Campaign approved (S1 admin action), leads seeded, marketing
      eligibility attested with documented evidence, DNC list loaded.

Telephony (each its own approval; none done):
- [ ] T0 runbook executed on the live Pi/D-Link (read-only capture).
- [ ] LiveKit→Pi network path built and verified (P-2).
- [ ] `[from-pydent-outbound]` + `pydent-livekit-out` endpoint reviewed
      against T0 findings, then applied (P-1, P-3).
- [ ] LiveKit outbound trunk created; trunk id stored in
      `voice_numbers.livekit_outbound_trunk_id`.
- [ ] Worker redeployed if needed.

Verification (blocking):
- [ ] Supervised tests T1–T4 below passed, one call per authorization.
- [ ] Answer-supervision characterization done (02-architecture §C.1);
      either reliable supervision is established, or the opening flow is
      adapted and the limitation is accepted in writing by the operator.
      **Until then outbound production activation is BLOCKED.**
- [ ] Recording playback smoke test: a human listened to a pilot recording
      (two-way audio is proven by listening, never by blob size).
- [ ] Inbound regression: test inbound call to +97143985241 reaches Laura
      unchanged after every telephony change.

## J. Controlled pilot plan

One call per explicit authorization; LHDM-owned mobile as the destination;
operator at the clinic observing the physical line; rollback after every
step (clear `livekit_outbound_trunk_id` → outbound disabled).

* **T1 — dial path:** admin attests line idle (`attest-line-idle`, 120 s
  validity) → `start-next` on a one-lead test campaign → verify: egress
  started before dial, LHDM mobile rings, correct caller ID noted (K-4),
  reservation `dialing→released`, cooldown applied, lead closed, recording
  verified by listening.
* **T2 — answer supervision characterization:** answer at different moments
  (immediately / after 15 s / never). Record when the D-Link returns 200 OK
  vs. actual pickup; whether the worker's gate opens on ringback; whether
  no-answer produces `no_answer` without any speech. Capture SIP traces on
  the Pi (read-only) for K-5.
* **T3 — inbound priority:** while an inbound call is live, `start-next`
  must refuse with `inbound_active`; after hangup, outbound stays blocked
  (unknown) until re-attested. Separately: place an outbound call, then call
  the clinic from another phone and document what the inbound caller
  experiences (busy? carrier service?) — K-2.
* **T4 — declined path:** recipient declines the opening → call ends
  politely, `opening_consent=declined`, number lands in `voice_dnc`, P1
  provisional-keep policy applied to the recording.
* Exit criteria to request production approval: T1–T4 pass, limitations
  K-2/K-5 documented and accepted, retention policy (P3) decided.

## K. Hardware-side unknowns that MUST be verified before deployment

* **K-1 Physical FXO state visibility.** No supported, authenticated,
  read-only D-Link DVX-2005F interface for FXO port state has been verified.
  Candidates to investigate during T0 (read-only): the web GUI's
  trunk/port status pages (and whether they are scriptable with auth), SNMP,
  any AMI-like interface. Until one is verified, `dlink_api` stays an
  untrusted source, automated outbound initiation stays structurally
  disabled, and only operator attestation (TTL 120 s) can admit a supervised
  call. **This is the standing missing prerequisite.**
* **K-2 Carrier busy behaviour.** What an inbound caller gets while the FXO
  loop is held (busy tone? Etisalat/e& call waiting? forward-on-busy?).
  Operator to confirm with the carrier; decides whether missed-call
  mitigation is possible.
* **K-3 FXO disconnect supervision.** Trunk1 relies on busy-tone detection
  (count 3); polarity answer/hangup are off. Verify real hangup detection
  latency during T2 (affects cooldown length and stuck-line risk).
* **K-4 Outbound caller ID.** On an analog FXO line the carrier sets the
  presented CLI; verify what the recipient actually sees (expected: the
  line's number 04 398 5241; the LiveKit trunk's `numbers` field does not
  control an FXO line's CLI).
* **K-5 Answer signal timing.** Whether the D-Link answers the SIP leg
  before the remote patient answers (expected: yes, absent polarity
  reversal). Measured in T2; blocks production activation until
  characterized (02-architecture §C.1).
* **K-6 LiveKit→Pi path.** No inbound path from LiveKit India to the Pi
  exists or is verified (03-asterisk §prerequisite P-2). Also confirm the
  rasberryPI5 trunk's 2-channel limit interacts sanely with one extra
  outbound call (inbound leg + outbound leg simultaneously = 2 channels).
* **K-7 `[from-phoenix]` ground truth.** The live Pi's `[from-phoenix]`
  context and 9-prefix behaviour are operator-supplied facts; T0 captures
  them verbatim (F1–F5 of the pending T0 checklist). Never inferred from the
  repo.
