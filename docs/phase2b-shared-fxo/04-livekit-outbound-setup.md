# Phase 2B shared FXO line — G/E. LiveKit outbound SIP configuration (INSTRUCTIONS)

**Status: instructions for a separately-approved provisioning step. No trunk
has been created; `voice_numbers.livekit_outbound_trunk_id` is empty
everywhere, so the dialer fails closed. Do not execute without explicit
approval.**

## Application side (already implemented, this phase)

* `start-next` goes through the shared-line controller
  (`placeLineGuardedCall`): line admission → atomic reservation → final
  re-check → existing fail-closed dialer (recording egress **before** dial) →
  reservation tracks the call until verified termination → cooldown.
* The SIP leg is created with
  `SipClient.createSipParticipant(trunkId, "+<canonical>", room,
  { participantIdentity: "sip-out-<lead8>" })` — the identity the worker's
  answered-gate requires (S3). Unchanged from the approved Phase 2A dialer.
* No second calling provider is introduced; everything rides the existing
  per-workspace LiveKit credentials.

## Provisioning steps (when separately approved)

1. **Create the outbound SIP trunk** in the workspace's LiveKit project
   (LiveKit CLI/API; one trunk per clinic number):
   * numbers: `+97143985241` (caller ID the trunk presents; actual CLI on an
     FXO line is set by the carrier — see hardware unknowns);
   * destination: the verified Pi ingress address from prerequisite P-2 of
     `03-asterisk-outbound-context.md` (NOT created yet);
   * transport per the verified path; `auth_username`/`auth_password` =
     the digest credentials provisioned for the `pydent-livekit-out`
     endpoint (set out-of-band; never committed, never echoed to logs).
2. **Store the trunk id** (server-side only) in
   `voice_numbers.livekit_outbound_trunk_id` for the clinic number row. An
   empty value keeps outbound disabled — that is the rollback switch.
3. **Worker**: the deployed LiveKit agent (`livekit-agent/agent.py`) already
   handles outbound rooms (`_out_` rooms: strict answered-gate, mandatory
   opening, `record_opening_consent`). Redeploy via
   `.github/workflows/deploy-livekit-agent.yml` only if the worker revision
   on the LiveKit project predates the outbound branch — separate approval.
4. **Webhook**: the LiveKit project webhook must point at
   `/api/livekit/webhook` (it already does for inbound/web-test recording).
   No change expected; verify, don't modify.

## Explicitly out of scope for provisioning

* No change to the inbound dispatch rules, `livekit-india-test` SIP
  destination, Laura dispatch, D-Link dial rules, Callab trunk, Grandstream,
  Pi default route, WireGuard config, or production firewall.
* No migration execution (0069/0070 apply is its own approved step — until
  then every admission returns `db_unavailable` and nothing can dial).
* No live calls: the first dial after provisioning is supervised test T1,
  one call per explicit authorization, to an LHDM-owned mobile.
