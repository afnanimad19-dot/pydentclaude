// AI Call Summary: grounding against recorded tool results, idempotence and
// duplicate-submission safety, failed/empty-transcript handling, retry
// authorization + workspace isolation, and preservation of existing (incl.
// Vapi) summaries. Pure logic — call-summary-server.ts only binds Supabase
// and the chat model to these functions.

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  buildSummaryPrompt,
  normalizeToolCalls,
  transcriptOf,
  generateCallSummary,
  runCallSummary,
  deriveSummaryView,
  authorizeSummaryRetry,
  PROCESSING_FRESH_MS,
} = await import("@/lib/call-summary");

function recordingStore() {
  const calls = [];
  return {
    calls,
    store: {
      markProcessing: async (at) => calls.push(["processing", at]),
      markFailed: async (err, at) => calls.push(["failed", err, at]),
      saveSummary: async (summary, at) => { calls.push(["save", summary, at]); return true; },
    },
  };
}

const TRANSCRIPT = "Agent: Hello, Bright clinic.\nCaller: I'd like a cleaning on Monday.";

// ── grounding ────────────────────────────────────────────────────────────────
test("prompt lists succeeded vs failed tool actions separately", () => {
  const msgs = buildSummaryPrompt({
    transcript: TRANSCRIPT,
    toolCalls: [
      { name: "book_appointment", ok: true },
      { name: "send_confirmation_email", ok: false },
    ],
    agentName: "Laura",
  });
  assert.equal(msgs[0].role, "system");
  assert.match(msgs[0].content, /ONLY if it appears in the list of successfully completed tool actions/);
  assert.match(msgs[1].content, /COMPLETED successfully: book_appointment\./);
  assert.match(msgs[1].content, /FAILED: send_confirmation_email\./);
  assert.match(msgs[1].content, /handled by Laura/);
});

test("prompt with NO recorded tools forbids claiming any action was completed", () => {
  const msgs = buildSummaryPrompt({ transcript: TRANSCRIPT, toolCalls: [], agentName: "" });
  assert.match(msgs[1].content, /No tool actions were recorded/);
  assert.match(msgs[1].content, /NOT completed, no matter what the transcript says/);
});

test("a booking that only FAILED never lands in the completed list", () => {
  const msgs = buildSummaryPrompt({
    transcript: TRANSCRIPT,
    toolCalls: [{ name: "book_appointment", ok: false }],
    agentName: "Laura",
  });
  assert.match(msgs[1].content, /COMPLETED successfully: none\./);
  assert.match(msgs[1].content, /FAILED: book_appointment\./);
});

test("normalizeToolCalls tolerates junk and treats only ok:true as success", () => {
  const out = normalizeToolCalls([
    { name: "book_appointment", ms: 120, ok: true },
    { name: "lookup_patient", ok: "yes" }, // truthy but not boolean true
    { name: "" },
    null,
    "book_appointment",
    { ok: true },
  ]);
  assert.deepEqual(out, [
    { name: "book_appointment", ok: true },
    { name: "lookup_patient", ok: false },
  ]);
  assert.deepEqual(normalizeToolCalls(undefined), []);
  assert.deepEqual(normalizeToolCalls("nope"), []);
});

// ── transcript source (retry never fabricates) ───────────────────────────────
test("transcriptOf prefers the stored transcript, else rebuilds from stored messages", () => {
  assert.equal(transcriptOf("stored text", [{ role: "user", message: "ignored" }], "Laura"), "stored text");
  const rebuilt = transcriptOf("", [
    { role: "bot", message: "Hello!" },
    { role: "user", message: "Hi, I need an appointment." },
    { role: "bot", message: "" },
  ], "Laura");
  assert.equal(rebuilt, "Laura: Hello!\nCaller: Hi, I need an appointment.");
  assert.equal(transcriptOf("", [], "Laura"), "");
  assert.equal(transcriptOf(null, null, ""), "");
});

// ── generation ───────────────────────────────────────────────────────────────
test("generateCallSummary returns the model's trimmed text", async () => {
  const res = await generateCallSummary(async () => "  A caller asked about a cleaning.  ", {
    transcript: TRANSCRIPT, toolCalls: [], agentName: "Laura",
  });
  assert.equal(res.summary, "A caller asked about a cleaning.");
  assert.equal(res.error, undefined);
});

test("generateCallSummary refuses an empty transcript without calling the model", async () => {
  let called = false;
  const res = await generateCallSummary(async () => { called = true; return "x"; }, {
    transcript: "   ", toolCalls: [], agentName: "Laura",
  });
  assert.equal(called, false);
  assert.match(res.error, /No transcript/);
});

test("generateCallSummary surfaces model failures and empty replies as errors", async () => {
  const failed = await generateCallSummary(async () => { throw new Error("provider down"); }, {
    transcript: TRANSCRIPT, toolCalls: [], agentName: "Laura",
  });
  assert.equal(failed.error, "provider down");
  const empty = await generateCallSummary(async () => "", { transcript: TRANSCRIPT, toolCalls: [], agentName: "Laura" });
  assert.match(empty.error, /empty summary/);
});

test("generateCallSummary enforces its deadline (frozen-runtime guard)", async () => {
  const res = await generateCallSummary(() => new Promise(() => {}), {
    transcript: TRANSCRIPT, toolCalls: [], agentName: "Laura", deadlineMs: 30,
  });
  assert.match(res.error, /timed out/);
});

// ── orchestration: idempotence & preservation ────────────────────────────────
test("an existing summary (e.g. Vapi) is preserved — nothing generated or written", async () => {
  const { calls, store } = recordingStore();
  const out = await runCallSummary(
    { chat: async () => { throw new Error("must not be called"); }, store },
    { summary: "Vapi already summarized this.", transcript: TRANSCRIPT, structuredData: {}, agentName: "Laura" }
  );
  assert.deepEqual(out, { status: "skipped", reason: "already_summarized" });
  assert.deepEqual(calls, []);
});

test("privacy modes that forbid analysis are refused without any write", async () => {
  const { calls, store } = recordingStore();
  for (const privacy of ["store_only", "no_store"]) {
    const out = await runCallSummary(
      { chat: async () => "x", store },
      { summary: "", transcript: TRANSCRIPT, structuredData: { privacy }, agentName: "Laura", privacy }
    );
    assert.deepEqual(out, { status: "skipped", reason: "analysis_disabled" });
  }
  assert.deepEqual(calls, []);
});

test("a duplicate submission while a FRESH generation is in flight is skipped", async () => {
  const { calls, store } = recordingStore();
  const out = await runCallSummary(
    { chat: async () => "x", store },
    {
      summary: "",
      transcript: TRANSCRIPT,
      structuredData: { summary_ai: { status: "processing", at: new Date().toISOString() } },
      agentName: "Laura",
    }
  );
  assert.deepEqual(out, { status: "skipped", reason: "in_progress" });
  assert.deepEqual(calls, []);
});

test("a STALE processing marker (frozen earlier run) does not block regeneration", async () => {
  const { calls, store } = recordingStore();
  const staleAt = new Date(Date.now() - PROCESSING_FRESH_MS - 1000).toISOString();
  const out = await runCallSummary(
    { chat: async () => "Fresh summary." , store },
    { summary: "", transcript: TRANSCRIPT, structuredData: { summary_ai: { status: "processing", at: staleAt } }, agentName: "Laura" }
  );
  assert.equal(out.status, "available");
  assert.equal(calls[0][0], "processing");
  assert.deepEqual(calls[1].slice(0, 2), ["save", "Fresh summary."]);
});

test("success path: processing marker, then guarded save", async () => {
  const { calls, store } = recordingStore();
  const out = await runCallSummary(
    { chat: async () => "Caller booked a cleaning." , store },
    { summary: "", transcript: TRANSCRIPT, structuredData: { toolCalls: [{ name: "book_appointment", ok: true }] }, agentName: "Laura" }
  );
  assert.deepEqual(out, { status: "available", summary: "Caller booked a cleaning." });
  assert.deepEqual(calls.map((c) => c[0]), ["processing", "save"]);
});

test("if another writer landed a summary mid-generation, ours is discarded", async () => {
  const calls = [];
  const store = {
    markProcessing: async () => calls.push("processing"),
    markFailed: async () => calls.push("failed"),
    saveSummary: async () => { calls.push("save"); return false; }, // guard says: already filled
  };
  const out = await runCallSummary(
    { chat: async () => "late summary", store },
    { summary: "", transcript: TRANSCRIPT, structuredData: {}, agentName: "Laura" }
  );
  assert.deepEqual(out, { status: "skipped", reason: "already_summarized" });
  assert.deepEqual(calls, ["processing", "save"]);
});

test("no stored transcript → recorded as failed, never fabricated", async () => {
  const { calls, store } = recordingStore();
  const out = await runCallSummary(
    { chat: async () => { throw new Error("must not be called"); }, store },
    { summary: "", transcript: "", structuredData: {}, agentName: "Laura" }
  );
  assert.equal(out.status, "failed");
  assert.match(out.reason, /No transcript/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "failed");
});

test("a model failure is recorded as failed with its reason", async () => {
  const { calls, store } = recordingStore();
  const out = await runCallSummary(
    { chat: async () => { throw new Error("provider down"); }, store },
    { summary: "", transcript: TRANSCRIPT, structuredData: {}, agentName: "Laura" }
  );
  assert.deepEqual(out, { status: "failed", reason: "provider down" });
  assert.deepEqual(calls.map((c) => c[0]), ["processing", "failed"]);
  assert.equal(calls[1][1], "provider down");
});

// ── UI state derivation ──────────────────────────────────────────────────────
test("deriveSummaryView maps the stored state to Available/Processing/Failed/None", () => {
  const now = Date.now();
  assert.deepEqual(
    deriveSummaryView({ summary: "Done.", structuredData: {}, hasTranscript: true }),
    { kind: "available", canRetry: false }
  );
  assert.deepEqual(
    deriveSummaryView({ summary: "", structuredData: { summary_ai: { status: "processing", at: new Date(now - 1000).toISOString() } }, hasTranscript: true, nowMs: now }),
    { kind: "processing", canRetry: false }
  );
  const stale = deriveSummaryView({
    summary: "",
    structuredData: { summary_ai: { status: "processing", at: new Date(now - PROCESSING_FRESH_MS - 1).toISOString() } },
    hasTranscript: true,
    nowMs: now,
  });
  assert.equal(stale.kind, "failed");
  assert.equal(stale.canRetry, true);
  const failed = deriveSummaryView({ summary: "", structuredData: { summary_ai: { status: "failed", error: "provider down" } }, hasTranscript: true });
  assert.deepEqual(failed, { kind: "failed", error: "provider down", canRetry: true });
  assert.deepEqual(deriveSummaryView({ summary: "", structuredData: {}, hasTranscript: true }), { kind: "none", canRetry: true });
  // No stored transcript → no retry offered anywhere (nothing to summarize).
  assert.equal(deriveSummaryView({ summary: "", structuredData: {}, hasTranscript: false }).canRetry, false);
  assert.equal(deriveSummaryView({ summary: "", structuredData: { summary_ai: { status: "failed" } }, hasTranscript: false }).canRetry, false);
});

// ── retry authorization & tenant isolation ───────────────────────────────────
const AUTH_DB = {
  users: { "good-token": "user-1" },
  profiles: { "user-1": "ws-A" },
  calls: { "call-1": "ws-A", "call-2": "ws-B" },
};
const authDeps = {
  getUserId: async (t) => AUTH_DB.users[t] ?? null,
  getProfileWorkspace: async (u) => AUTH_DB.profiles[u] ?? null,
  getCallWorkspace: async (c) => AUTH_DB.calls[c] ?? null,
};

test("retry without a token is 401", async () => {
  const out = await authorizeSummaryRetry(authDeps, null, "call-1");
  assert.deepEqual(out, { ok: false, status: 401, error: "Sign in first." });
});

test("retry with an invalid session is 401", async () => {
  const out = await authorizeSummaryRetry(authDeps, "bad-token", "call-1");
  assert.deepEqual(out, { ok: false, status: 401, error: "Invalid session." });
});

test("retry without a callId is 400", async () => {
  const out = await authorizeSummaryRetry(authDeps, "good-token", "");
  assert.equal(out.status, 400);
});

test("retry for a call in the caller's workspace is allowed", async () => {
  assert.deepEqual(await authorizeSummaryRetry(authDeps, "good-token", "call-1"), { ok: true });
});

test("another tenant's call and a missing call are both 404 (no probing)", async () => {
  const foreign = await authorizeSummaryRetry(authDeps, "good-token", "call-2");
  const missing = await authorizeSummaryRetry(authDeps, "good-token", "call-x");
  assert.deepEqual(foreign, { ok: false, status: 404, error: "Call not found." });
  assert.deepEqual(missing, foreign);
});

test("a user without a workspace cannot retry anything", async () => {
  const deps = { ...authDeps, getProfileWorkspace: async () => null };
  const out = await authorizeSummaryRetry(deps, "good-token", "call-1");
  assert.equal(out.status, 401);
});
