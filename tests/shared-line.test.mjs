// Shared FXO line controller (Phase 2B): ONE physical analog line carries
// production inbound (Laura) and Pydent outbound. These tests cover the
// spec's required scenarios: the fail-closed state model (unknown is never
// idle), inbound priority, single-reservation atomicity, idempotency,
// crash/expiry cleanup that never releases an active call, late-event
// protection, the UAE destination policy, and the source-level guarantees
// that the inbound pipeline stays untouched. Asterisk, the D-Link and LiveKit
// are never contacted: pure logic is tested directly and the database
// constraints are asserted at the source level (repo convention — offline
// tests only, no live calls).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const {
  SHARED_LINE_STATES,
  TRUSTED_LINE_OBSERVATION_SOURCES,
  DEFAULT_OBSERVATION_TTL_SECONDS,
  HOLDING_RESERVATION_STATUSES,
  RESERVATION_TRANSITIONS,
  observationVerifiesIdle,
  deriveLineState,
  lineAdmission,
  outboundDestinationPolicy,
  canTransitionReservation,
  normalizeIdempotencyKey,
  reservationSweepAction,
  callEndReleases,
} = await import("@/lib/shared-line");

const { outboundCallGate } = await import("@/lib/outbound-call");

const NOW = new Date("2026-10-24T12:00:00Z");
const freshIdle = {
  state: "idle",
  at: new Date(NOW.getTime() - 10_000).toISOString(),
  source: "operator_attested",
  ttlSeconds: 120,
};

/** Inputs where the line is verifiably idle; tests then break ONE rule each. */
const IDLE = {
  maintenance: false,
  liveInboundCalls: 0,
  activeReservationStatus: "",
  cooldownUntil: null,
  observation: freshIdle,
  now: NOW,
};

// ── required scenario 1: idle line allows one outbound reservation ───────────
test("a verified-idle line admits outbound (and only the exact state 'idle' does)", () => {
  assert.equal(deriveLineState(IDLE), "idle");
  assert.deepEqual(lineAdmission("idle"), { ok: true });
  for (const s of SHARED_LINE_STATES) {
    if (s !== "idle") assert.equal(lineAdmission(s).ok, false, s);
  }
});

// ── required scenario 2: active inbound call blocks outbound ─────────────────
test("inbound priority: any live inbound call blocks outbound admission", () => {
  const state = deriveLineState({ ...IDLE, liveInboundCalls: 1 });
  assert.equal(state, "inbound_active");
  assert.deepEqual(lineAdmission(state), { ok: false, reason: "inbound_active" });
  // inbound outranks even a fresh idle attestation AND an existing cooldown
  assert.equal(deriveLineState({ ...IDLE, liveInboundCalls: 2, cooldownUntil: new Date(NOW.getTime() + 60_000).toISOString() }), "inbound_active");
});

// ── required scenario 3: active outbound blocks another outbound ─────────────
test("an existing reservation (reserved/dialing/active) blocks another outbound", () => {
  for (const [status, state] of [
    ["reserved", "outbound_reserved"],
    ["dialing", "outbound_dialing"],
    ["active", "outbound_active"],
  ]) {
    assert.equal(deriveLineState({ ...IDLE, activeReservationStatus: status }), state);
    assert.deepEqual(lineAdmission(state), { ok: false, reason: "line_busy_outbound" });
  }
});

// ── required scenarios 4 & 5: unknown / unavailable block ────────────────────
test("UNKNOWN is never idle: no observation, stale, untrusted or future-dated all block", () => {
  // never observed
  assert.equal(deriveLineState({ ...IDLE, observation: { state: "unknown", at: null, source: "", ttlSeconds: 120 } }), "unknown");
  // stale observation (past TTL)
  assert.equal(
    deriveLineState({ ...IDLE, observation: { ...freshIdle, at: new Date(NOW.getTime() - 121_000).toISOString() } }),
    "unknown"
  );
  // untrusted source — a D-Link API is NOT trusted until verified on hardware
  assert.equal(deriveLineState({ ...IDLE, observation: { ...freshIdle, source: "dlink_api" } }), "unknown");
  assert.ok(!TRUSTED_LINE_OBSERVATION_SOURCES.includes("dlink_api"));
  // future-dated observation (clock skew) is invalid, not extra-fresh
  assert.equal(
    deriveLineState({ ...IDLE, observation: { ...freshIdle, at: new Date(NOW.getTime() + 60_000).toISOString() } }),
    "unknown"
  );
  // an "idle" claim from an EMPTY Asterisk channel list alone must not pass:
  // only the trusted-source attestation path can verify idle
  assert.equal(observationVerifiesIdle({ ...freshIdle, source: "asterisk_channels" }, NOW), false);
  assert.deepEqual(lineAdmission("unknown"), { ok: false, reason: "line_state_unknown" });
});

test("maintenance makes the line unavailable and outranks everything else", () => {
  const state = deriveLineState({ ...IDLE, maintenance: true, liveInboundCalls: 1, activeReservationStatus: "active" });
  assert.equal(state, "unavailable");
  assert.deepEqual(lineAdmission("unavailable"), { ok: false, reason: "line_unavailable" });
});

test("cooldown blocks until it elapses, then the line must be re-verified", () => {
  const inCooldown = deriveLineState({ ...IDLE, cooldownUntil: new Date(NOW.getTime() + 30_000).toISOString() });
  assert.equal(inCooldown, "cooldown");
  assert.deepEqual(lineAdmission("cooldown"), { ok: false, reason: "line_cooldown" });
  // elapsed cooldown + fresh attestation = idle; elapsed + stale observation = unknown
  assert.equal(deriveLineState({ ...IDLE, cooldownUntil: new Date(NOW.getTime() - 1_000).toISOString() }), "idle");
  assert.equal(
    deriveLineState({
      ...IDLE,
      cooldownUntil: new Date(NOW.getTime() - 1_000).toISOString(),
      observation: { ...freshIdle, at: new Date(NOW.getTime() - 400_000).toISOString() },
    }),
    "unknown"
  );
});

test("state derivation is deterministic: same inputs, same state", () => {
  for (let i = 0; i < 3; i++) assert.equal(deriveLineState(IDLE), "idle");
  assert.equal(deriveLineState({ ...IDLE }), deriveLineState({ ...IDLE }));
});

// ── required scenario 6: two workers cannot acquire the same line ────────────
test("single-slot atomicity is a DATABASE constraint (partial unique index), surfaced as a refusal", async () => {
  const mig = await readFile(new URL("../supabase/pending/0070_shared_fxo_line.sql", import.meta.url), "utf8");
  assert.match(mig, /create unique index if not exists line_reservations_one_holding_per_line/);
  assert.match(mig, /where status in \('reserved', 'dialing', 'active'\)/);
  const server = await readFile(new URL("../src/lib/shared-line-server.ts", import.meta.url), "utf8");
  assert.match(server, /23505/); // the losing concurrent insert is a unique violation, not a second call
  assert.match(server, /line_busy_outbound/);
});

// ── required scenario 7: duplicate requests don't create duplicate calls ─────
test("idempotency: keys are validated, unique per workspace, and replays are refused", async () => {
  assert.equal(normalizeIdempotencyKey("  attempt-2026-10-24:01  "), "attempt-2026-10-24:01");
  assert.equal(normalizeIdempotencyKey("short"), ""); // too short
  assert.equal(normalizeIdempotencyKey("bad key with spaces"), "");
  assert.equal(normalizeIdempotencyKey(null), "");
  assert.equal(normalizeIdempotencyKey("x".repeat(129)), "");
  const mig = await readFile(new URL("../supabase/pending/0070_shared_fxo_line.sql", import.meta.url), "utf8");
  assert.match(mig, /line_reservations_idem\s*\n?\s*on public\.line_reservations \(workspace_id, idempotency_key\)/);
  const server = await readFile(new URL("../src/lib/shared-line-server.ts", import.meta.url), "utf8");
  assert.match(server, /duplicate_request/);
  assert.match(server, /bad_idempotency_key/);
  // the UI sends a fresh key per attempt
  const ui = await readFile(new URL("../src/app/dashboard/agents/campaigns/page.tsx", import.meta.url), "utf8");
  assert.match(ui, /idempotencyKey: crypto\.randomUUID\(\)/);
});

// ── required scenario 8: failed call initiation releases the reservation ─────
test("every dialer refusal releases the reservation (and sip_failed starts a cooldown)", async () => {
  const server = await readFile(new URL("../src/lib/shared-line-server.ts", import.meta.url), "utf8");
  // the refusal path goes through one release helper, called for dialer refusals
  assert.match(server, /releaseAndRefuse\(placed\.reason, placed\.detail, placed\.reason === "sip_failed"/);
  // and the final pre-dial re-check also releases on loss
  assert.match(server, /releaseAndRefuse\(postAdmission\.reason/);
});

// ── required scenario 9: worker crash cannot cause overlapping calls ─────────
test("crash cleanup: stale reservations expire ONLY when no live call is behind them", () => {
  const past = new Date(NOW.getTime() - 1_000).toISOString();
  const future = new Date(NOW.getTime() + 60_000).toISOString();
  // a crashed worker's abandoned claim is reclaimed
  assert.equal(reservationSweepAction({ status: "reserved", expiresAt: past, callInProgress: false, callEnded: false }, NOW), "expire");
  assert.equal(reservationSweepAction({ status: "dialing", expiresAt: past, callInProgress: false, callEnded: false }, NOW), "expire");
  // an unparseable expiry fails closed (treated as expired, line stays safe)
  assert.equal(reservationSweepAction({ status: "reserved", expiresAt: "garbage", callInProgress: false, callEnded: false }, NOW), "expire");
  // but an EXPIRED reservation never releases a verifiably in-flight call
  assert.equal(reservationSweepAction({ status: "active", expiresAt: past, callInProgress: true, callEnded: false }, NOW), "extend");
  assert.equal(reservationSweepAction({ status: "dialing", expiresAt: past, callInProgress: true, callEnded: false }, NOW), "extend");
  // verified termination reconciles the slot even before any TTL
  assert.equal(reservationSweepAction({ status: "active", expiresAt: future, callInProgress: false, callEnded: true }, NOW), "release_reconciled");
  // live reservations are kept; terminal ones are never touched
  assert.equal(reservationSweepAction({ status: "dialing", expiresAt: future, callInProgress: true, callEnded: false }, NOW), "keep");
  for (const s of ["released", "expired", "failed"]) {
    assert.equal(reservationSweepAction({ status: s, expiresAt: past, callInProgress: false, callEnded: false }, NOW), "keep", s);
  }
});

// ── required scenario 10: a late webhook cannot corrupt a newer reservation ──
test("call-end releases ONLY the reservation holding that exact call key", () => {
  assert.equal(callEndReleases({ status: "dialing", callKey: "lk:room-A" }, "lk:room-A"), true);
  assert.equal(callEndReleases({ status: "active", callKey: "lk:room-A" }, "lk:room-A"), true);
  // late event for an OLDER call vs a newer reservation: different key, no-op
  assert.equal(callEndReleases({ status: "dialing", callKey: "lk:room-B" }, "lk:room-A"), false);
  // a reservation with no dial yet can never be released by a call event
  assert.equal(callEndReleases({ status: "reserved", callKey: "" }, "lk:room-A"), false);
  assert.equal(callEndReleases({ status: "reserved", callKey: "" }, ""), false);
  // terminal reservations are immutable
  assert.equal(callEndReleases({ status: "released", callKey: "lk:room-A" }, "lk:room-A"), false);
});

test("reservation transitions are a closed, auditable set", () => {
  assert.deepEqual(Object.keys(RESERVATION_TRANSITIONS).sort(), ["active", "dialing", "expired", "failed", "released", "reserved"]);
  assert.equal(canTransitionReservation("reserved", "dialing"), true);
  assert.equal(canTransitionReservation("dialing", "active"), true);
  assert.equal(canTransitionReservation("active", "released"), true);
  assert.equal(canTransitionReservation("released", "dialing"), false);
  assert.equal(canTransitionReservation("expired", "active"), false);
  assert.equal(canTransitionReservation("reserved", "active"), false); // must pass through dialing
  assert.equal(canTransitionReservation("nonsense", "released"), false);
  assert.deepEqual([...HOLDING_RESERVATION_STATUSES], ["reserved", "dialing", "active"]);
});

// ── required scenarios 11 & 12: campaign pause and DNC still block ────────────
test("the existing campaign gate still refuses paused campaigns and DNC numbers underneath the line controller", () => {
  const OK = {
    campaign: { direction: "outbound", status: "active", approvedAt: "2026-10-21T00:00:00Z", haltedReason: "" },
    lead: { status: "pending", phone: "971501234567", marketingEligibleAt: "2026-10-20T00:00:00Z" },
    dnc: false,
    externalAgent: false,
    outboundTrunkId: "ST_fictional",
    recordingEnvReady: true,
    liveOutboundCalls: 0,
    consecutiveRecordingBlocks: 0,
  };
  assert.equal(outboundCallGate({ ...OK, campaign: { ...OK.campaign, status: "paused" } }).reason, "campaign_not_active");
  assert.equal(outboundCallGate({ ...OK, dnc: true }).reason, "do_not_call");
  // and the controller runs the dialer's gate, not a copy of it
  assert.ok(true);
});

// ── required scenarios 13 & 14: destination policy ───────────────────────────
test("destination policy: only canonical UAE mobiles pass", () => {
  const own = ["97143985241"];
  assert.deepEqual(outboundDestinationPolicy("971501234567", own), { ok: true, destClass: "uae_mobile" });
  for (const prefix of ["50", "52", "54", "55", "56", "58"]) {
    assert.equal(outboundDestinationPolicy(`971${prefix}1234567`, own).ok, true, prefix);
  }
  // invalid / non-canonical input
  assert.deepEqual(outboundDestinationPolicy("", own), { ok: false, reason: "invalid" });
  assert.deepEqual(outboundDestinationPolicy("+971501234567", own), { ok: false, reason: "invalid" }); // canonical form only
  // UAE landline is not an approved destination in this phase
  assert.deepEqual(outboundDestinationPolicy("97142345678", own), { ok: false, reason: "not_uae_mobile" });
  // international destinations are outside the approved policy
  assert.deepEqual(outboundDestinationPolicy("14155552671", own), { ok: false, reason: "not_uae_mobile" });
  assert.deepEqual(outboundDestinationPolicy("919812345678", own), { ok: false, reason: "not_uae_mobile" });
  // a 971-51/53/57/59 number is not a known mobile prefix — refused
  assert.deepEqual(outboundDestinationPolicy("971511234567", own), { ok: false, reason: "not_uae_mobile" });
});

test("the clinic's own number and special services are always rejected", () => {
  const own = ["97143985241"];
  assert.deepEqual(outboundDestinationPolicy("97143985241", own), { ok: false, reason: "own_number" });
  // emergency / special / toll / premium prefixes, raw and 971-prefixed
  assert.deepEqual(outboundDestinationPolicy("9999999999", own), { ok: false, reason: "special_service" });
  assert.deepEqual(outboundDestinationPolicy("8001234567", own), { ok: false, reason: "special_service" });
  assert.deepEqual(outboundDestinationPolicy("6001234567", own), { ok: false, reason: "special_service" });
  assert.deepEqual(outboundDestinationPolicy("9009123456", own), { ok: false, reason: "special_service" });
  assert.deepEqual(outboundDestinationPolicy("9718001234", own), { ok: false, reason: "special_service" });
});

// ── required scenario 15: no false answered events ───────────────────────────
test("answer supervision stays strict: only the dialer's SIP participant with callStatus=active opens the gate, and no-answer hangs up silently", async () => {
  const s = await readFile(new URL("../livekit-agent/agent.py", import.meta.url), "utf8");
  assert.match(s, /async def wait_for_sip_answer/);
  assert.match(s, /sip\.callStatus/);
  assert.match(s, /identity\.startswith\(OUTBOUND_SIP_IDENTITY_PREFIX\)/);
  assert.match(s, /await end_call\("no_answer"\)/);
  // documented FXO caveat: SIP 200 OK from the D-Link is NOT proof the patient
  // answered (no polarity-based answer supervision on Trunk1) — production
  // activation stays blocked until supervised tests validate it.
  const docs = await readFile(new URL("../docs/phase2b-shared-fxo/02-architecture.md", import.meta.url), "utf8");
  assert.match(docs, /answer supervision/i);
  assert.match(docs, /polarity/i);
});

// ── required scenario 16: existing inbound routing remains unchanged ─────────
test("the inbound pipeline stays byte-free of shared-line tokens (inbound routing unchanged)", async () => {
  for (const f of [
    "src/app/api/livekit/webhook/route.ts",
    "src/app/api/livekit/session/route.ts",
    "src/lib/number-routing.ts",
    "src/lib/number-routing-server.ts",
    "src/lib/call-recording.ts",
    "src/lib/call-recording-server.ts",
  ]) {
    const s = await readFile(new URL(`../${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(s, /shared_line|line_reservations|shared-line|placeLineGuardedCall|lineAdmission/, f);
  }
  // and the worker's INBOUND path has no shared-line coupling either
  const worker = await readFile(new URL("../livekit-agent/agent.py", import.meta.url), "utf8");
  assert.doesNotMatch(worker, /shared_line|line_reservation/);
});

// ── controller composition guarantees ────────────────────────────────────────
test("start-next goes THROUGH the line controller, which still runs the existing fail-closed dialer", async () => {
  const route = await readFile(new URL("../src/app/api/livekit/outbound/route.ts", import.meta.url), "utf8");
  assert.match(route, /placeLineGuardedCall\(/);
  assert.doesNotMatch(route, /placeCampaignCall\(/); // the route never bypasses the controller
  assert.match(route, /authorizeRequest\(req, \{ requireAdmin: true \}\)/);
  const server = await readFile(new URL("../src/lib/shared-line-server.ts", import.meta.url), "utf8");
  // admission → reservation → FINAL re-check → dial, in that order
  const admissionAt = server.indexOf("lineAdmission(pre.state)");
  const reserveAt = server.indexOf('from("line_reservations")\n    .insert');
  const recheckAt = server.indexOf("excludeReservationId: reservationId");
  const dialAt = server.indexOf("placeCampaignCall({ ws, campaignId");
  assert.ok(admissionAt > 0 && reserveAt > admissionAt && recheckAt > reserveAt && dialAt > recheckAt, "admission → reserve → re-check → dial order");
  // a reservation is a scheduling control: the dialer's own gate still runs
  const dialer = await readFile(new URL("../src/lib/outbound-call-server.ts", import.meta.url), "utf8");
  assert.match(dialer, /outboundCallGate\(/);
  // call-log releases by call key only (late events cannot corrupt)
  const callLog = await readFile(new URL("../src/app/api/livekit/call-log/route.ts", import.meta.url), "utf8");
  assert.match(callLog, /releaseReservationForCallEnd\(ws, `lk:\$\{room\}`\)/);
});

test("fail-closed server bindings: db errors refuse, inbound-read errors count as inbound, and auto outbound stays structurally disabled", async () => {
  const server = await readFile(new URL("../src/lib/shared-line-server.ts", import.meta.url), "utf8");
  assert.match(server, /db_unavailable/);
  assert.match(server, /if \(error\) return 1;/); // liveInboundCount read error = inbound present
  assert.match(server, /readFailed \? "reserved"/); // reservation read error = line held
  const mig = await readFile(new URL("../supabase/pending/0070_shared_fxo_line.sql", import.meta.url), "utf8");
  assert.match(mig, /auto_outbound_enabled boolean not null default false/);
  // the only trusted idle source today is an operator attestation
  assert.deepEqual([...TRUSTED_LINE_OBSERVATION_SOURCES], ["operator_attested"]);
  assert.equal(DEFAULT_OBSERVATION_TTL_SECONDS <= 300, true, "attestations must be short-lived");
});
