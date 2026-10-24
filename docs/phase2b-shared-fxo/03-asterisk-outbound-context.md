# Phase 2B shared FXO line — F. restricted Asterisk outbound context (PROPOSAL)

**Status: PROPOSAL ONLY — reviewable artifact. Nothing in this document has
been applied. No Asterisk reload/restart, no Pi change, no D-Link change is
authorized by this document.** Per the mandatory restrictions, no production
activation command is provided here: endpoint identification, network
restrictions and authentication must be verified first (see "Prerequisites"),
each under its own approval.

## Why a new context

The existing `[from-phoenix]` (`_X.` → `Dial(PJSIP/9${EXTEN}@dlink-pbx,60)`,
trusted-IP 10.77.0.1/32, no auth) is a **broad dialer**: any digits presented
become a carrier dial. It must not be exposed to LiveKit (explicit
restriction), and a public `_X.` rule is an invitation for toll fraud. The
proposed `[from-pydent-outbound]` accepts **only** the exact destination
class Pydent is approved to call, re-validating at the telephony boundary —
a number is never trusted merely because Pydent validated it.

## What the context enforces

1. Only canonical `+9715[0/2/4/5/6/8]XXXXXXX` (UAE mobiles, E.164 with `+`)
   is accepted — the exact format the Pydent dialer sends. Everything else
   (landlines, international, emergency/special like 999/112/800/600/900,
   short strings, the clinic's own numbers 043985241/+97143985241) falls
   through to an explicit rejection with a distinct cause.
2. Normalization: `+9715XXXXXXXX → 05XXXXXXXX` local form, then the existing
   D-Link "All Dial" rule (`9XX.`, strip 1) receives `905XXXXXXXX` and
   out-pulses `05XXXXXXXX` on Trunk1/FXO 1. No other D-Link change needed.
3. **One outbound channel** (`GROUP_COUNT` on a dedicated group) — second
   simultaneous call is refused in-dialplan even if the application layer
   failed; the D-Link "Maximum channels: 2" on the rasberryPI5 trunk stays
   as-is so inbound is never starved by a misconfigured limit.
4. **Absolute max call duration** 15 minutes (`L(900000:60000)`), warning at
   14 min.
5. No forwarding loops: only the matched mobile patterns dial out; calls to
   the clinic's own DID/line are rejected before any Dial; the context
   contains **no includes, no `_X.` catch-all, no DISA, no Goto on
   caller-supplied data** — the only caller-controlled input is the INVITE
   user part, strictly pattern-matched.
6. Distinct failure causes so the SIP leg (and therefore Pydent's call
   lifecycle) sees machine-readable reasons:
   * 403-class rejection (cause 21 CALL_REJECTED) for policy-refused
     destinations, with a NoOp naming the rule that fired;
   * 486/600-class (cause 17 USER_BUSY / 34 CONGESTION) for the single-channel
     limit;
   * carrier busy/no-answer propagate from the D-Link leg unchanged.

## Proposed configuration (REVIEW ARTIFACT — do not load)

```asterisk
; ── pjsip.conf additions (PROPOSED, not applied) ─────────────────────────────
; Dedicated endpoint for Pydent/LiveKit OUTBOUND SIP INVITEs. Deliberately NOT
; livekit-india-test (that identity stays inbound-to-LiveKit only) and NOT
; phoenix-azure. Digest auth is REQUIRED (LiveKit outbound trunks support an
; auth username/password), and the endpoint must ALSO be network-restricted
; once the LiveKit→Pi path is established and its source addresses verified.
[pydent-livekit-out]
type = endpoint
transport = <VERIFIED TRANSPORT — see prerequisite P-2>
context = from-pydent-outbound
disallow = all
allow = ulaw,alaw
auth = pydent-livekit-out-auth
aors = pydent-livekit-out
; one call at a time at the endpoint too (defense in depth)
device_state_busy_at = 1

[pydent-livekit-out-auth]
type = auth
auth_type = userpass
username = <SET AT PROVISIONING — never committed>
password = <SET AT PROVISIONING — never committed>

[pydent-livekit-out]
type = aor
; LiveKit does not register; INVITEs arrive directly. qualify stays off.
max_contacts = 1

; identify section intentionally OMITTED until the LiveKit→Pi network path
; and source addresses are verified (prerequisite P-2). Without it, INVITEs
; still must pass digest auth; with it, they must also come from the verified
; network. Both are required before activation.

; ── extensions.conf additions (PROPOSED, not applied) ────────────────────────
[from-pydent-outbound]
; Single shared FXO line: at most ONE outbound channel, ever.
exten => _+9715X.,1,NoOp(pydent-out request ${EXTEN})
 same => n,Set(GROUP()=pydent_fxo_out)
 same => n,GotoIf($[${GROUP_COUNT(pydent_fxo_out)} > 1]?busyout)
 same => n,Gosub(pydent-out-screen,s,1(${EXTEN}))
 ; normalize +9715XXXXXXXX -> 05XXXXXXXX; D-Link All Dial (9XX., strip 1)
 ; receives 905XXXXXXXX and out-pulses 05XXXXXXXX on Trunk1 / FXO 1.
 same => n,Set(CDR(pydent_out)=${UNIQUEID})
 same => n,Dial(PJSIP/90${EXTEN:4}@dlink-pbx,60,L(900000:60000))
 same => n,Hangup()
 same => n(busyout),NoOp(pydent-out REFUSED: single-channel limit)
 same => n,Hangup(17)

; everything that is not an approved UAE mobile is rejected with cause 21
exten => _[+0-9].,1,NoOp(pydent-out REFUSED: destination policy ${EXTEN})
 same => n,Hangup(21)
exten => _[a-zA-Z].,1,Hangup(21)   ; alphanumeric user parts never dial

[pydent-out-screen]
; policy re-validation at the telephony boundary (never trust the app alone)
exten => s,1,Set(DEST=${ARG1})
 ; clinic's own line / DID — never dialable (loop guard)
 same => n,GotoIf($["${DEST}" = "+97143985241"]?reject)
 same => n,GotoIf($["${DEST:1}" = "043985241"]?reject)
 ; exact UAE mobile shape only: +9715[024568] + 7 digits (13 chars with +)
 same => n,GotoIf($[${LEN(${DEST})} != 13]?reject)
 same => n,GotoIf($[$[${REGEX("^\+9715[024568][0-9]{7}$" ${DEST})}] = 0]?reject)
 same => n,Return()
 same => n(reject),NoOp(pydent-out REFUSED: screen ${DEST})
 same => n,Hangup(21)
```

Notes for review:

* `_+9715X.` narrows at match time; `pydent-out-screen` then enforces exact
  length and the full regex, so partial matches cannot leak through.
* The reject patterns catch every other user part — including `9XX.`-style
  strings, `00…` international, `999`/`112`, and named extensions — with
  cause 21 before any Dial. There is no path to `[from-phoenix]`, no
  `include =>`, and no feature-code/DISA surface.
* `GROUP_COUNT` is per-Asterisk-instance and atomic within the dialplan: even
  if the application's reservation failed entirely, a second simultaneous
  outbound call is refused at the Pi.
* The existing `[from-dlink]` inbound context, `[from-phoenix]`,
  `phoenix-azure`, `livekit-india-test`, the Callab trunk, the D-Link dial
  rules and DialPlan1 are all **untouched**.

## LiveKit INVITE authentication & identification (investigated, unverified)

* LiveKit Cloud outbound SIP trunks send INVITEs **from LiveKit's
  infrastructure** with configurable digest credentials (`auth_username` /
  `auth_password` on the outbound trunk). That gives us per-trunk digest auth
  — the minimum bar. Each call's INVITE carries the trunk's configured
  identity; per-call attribution is by dialed number + time window +
  `X-LK` headers where available (to be confirmed on the wire during T2 —
  **do not assume**).
* The existing `livekit-india-test` endpoint is **not** an authenticated
  inbound trunk (TCP transport, context `from-livekit` which does not exist).
  It is not reused for outbound and must not be: the proposal above is a
  separate, authenticated endpoint.
* **Network path (open prerequisite P-2):** the Pi has no verified inbound
  path from LiveKit India (NAT; current LiveKit traffic is Pi→LiveKit).
  Options to evaluate at provisioning: WireGuard-style tunnel termination
  (like phoenix-azure's 10.77.0.1 — but a NEW peer, existing WireGuard config
  must not be modified), or a restricted public SIP exposure pinned to
  LiveKit's published SIP source ranges. Until the path is chosen and
  verified, there is nothing to safely activate — which is why no activation
  command appears in this document.

## Prerequisites before any activation approval (each separately approved)

* P-1: T0 runbook outputs (live Pi/D-Link capture) confirm the dialplan
  assumptions (`[from-phoenix]` shape, D-Link All Dial behaviour, Trunk1
  port mapping).
* P-2: LiveKit→Pi network path chosen, built and verified; endpoint
  `identify` section added with the verified source addresses.
* P-3: digest credentials provisioned out-of-band (never committed).
* P-4: supervised tests T1–T4 (one call per authorization) pass, including
  answer-supervision characterization (02-architecture §C.1).
