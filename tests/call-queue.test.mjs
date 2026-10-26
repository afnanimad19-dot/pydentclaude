// Outbound call queue (Phase 4): calling hours, schedule/expiry eligibility,
// retry policy, duplicate prevention, and the structural guarantee that the
// queue is a SCHEDULING layer only — every dial goes through the shared-line
// guarded path and no scheduler runs it automatically. Offline only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const {
  CALL_QUEUE_KINDS,
  DEFAULT_CALLING_HOURS,
  normalizeCallKind,
  normalizeCallingHours,
  callingHoursGate,
  queueItemEligibility,
  retryDecision,
  queueAttemptIdempotencyKey,
  RETRYABLE_OUTCOMES,
} = await import("@/lib/call-queue");

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

// ── calling hours (scenario 13 of the fast-track test list) ───────────────────
test("calling hours: Dubai default window Mon–Sat 09:00–18:00", () => {
  assert.deepEqual(DEFAULT_CALLING_HOURS, { tz: "Asia/Dubai", start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5, 6] });
  // Wednesday 2026-10-28 10:00 Dubai (06:00 UTC) — allowed
  assert.equal(callingHoursGate(DEFAULT_CALLING_HOURS, new Date("2026-10-28T06:00:00Z")).ok, true);
  // Wednesday 20:00 UTC = Thursday 00:00 Dubai — blocked (midnight)
  assert.equal(callingHoursGate(DEFAULT_CALLING_HOURS, new Date("2026-10-28T20:00:00Z")).ok, false);
  // Early morning: 04:00 UTC = 08:00 Dubai — blocked (before 09:00)
  assert.equal(callingHoursGate(DEFAULT_CALLING_HOURS, new Date("2026-10-28T04:00:00Z")).ok, false);
  // 18:00 Dubai exactly (14:00 UTC) — blocked (end exclusive)
  assert.equal(callingHoursGate(DEFAULT_CALLING_HOURS, new Date("2026-10-28T14:00:00Z")).ok, false);
  // Sunday 2026-10-25 10:00 Dubai — blocked (not a calling day)
  assert.equal(callingHoursGate(DEFAULT_CALLING_HOURS, new Date("2026-10-25T06:00:00Z")).ok, false);
});

test("calling hours fail closed: malformed fields fall back, unknown timezone/inverted window never calls", () => {
  const n = normalizeCallingHours({ tz: "", start: "9am", end: "25:99", days: ["x", 9, 3] });
  assert.deepEqual(n, { tz: "Asia/Dubai", start: "09:00", end: "18:00", days: [3] });
  assert.equal(callingHoursGate({ tz: "Not/AZone", start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5, 6] }, new Date("2026-10-28T06:00:00Z")).ok, false);
  assert.equal(callingHoursGate({ tz: "Asia/Dubai", start: "18:00", end: "09:00", days: [3] }, new Date("2026-10-28T06:00:00Z")).ok, false);
});

// ── eligibility & expiry ──────────────────────────────────────────────────────
test("queue eligibility: due only when scheduled time passed, within the window, status scheduled", () => {
  const NOW = new Date("2026-10-28T06:00:00Z");
  const base = { status: "scheduled", scheduledAt: "2026-10-28T05:00:00Z", notAfter: null, attempts: 0, maxAttempts: 2, retryBackoffMinutes: 120 };
  assert.equal(queueItemEligibility(base, NOW), "due");
  assert.equal(queueItemEligibility({ ...base, scheduledAt: "2026-10-28T07:00:00Z" }, NOW), "not_yet");
  assert.equal(queueItemEligibility({ ...base, notAfter: "2026-10-28T05:30:00Z" }, NOW), "expired"); // reminder after the appointment is pointless
  assert.equal(queueItemEligibility({ ...base, status: "calling" }, NOW), "not_runnable");
  assert.equal(queueItemEligibility({ ...base, scheduledAt: "garbage" }, NOW), "not_runnable"); // unparseable never runs
});

// ── retry policy (scenarios: duplicate prevention, disconnect handling) ───────
test("retry policy: only no-answer/sip-failure retries, with backoff, up to max attempts", () => {
  const i = { attempts: 1, maxAttempts: 2, retryBackoffMinutes: 120 };
  const NOW = new Date("2026-10-28T06:00:00Z");
  assert.deepEqual([...RETRYABLE_OUTCOMES], ["no_answer", "sip_failed"]);
  const r = retryDecision(i, "no_answer", NOW);
  assert.equal(r.action, "retry");
  assert.equal(r.nextAttemptAtMs, NOW.getTime() + 120 * 60_000);
  // attempts exhausted → failed, never endless redials
  assert.equal(retryDecision({ ...i, attempts: 2 }, "no_answer", NOW).action, "failed");
  // a reached human is TERMINAL whatever they answered — no auto-redial
  assert.equal(retryDecision(i, "opening:accepted", NOW).action, "done");
  assert.equal(retryDecision(i, "opening:declined", NOW).action, "done");
  // DNC/eligibility/policy blocks cancel the item outright
  assert.equal(retryDecision(i, "do_not_call", NOW).action, "cancelled");
  assert.equal(retryDecision(i, "not_marketing_eligible", NOW).action, "cancelled");
  assert.equal(retryDecision(i, "destination_policy:not_uae_mobile", NOW).action, "cancelled");
  // unknown outcomes are terminal (fail closed), never retried blindly
  assert.equal(retryDecision(i, "", NOW).action, "failed");
  assert.equal(retryDecision(i, "mystery", NOW).action, "failed");
});

test("one idempotency key per (item, attempt): a crashed runner cannot double-dial an attempt", () => {
  assert.equal(queueAttemptIdempotencyKey("item-1", 1), "queue:item-1:a1");
  assert.notEqual(queueAttemptIdempotencyKey("item-1", 1), queueAttemptIdempotencyKey("item-1", 2));
  assert.notEqual(queueAttemptIdempotencyKey("item-1", 1), queueAttemptIdempotencyKey("item-2", 1));
});

test("call kinds are a closed set", () => {
  assert.deepEqual([...CALL_QUEUE_KINDS], ["campaign", "reminder", "confirmation", "followup", "callback", "outreach"]);
  assert.equal(normalizeCallKind("Reminder"), "reminder");
  assert.equal(normalizeCallKind("marketing-blast"), "");
});

// ── structural guarantees (source level; DB and SIP are never touched) ────────
test("the queue dials ONLY through the shared-line guarded path, one item per run", async () => {
  const s = await read("src/lib/call-queue-server.ts");
  assert.match(s, /placeLineGuardedCall\(\{/);
  assert.doesNotMatch(s, /placeCampaignCall|createSipParticipant/); // never bypasses the controller
  assert.match(s, /queueAttemptIdempotencyKey\(String\(item\.id\), attempt\)/);
  // single-call discipline: the runner claims at most one item (CAS)
  assert.match(s, /eq\("id", item\.id\)\.eq\("status", "scheduled"\)\.select\("id"\)/);
  // tenant isolation: every call_queue read in the server module is
  // workspace-scoped (RLS in the migration is the second layer)
  const queueReads = s.split('from("call_queue").select').length - 1;
  const scopedReads = s.split('from("call_queue").select("*").eq("workspace_id", ws)').length - 1
    + s.split('from("call_queue").select("status, kind, scheduled_at, campaign_id").eq("workspace_id", ws)').length - 1;
  assert.equal(queueReads, scopedReads, "every call_queue select is workspace-scoped");
});

test("no scheduler/cron wiring: queue-run is an explicit admin action only (K-1 keeps automation disabled)", async () => {
  const route = await read("src/app/api/livekit/outbound/route.ts");
  assert.match(route, /action === "queue-run"/);
  assert.match(route, /authorizeRequest\(req, \{ requireAdmin: true \}\)/);
  const server = await read("src/lib/call-queue-server.ts");
  assert.match(server, /NO cron wiring/);
  // nothing else in src calls runQueueOnce
  const { execSync } = await import("node:child_process");
  const hits = execSync("grep -rl runQueueOnce src --include=*.ts --include=*.tsx", { cwd: new URL("..", import.meta.url).pathname })
    .toString().trim().split("\n").sort();
  assert.deepEqual(hits, ["src/app/api/livekit/outbound/route.ts", "src/lib/call-queue-server.ts"]);
});

test("the staged 0071 migration enforces one live queue item per lead and stays in pending/", async () => {
  const mig = await read("supabase/pending/0071_call_queue.sql");
  assert.match(mig, /call_queue_one_live_per_lead/);
  assert.match(mig, /where status in \('scheduled', 'calling'\)/);
  assert.match(mig, /enable row level security/);
  assert.match(mig, /NOT EXECUTED ANYWHERE YET/);
});

test("call-end close-out is keyed by the exact call key (late webhooks cannot corrupt newer items)", async () => {
  const server = await read("src/lib/call-queue-server.ts");
  assert.match(server, /eq\("last_call_key", callKey\)\.eq\("status", "calling"\)/);
  const callLog = await read("src/app/api/livekit/call-log/route.ts");
  assert.match(callLog, /closeQueueItemForCallEnd\(ws, `lk:\$\{room\}`/);
});
