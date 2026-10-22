// LiveKit outbound campaign calls (Phase 2A): the fail-closed pre-dial gate
// (verified marketing eligibility, do-not-call, explicit campaign approval,
// recording-required), the P2 halt streak, opening-consent recording and its
// permanent opt-out effect, capture verification thresholds, and the
// source-level guarantees that the new dialer lives in NEW files only (the
// inbound recording pipeline and the routing/management files are untouched).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const {
  RECORDING_HALT_THRESHOLD,
  RECORDING_BLOCK_DETAIL,
  MIN_CAPTURED_RECORDING_BYTES,
  MARKETING_CONSENT_BASES,
  outboundCallGate,
  leadBlockDetailFor,
  consecutiveRecordingBlocks,
  normalizeOpeningConsent,
  leadPatchForCallEnd,
  capturedRecordingOk,
  outboundDispatchExtra,
  canonicalPhone,
  dialStringFor,
  marketingEligibilitySource,
} = await import("@/lib/outbound-call");

// A gate input that passes every check; tests then break ONE rule at a time.
const OK = {
  campaign: { direction: "outbound", status: "active", approvedAt: "2026-10-21T00:00:00Z", haltedReason: "" },
  lead: { status: "pending", phone: "9715xxxxxxx", marketingEligibleAt: "2026-10-20T00:00:00Z" },
  dnc: false,
  externalAgent: false,
  outboundTrunkId: "ST_fictional",
  recordingEnvReady: true,
  liveOutboundCalls: 0,
  consecutiveRecordingBlocks: 0,
};

// ── the fail-closed gate ──────────────────────────────────────────────────────
test("a fully-verified lead on an approved, active campaign passes", () => {
  assert.deepEqual(outboundCallGate(OK), { ok: true });
});

test("no verified marketing eligibility => NO CALL (the core fail-closed rule)", () => {
  assert.deepEqual(outboundCallGate({ ...OK, lead: { ...OK.lead, marketingEligibleAt: null } }), { ok: false, reason: "not_marketing_eligible" });
  assert.deepEqual(outboundCallGate({ ...OK, lead: { ...OK.lead, marketingEligibleAt: "" } }), { ok: false, reason: "not_marketing_eligible" });
});

test("do-not-call always wins over eligibility", () => {
  assert.deepEqual(outboundCallGate({ ...OK, dnc: true }), { ok: false, reason: "do_not_call" });
});

test("recording unavailable => the call is refused, never placed unrecorded", () => {
  assert.deepEqual(outboundCallGate({ ...OK, recordingEnvReady: false }), { ok: false, reason: "recording_unavailable" });
});

test("campaign gates: direction, active, explicit approval, halt", () => {
  assert.equal(outboundCallGate({ ...OK, campaign: { ...OK.campaign, direction: "inbound" } }).reason, "campaign_not_outbound");
  assert.equal(outboundCallGate({ ...OK, campaign: { ...OK.campaign, status: "paused" } }).reason, "campaign_not_active");
  assert.equal(outboundCallGate({ ...OK, campaign: { ...OK.campaign, approvedAt: null } }).reason, "campaign_not_approved");
  assert.equal(outboundCallGate({ ...OK, campaign: { ...OK.campaign, haltedReason: "recording" } }).reason, "campaign_halted");
  assert.equal(outboundCallGate({ ...OK, consecutiveRecordingBlocks: RECORDING_HALT_THRESHOLD }).reason, "campaign_halted");
});

test("single-call concurrency, trunk requirement, worker-agent requirement", () => {
  assert.equal(outboundCallGate({ ...OK, liveOutboundCalls: 1 }).reason, "another_call_live");
  assert.equal(outboundCallGate({ ...OK, outboundTrunkId: " " }).reason, "no_outbound_trunk");
  assert.equal(outboundCallGate({ ...OK, externalAgent: true }).reason, "external_agent");
  assert.equal(outboundCallGate({ ...OK, lead: { ...OK.lead, status: "done" } }).reason, "lead_not_pending");
});

test("lead-blocking refusals: eligibility, DNC and recording mark the lead; campaign-state refusals do not", () => {
  assert.equal(leadBlockDetailFor("not_marketing_eligible"), "not_marketing_eligible");
  assert.equal(leadBlockDetailFor("do_not_call"), "do_not_call");
  assert.equal(leadBlockDetailFor("recording_unavailable"), RECORDING_BLOCK_DETAIL);
  assert.equal(leadBlockDetailFor("campaign_not_approved"), null);
  assert.equal(leadBlockDetailFor("another_call_live"), null);
});

// ── P2 halt streak ────────────────────────────────────────────────────────────
test("halt streak counts trailing recording blocks only; any other outcome breaks it", () => {
  const rec = { status: "blocked", statusDetail: RECORDING_BLOCK_DETAIL };
  const recFail = { status: "failed", statusDetail: "recording_failed" };
  const done = { status: "done", statusDetail: "opening:accepted" };
  assert.equal(consecutiveRecordingBlocks([]), 0);
  assert.equal(consecutiveRecordingBlocks([rec, rec, recFail]), 3);
  assert.equal(consecutiveRecordingBlocks([rec, done, rec]), 1);
  assert.equal(consecutiveRecordingBlocks([done, rec, rec, rec]), 0);
  // never-attempted leads are skipped, not streak-breaking
  assert.equal(consecutiveRecordingBlocks([{ status: "pending", statusDetail: "" }, rec, rec]), 2);
  // a non-recording failure breaks the streak
  assert.equal(consecutiveRecordingBlocks([{ status: "failed", statusDetail: "sip_failed" }, rec]), 0);
});

// ── opening consent (tracked separately; opt-outs are permanent) ─────────────
test("opening consent normalization accepts only the defined values", () => {
  assert.equal(normalizeOpeningConsent("Accepted"), "accepted");
  assert.equal(normalizeOpeningConsent(" opt_out "), "opt_out");
  assert.equal(normalizeOpeningConsent("yes"), "");
  assert.equal(normalizeOpeningConsent(undefined), "");
  assert.equal(normalizeOpeningConsent({ evil: true }), "");
});

test("declined/opt_out at the opening => do-not-call; accepted does not", () => {
  assert.equal(leadPatchForCallEnd({ openingConsent: "declined" }).dnc, true);
  assert.equal(leadPatchForCallEnd({ openingConsent: "opt_out" }).dnc, true);
  assert.equal(leadPatchForCallEnd({ openingConsent: "accepted" }).dnc, false);
  assert.equal(leadPatchForCallEnd({ openingConsent: "" }).dnc, false);
});

test("call-end patch records the consent fact with a timestamp, and no_answer marks the lead failed", () => {
  const p = leadPatchForCallEnd({ openingConsent: "accepted", now: "2026-10-21T10:00:00Z" });
  assert.equal(p.status, "done");
  assert.equal(p.opening_consent, "accepted");
  assert.equal(p.opening_consent_at, "2026-10-21T10:00:00Z");
  const n = leadPatchForCallEnd({ openingConsent: "", endedReason: "no_answer" });
  assert.equal(n.status, "failed");
  assert.equal(n.status_detail, "no_answer");
  assert.equal(n.opening_consent, undefined);
});

// ── capture verification (actual audio, not just a started egress) ──────────
test("a captured recording needs real bytes; tiny/empty/absent blobs fail", () => {
  assert.equal(capturedRecordingOk(MIN_CAPTURED_RECORDING_BYTES), true);
  assert.equal(capturedRecordingOk(1024 * 1024), true);
  assert.equal(capturedRecordingOk(MIN_CAPTURED_RECORDING_BYTES - 1), false);
  assert.equal(capturedRecordingOk(0), false);
  assert.equal(capturedRecordingOk(null), false);
  assert.equal(capturedRecordingOk(undefined), false);
  assert.equal(capturedRecordingOk(NaN), false);
});

// ── dispatch metadata shape ───────────────────────────────────────────────────
test("outbound dispatch metadata carries campaign, lead and dialed number", () => {
  assert.deepEqual(outboundDispatchExtra("camp-1", "lead-1", "97150xxxxxxx"), {
    source: "campaign", campaignId: "camp-1", leadId: "lead-1", toPhone: "97150xxxxxxx", outbound: true,
  });
});

// ── S2: one canonical phone form everywhere ───────────────────────────────────
test("formatting variants of the same number collide into one canonical form", () => {
  const canonical = canonicalPhone("+971 50 123 4567");
  assert.equal(canonical, "971501234567");
  for (const variant of ["0501234567", "050 123 4567", "00971501234567", "971501234567", "+971-50-123-4567"]) {
    assert.equal(canonicalPhone(variant), canonical, variant);
  }
  assert.equal(dialStringFor(canonical), "+971501234567");
});

test("non-phones canonicalize to empty (undialable, fail closed)", () => {
  for (const bad of ["", "12345", "not a phone", null, undefined, "+"]) assert.equal(canonicalPhone(bad), "");
  assert.equal(dialStringFor(""), "");
  // and the gate refuses an empty canonical phone outright
  assert.deepEqual(outboundCallGate({ ...OK, lead: { ...OK.lead, phone: "" } }), { ok: false, reason: "invalid_phone" });
  assert.equal(leadBlockDetailFor("invalid_phone"), "invalid_phone");
});

// ── structured consent attestation (replaces the source-label blocklist) ─────
test("attestation requires a known basis and documented evidence detail", () => {
  assert.equal(marketingEligibilitySource({ basis: "", detail: "x" }).ok, false);
  assert.equal(marketingEligibilitySource({ basis: "patient_registration", detail: "signed 2026" }).ok, false); // unknown basis
  assert.equal(marketingEligibilitySource({ basis: "other", detail: "" }).ok, false); // no evidence
  assert.equal(marketingEligibilitySource({ basis: "other", detail: "    " }).ok, false);
});

test("a registration form WITH an explicit marketing clause is a valid, recorded basis", () => {
  const r = marketingEligibilitySource({
    basis: "registration_form_with_marketing_clause",
    detail: "2026 intake form §7 automated promotional calls, signed copies in patient files",
    evidenceRef: "forms/intake-2026",
  });
  assert.equal(r.ok, true);
  assert.match(r.source, /^registration_form_with_marketing_clause: 2026 intake form/);
  assert.match(r.source, /\[forms\/intake-2026\]$/);
  assert.ok(MARKETING_CONSENT_BASES.includes("registration_form_with_marketing_clause"));
});

// ── source-level guarantees ───────────────────────────────────────────────────
const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

test("the dialer lives in NEW files: inbound recording pipeline files are byte-free of outbound tokens", async () => {
  for (const f of ["src/lib/call-recording.ts", "src/lib/call-recording-server.ts", "src/app/api/livekit/session/route.ts", "src/app/api/livekit/webhook/route.ts"]) {
    const s = await read(f);
    assert.doesNotMatch(s, /createSipParticipant|outbound-call|campaign_leads|voice_dnc/, f);
  }
});

test("routing/management files stay free of dialer + egress tokens (their safety tests' invariant)", async () => {
  for (const f of ["src/lib/number-routing.ts", "src/lib/number-routing-server.ts", "src/lib/agent-management.ts", "src/lib/agent-management-server.ts"]) {
    const s = await read(f);
    assert.doesNotMatch(s, /createSipParticipant|startRoomCompositeEgress|placeCampaignCall/, f);
  }
});

test("the dialer dials ONLY after egress start (disclosure stays true by construction)", async () => {
  const s = await read("src/lib/outbound-call-server.ts");
  const egressAt = s.indexOf("startRoomCompositeEgress");
  const dialAt = s.indexOf("createSipParticipant");
  assert.ok(egressAt > 0 && dialAt > 0 && egressAt < dialAt, "egress must start before the SIP dial");
  // and the pre-dial gate runs before either
  assert.ok(s.indexOf("outboundCallGate") < egressAt, "gate before egress");
  // the attributed intent row is written before the room exists
  assert.ok(s.indexOf('from("voice_calls").insert') < s.indexOf("createRoom"), "intent row before room");
});

test("the outbound route is authenticated and admin-gated; no Vapi anywhere in the new path", async () => {
  const route = await read("src/app/api/livekit/outbound/route.ts");
  assert.match(route, /authorizeRequest\(req, \{ requireAdmin: true \}\)/);
  // No Vapi RUNTIME surface in the new path (the legacy vapi_call_id COLUMN
  // name is the shared LiveKit call key and is allowed; prose mentions too).
  for (const f of ["src/app/api/livekit/outbound/route.ts", "src/lib/outbound-call.ts", "src/lib/outbound-call-server.ts"]) {
    const s = await read(f);
    assert.doesNotMatch(s, /api\.vapi\.ai|VAPI_API|vapiAssistantId|vapi_assistant_id|vapi_phone_number_id|@vapi-ai/, f);
  }
});

test("worker: outbound rooms wait for an answered SIP leg before any speech, and record opening consent", async () => {
  const s = await read("livekit-agent/agent.py");
  assert.match(s, /async def wait_for_sip_answer/);
  assert.match(s, /record_opening_consent/);
  assert.match(s, /"openingConsent": str\(call_state\.get\("opening_consent"\) or ""\)/);
  // the no-answer path hangs up without speaking
  assert.match(s, /await end_call\("no_answer"\)/);
  // S3: only the dialer's own SIP participant (or the named test identity)
  // opens the gate — an attribute-less stranger/egress never does.
  assert.match(s, /OUTBOUND_SIP_IDENTITY_PREFIX = "sip-out-"/);
  assert.match(s, /identity\.startswith\(OUTBOUND_SIP_IDENTITY_PREFIX\)/);
  assert.doesNotMatch(s, /not any\(k\.startswith\("sip\."\) for k in attrs\)/);
});

test("S1/S4: approval is a server admin action and the calling slot is DB-unique", async () => {
  // no browser WRITER for approved_at (the read mapping in rowToCampaign stays)
  const db = await read("src/lib/db.ts");
  assert.doesNotMatch(db, /update\(\s*\{[^}]*approved_at/s, "db.ts must not write approved_at");
  assert.doesNotMatch(db, /export async function approveCampaign\b/, "browser approveCampaign must not exist");
  const route = await read("src/app/api/livekit/outbound/route.ts");
  assert.match(route, /action === "approve"/);
  assert.match(route, /approveCampaignForCalling\(ws, campaignId, auth\.userId\)/);
  // the claim goes straight to 'calling' and surfaces a unique violation as another_call_live
  const server = await read("src/lib/outbound-call-server.ts");
  assert.match(server, /status: "calling", status_detail: "", attempts/);
  assert.match(server, /23505/);
  assert.match(server, /stale_calling/);
  // the staged migration enforces one calling slot per workspace
  const mig = await read("supabase/pending/0069_outbound_campaign_leads.sql");
  assert.match(mig, /campaign_leads_one_calling_per_ws/);
  assert.match(mig, /where status = 'calling'/);
});

test("marketing eligibility is its own fact: the migration separates it from recording consent and opening consent", async () => {
  const s = await read("supabase/pending/0069_outbound_campaign_leads.sql");
  assert.match(s, /marketing_eligible_at timestamptz/);
  assert.match(s, /opening_consent text/);
  assert.match(s, /voice_dnc/);
  // Recording consent/config stays out of the LEAD TABLE DEFINITION (the
  // header prose may explain the separation; the schema must embody it).
  const leadTable = s.slice(s.indexOf("create table if not exists public.campaign_leads"), s.indexOf("create table if not exists public.voice_dnc"));
  assert.doesNotMatch(leadTable, /recordCalls|recording_azure|recording_status|recording_path/i, "recording consent/config stays out of the lead table");
  // opt-outs survive campaign deletion: voice_dnc carries no campaign reference
  const dnc = s.slice(s.indexOf("create table if not exists public.voice_dnc"), s.indexOf("voice_dnc_ws_phone_uniq"));
  assert.doesNotMatch(dnc, /campaign/i);
});
