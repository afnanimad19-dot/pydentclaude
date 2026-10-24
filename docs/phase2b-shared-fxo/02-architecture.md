# Phase 2B shared FXO line — C. architecture, D. reservation design

One physical analog line (Etisalat/e& → **D-Link DVX-2005F Trunk1, FXO
port 1**, +971 4 398 5241) is shared between:

* **Inbound (production-critical, priority):** FXO 1 → D-Link → SIP trunk
  `rasberryPI5` (192.168.1.132) → Asterisk `[from-dlink]` →
  `PJSIP/livekit-india-test` → Laura AI. **Unchanged by this phase.**
* **Outbound (new):** Pydent → LiveKit outbound SIP trunk → (proposed)
  Asterisk `[from-pydent-outbound]` → `PJSIP/9<local>@dlink-pbx` → Trunk1 →
  FXO 1 → carrier.

## C.1 Physics first: what software can and cannot guarantee

* One FXO loop carries **one call**. There is no second channel.
* While an outbound call holds the loop, a new inbound caller gets whatever
  the carrier does on busy (busy tone, or a carrier service such as call
  waiting / forward-on-busy — **unverified**, see deliverable K). **Software
  locking cannot preempt the analog line and does not guarantee inbound
  reception during an outbound call.** The controller only minimizes the
  occupied window (one short call at a time + cooldown) — it cannot eliminate
  it.
* The D-Link gives us **no verified machine-readable FXO state** today, and
  Trunk1 has **polarity-based answer and hangup supervision disabled**
  ("Answer on polarity switch: No", "Hangup on polarity switch: No"; busy
  detection: tone-based, count 3). Consequences:
  * **Line availability cannot be established programmatically.** An empty
    Asterisk channel list only proves Asterisk isn't using the line — a call
    could exist on the D-Link/carrier side. Therefore UNKNOWN blocks and the
    only trusted idle source today is a human operator attestation
    (`operator_attested`, TTL 120 s). Automated outbound initiation stays
    structurally disabled until a verified source exists (deliverable K).
  * **Answer supervision is unreliable.** Without polarity reversal, the
    D-Link will typically answer the SIP leg (200 OK) when it has seized the
    FXO loop and finished out-pulsing digits — i.e. while the patient's phone
    is still RINGING. A SIP 200 OK (and LiveKit's `sip.callStatus ==
    "active"`) is therefore **not proof the patient answered**. The worker's
    strict answered-gate is kept (necessary), but it is **not sufficient**:
    the mandatory opening may start against ringback. Supervised tests must
    characterize the actual timing (does 200 OK arrive pre-answer? does the
    agent hear ringback?) before any production activation; until then,
    **outbound production activation is blocked** on this ground alone.
    Mitigations to evaluate in the pilot: LiveKit/worker-side early-media
    handling, answering-machine detection, and waiting for first inbound
    speech before the opening.
  * **Hangup detection** relies on busy-tone detection (count 3) — slow and
    occasionally wrong on analog lines. The cooldown (60 s) exists partly so
    a not-yet-released loop is never immediately re-seized.

## C.2 Line state model (deterministic, auditable)

States: `idle`, `inbound_active`, `outbound_reserved`, `outbound_dialing`,
`outbound_active`, `cooldown`, `unknown`, `unavailable`.

Derivation (`deriveLineState`, pure function, strict precedence):

```
maintenance?                        → unavailable
live inbound call seen?             → inbound_active
holding reservation reserved?       → outbound_reserved
holding reservation dialing?        → outbound_dialing
holding reservation active?         → outbound_active
cooldown_until in the future?       → cooldown
fresh idle obs. from trusted source → idle
otherwise                           → unknown
```

* **Admission requires exactly `idle`.** Every other state refuses, each with
  its own machine-readable reason. UNKNOWN is never idle (fail closed).
* Inbound detection: live inbound LiveKit `voice_calls` rows (status
  `live`/`in-progress`, started within 60 min). The window is deliberately
  wide: a stale row *blocks* calls (safe) rather than permits them. A failed
  read counts as inbound-present.
* Observations: `shared_lines.observed_state/at/source/ttl` — the last report
  about the **physical** line. Only `operator_attested` is trusted;
  `dlink_api` is reserved for a future verified integration. Future-dated or
  stale observations are invalid.
* Every transition and admission decision is appended to
  `shared_line_events` (line, reservation, campaign, lead, call key,
  from→to, reason, actor — never credentials or patient content).

## D. Reservation design (scheduling control, not proof of line state)

Table `line_reservations` (staged migration
`supabase/pending/0070_shared_fxo_line.sql`, **not applied anywhere**):

* **Atomicity:** partial unique index — at most one reservation per line in
  `('reserved','dialing','active')`. Two workers inserting concurrently: the
  second gets a 23505 unique violation → surfaced as `line_busy_outbound`,
  never a second call. In-memory locks are not used anywhere.
* **Idempotency:** `(workspace_id, idempotency_key)` unique; the UI sends a
  fresh UUID per attempt; a replay returns `duplicate_request` with the
  original reservation — never a second LiveKit call.
* **Status machine:** `reserved → dialing → active → released`, with
  `released/expired/failed` terminal; transitions validated
  (`canTransitionReservation`) and applied compare-and-set on the previous
  status.
* **Expiry & crash cleanup (sweep, runs before every admission/status read):**
  * `reserved`/`dialing` past TTL (120 s) with **no verifiable live call** →
    `expired` (a crashed worker cannot wedge the line).
  * any holding reservation past TTL whose call is **verifiably in
    progress** → TTL **extended** (an expired reservation never releases an
    active call).
  * holding reservation whose call is **verifiably ended** (`voice_calls`) →
    `released` (reconciled) + cooldown.
  * `dialing` whose call is confirmed in progress → promoted to `active`.
* **Verified termination:** the worker's call-log post releases the
  reservation **by call key only** (`callEndReleases`): a late or replayed
  event about an older call can never release a newer reservation; terminal
  reservations are immutable.
* **Cooldown:** on release (verified end, reconciliation, or a `sip_failed`
  attempt that may have touched the loop), `cooldown_until = now +
  cooldown_seconds` (default 60 s).

## C.3 Guarded outbound sequence (implemented)

```
1  campaign approved (existing S1 admin action)
2  lead selected (oldest pending, or explicit leadId)
3  destination policy: canonical UAE mobile only; own number, special
   services, non-mobile, international → refused and lead blocked
4  shared-line admission (state must be exactly idle)
5  atomic reservation insert (unique per line; idempotency key)
6  FINAL availability re-check (inbound may have started meanwhile;
   own reservation excluded) — on loss: release + refuse
7  existing fail-closed dialer placeCampaignCall:
   approval → eligibility → DNC → trunk → RECORDING EGRESS BEFORE DIAL →
   S4 single calling slot → SIP dial
8  reservation → dialing (call key attached); sweep promotes to active
9  lifecycle monitored (webhook + worker call-log + reconciliation)
10 verified termination → reservation released → cooldown → next lead
   considered only after a fresh idle verification
```

Both gates run — the line controller **adds** restrictions and bypasses
nothing. All checks live in `src/lib/shared-line.ts` (pure) and
`src/lib/shared-line-server.ts` (bindings); the route
`/api/livekit/outbound` is admin-only and its `start-next` action goes
through the controller exclusively.

## C.4 Inbound priority (spec §8)

* Any live inbound call → admission refused (`inbound_active`) — new outbound
  calls stop immediately; the established inbound call is never touched.
* The inbound-active fact is recorded in the audit trail via admission
  refusals; the inbound call itself is tracked in `voice_calls` as today.
* An established inbound call is **never interrupted**: the controller has no
  teardown path for inbound; it only refuses to start outbound.
* Resume: after the inbound row ends, the state returns to UNKNOWN (not
  idle) — outbound resumes only after a fresh trusted idle verification, plus
  cooldown where applicable.
* **Documented limitation:** during an outbound call the line is busy to
  inbound callers; software cannot guarantee inbound preemption on one analog
  loop. Carrier-side mitigations (call waiting, forward-on-busy to a mobile,
  hunting to a second line) must be investigated with Etisalat/e& —
  deliverable K, operator action.

## C.5 Audit record (spec §10)

Per attempt: campaign id, lead id, workspace id, reservation id, idempotency
key, LiveKit room/call key (`lk:<room>`), destination (canonical), timestamps
(reservation, dial start via `voice_calls.started_at`, end via
`ended_at`), disposition (`campaign_leads.status/status_detail`,
`voice_calls.status/ended_reason`), opening-consent outcome, DNC decisions
(`voice_dnc.source`), and every line state transition
(`shared_line_events`). An Asterisk call identifier is **not available** to
the app today (no AMI integration) — documented gap; the proposed dialplan
logs a correlation CDR variable for manual joins during the pilot. Answered
timestamp is recorded only as "verified answer" once supervision is
validated; until then dispositions deliberately avoid claiming ANSWERED from
SIP 200 OK alone.
