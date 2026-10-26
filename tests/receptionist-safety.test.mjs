// Inbound receptionist safety (Phase 3) + legacy dial-path hardening (T1
// findings F-1/F-2/F-3): patient identity pinning, booking idempotency, the
// no-longer-unauthenticated legacy Vapi route, workflow DNC enforcement, and
// the dialer's fail-closed DNC read. Offline only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

// ── patient identity verification (worker tool layer) ─────────────────────────
test("identity pin: record lookups and appointment changes run against the VERIFIED caller number", async () => {
  const s = await read("livekit-agent/agent.py");
  assert.match(s, /def verified_phone/);
  // a model-supplied different number never widens access
  assert.match(s, /if captured and supplied and supplied != captured:/);
  assert.match(s, /return captured/);
  // all four sensitive tools go through the pin
  for (const tool of ["reschedule_appointment", "cancel_appointment", "lookup_patient", "list_upcoming_appointments"]) {
    const at = s.indexOf(`async def ${tool}`);
    assert.ok(at > 0, tool);
    const body = s.slice(at, at + 400);
    assert.match(body, /verified_phone\(phone\)/, `${tool} uses the identity pin`);
  }
  // booking new appointments is allowed for any provided number (creation,
  // not disclosure) — but never invents one
  assert.match(s, /phone = phone\.strip\(\) or caller_number\(\)\n            return await run_tool\(\n                agent_id,\n                "book_appointment"/);
});

test("the compiled prompt carries the identity & privacy rule when sensitive tools are enabled", async () => {
  const s = await read("src/lib/livekit.ts");
  assert.match(s, /IDENTITY & PRIVACY: personal details and appointment changes belong to the VERIFIED caller only/);
  assert.match(s, /tools\.lookup_patient \|\| tools\.reschedule_appointment \|\| tools\.cancel_appointment/);
});

// ── booking idempotency (existing guard, held in place) ───────────────────────
test("booking refuses an exact duplicate (same patient, same time) instead of double-booking", async () => {
  const s = await read("src/lib/booking-server.ts");
  assert.match(s, /duplicate_booking/);
  assert.match(s, /already has an appointment at that exact time/);
});

// ── T1 F-1: the legacy Vapi dialer is no longer an open relay ─────────────────
test("the legacy /api/vapi/outbound route is admin-authenticated and DNC-checked", async () => {
  const s = await read("src/app/api/vapi/outbound/route.ts");
  assert.match(s, /authorizeRequest\(req, \{ requireAdmin: true \}\)/);
  // auth comes BEFORE any Vapi work
  assert.ok(s.indexOf("authorizeRequest") < s.indexOf("VAPI_BASE}/phone-number"), "auth before Vapi lookups");
  assert.match(s, /from\("voice_dnc"\)/);
  assert.match(s, /canonicalPhone/);
  // an unreadable DNC registry refuses the whole batch (fail closed)
  assert.match(s, /if \(dncErr\) return/);
  assert.match(s, /fail closed/i);
});

// ── T1 F-2: workflow "call" steps check DNC ───────────────────────────────────
test("workflow call steps refuse DNC-listed and undialable numbers (fail closed on read errors)", async () => {
  const s = await read("src/lib/workflow-runner.ts");
  assert.match(s, /voice_dnc/);
  assert.match(s, /canonicalPhone\(run\.contact_phone\)/);
  assert.match(s, /do-not-call registry unreadable — call refused \(fail closed\)/);
  assert.match(s, /number is on the do-not-call list — call refused/);
  const dncAt = s.indexOf('from("voice_dnc")');
  const dialAt = s.indexOf("placeOutboundCall({");
  assert.ok(dncAt > 0 && dialAt > dncAt, "DNC check before the dial");
});

// ── T1 F-3: the campaign dialer's DNC read fails CLOSED ───────────────────────
test("an unreadable do-not-call registry refuses the campaign dial (never reads as 'not listed')", async () => {
  const s = await read("src/lib/outbound-call-server.ts");
  assert.match(s, /if \(dncRes\.error\) return \{ ok: false, reason: "db_unavailable"/);
  assert.match(s, /do-not-call registry unreadable \(fail closed\)/);
  // concurrency-count read errors block rather than pass
  assert.match(s, /liveRes\.error \? 1 :/);
  assert.match(s, /callingRes\.error \? 1 :/);
  // an unreadable halt history blocks the gate but never WRITES a halt
  assert.match(s, /if \(!readable \|\| streak < RECORDING_HALT_THRESHOLD\) return false/);
  assert.match(s, /streakNow\.readable \? streakNow\.streak : RECORDING_HALT_THRESHOLD/);
});

// ── shared-line fixes from T1 (F-4 / F-5) ─────────────────────────────────────
test("admission always reads a FRESH line row, and an idle attestation is consumed by its reservation", async () => {
  const s = await read("src/lib/shared-line-server.ts");
  assert.match(s, /async function freshLine/);
  // fresh read after the sweep, before admission; and again at the final check
  const sweepAt = s.indexOf("await sweepReservation(ws, line)");
  const fresh1 = s.indexOf("const lineNow = await freshLine(line.id)", sweepAt);
  const admissionAt = s.indexOf("lineAdmission(pre.state)", fresh1);
  const fresh2 = s.indexOf("const lineAtDial = await freshLine(line.id)", admissionAt);
  assert.ok(sweepAt > 0 && fresh1 > sweepAt && admissionAt > fresh1 && fresh2 > admissionAt, "sweep → fresh read → admission → fresh read at dial");
  // one attestation = one dial attempt
  assert.match(s, /consumed by reservation/);
  assert.match(s, /idle attestation consumed \(one attestation = one dial attempt\)/);
  // a failed consume refuses (fail closed) and releases the reservation
  assert.match(s, /could not consume the line attestation \(fail closed\)/);
  // own-number list read failures refuse
  assert.match(s, /voice_numbers unreadable \(fail closed\)/);
});

test("service-relationship calls have their own documented consent basis (reminders are not 'marketing opt-ins')", async () => {
  const { MARKETING_CONSENT_BASES, marketingEligibilitySource } = await import("@/lib/outbound-call");
  assert.ok(MARKETING_CONSENT_BASES.includes("service_relationship"));
  const r = marketingEligibilitySource({ basis: "service_relationship", detail: "reminder for their own 2026-11-02 cleaning appointment" });
  assert.equal(r.ok, true);
});
