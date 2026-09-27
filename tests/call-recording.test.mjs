// LiveKit call recording (Stage C2): consent gating (default off, server
// enforced), Tina-only scope, no_store precedence, egress lifecycle mapping,
// playback gating, tenant isolation, transcript timestamp truthfulness, and
// the column-scope guarantee that recording writes cannot collide with
// summary / outcome / extraction writers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const {
  recordingEnvFrom,
  recordingEligible,
  recordingObjectPath,
  egressEndedUpdate,
  recordingView,
  authorizeRecordingAccess,
} = await import("@/lib/call-recording");
const { workerMessagesToRows } = await import("@/lib/call-transcript");

const ENV = { RECORDING_AZURE_ACCOUNT: "fictionalacct", RECORDING_AZURE_KEY: "ZmljdGlvbmFs", RECORDING_AZURE_CONTAINER: "call-recordings" };

// ── storage environment ──────────────────────────────────────────────────────
test("recording env requires all three variables", () => {
  assert.deepEqual(recordingEnvFrom(ENV), { account: "fictionalacct", key: "ZmljdGlvbmFs", container: "call-recordings" });
  for (const missing of Object.keys(ENV)) {
    assert.equal(recordingEnvFrom({ ...ENV, [missing]: "" }), null, missing);
    assert.equal(recordingEnvFrom({ ...ENV, [missing]: undefined }), null, missing);
  }
  assert.equal(recordingEnvFrom({}), null);
});

// ── eligibility: default off, server-side rules ──────────────────────────────
const OK = { recordCalls: true, dataStorage: "store_analyze", external: false, envReady: true };

test("recording is OFF by default and only boolean true enables it", () => {
  assert.deepEqual(recordingEligible({ ...OK, recordCalls: false }), { ok: false, reason: "disabled" });
  // Anything a client might sneak in that isn't literally true stays off.
  assert.deepEqual(recordingEligible({ ...OK, recordCalls: "true" }).ok, false);
  assert.deepEqual(recordingEligible({ ...OK, recordCalls: 1 }).ok, false);
  assert.deepEqual(recordingEligible(OK), { ok: true });
});

test("no_store privacy always wins over the recording toggle", () => {
  assert.deepEqual(recordingEligible({ ...OK, dataStorage: "no_store" }), { ok: false, reason: "no_store" });
  assert.equal(recordingEligible({ ...OK, dataStorage: "store_only" }).ok, true); // storage allowed, analysis not needed
});

test("external (Builder/Laura) agents are never recorded — Tina only", () => {
  assert.deepEqual(recordingEligible({ ...OK, external: true }), { ok: false, reason: "external_agent" });
});

test("missing storage configuration disables recording entirely", () => {
  assert.deepEqual(recordingEligible({ ...OK, envReady: false }), { ok: false, reason: "storage_not_configured" });
});

// ── object naming ────────────────────────────────────────────────────────────
test("object paths are workspace-scoped", () => {
  assert.equal(recordingObjectPath("ws-1", "p_ws-1_test_abc123"), "recordings/ws-1/p_ws-1_test_abc123.ogg");
});

// ── egress lifecycle mapping ─────────────────────────────────────────────────
test("egress completion records the final path", () => {
  assert.deepEqual(
    egressEndedUpdate({ status: 3, fileResults: [{ filename: "recordings/ws-1/room.ogg" }] }),
    { recording_status: "complete", recording_path: "recordings/ws-1/room.ogg" }
  );
  // String-form enum (JSON webhook payloads) works the same.
  assert.deepEqual(egressEndedUpdate({ status: "EGRESS_COMPLETE" }), { recording_status: "complete" });
});

test("egress failures record a reason and never a path", () => {
  assert.deepEqual(egressEndedUpdate({ status: 4, error: "upload failed" }), { recording_status: "failed: upload failed" });
  assert.deepEqual(egressEndedUpdate({ status: "EGRESS_FAILED" }), { recording_status: "failed: egress failed" });
  assert.deepEqual(egressEndedUpdate({ status: 5 }), { recording_status: "failed: aborted" });
  assert.deepEqual(egressEndedUpdate({ status: 6 }), { recording_status: "failed: time limit reached" });
});

test("non-terminal egress states persist nothing", () => {
  for (const status of [0, 1, 2, "EGRESS_ACTIVE", undefined, "weird"]) {
    assert.equal(egressEndedUpdate({ status }), null, String(status));
  }
});

// ── playback gating / UI states ──────────────────────────────────────────────
test("a recording is playable only when complete WITH a stored path", () => {
  assert.equal(recordingView({ recordingStatus: "complete", recordingPath: "recordings/ws/x.ogg" }), "complete");
  assert.equal(recordingView({ recordingStatus: "complete", recordingPath: "" }), "none");
  assert.equal(recordingView({ recordingStatus: "failed: aborted", recordingPath: "" }), "failed");
  assert.equal(recordingView({ recordingStatus: "active", recordingPath: "recordings/ws/x.ogg" }), "pending");
  assert.equal(recordingView({ recordingStatus: "", recordingPath: "" }), "none");
});

// ── tenant isolation on playback/download ────────────────────────────────────
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

test("recording access requires a valid session and same-workspace call", async () => {
  assert.deepEqual(await authorizeRecordingAccess(authDeps, null, "call-1"), { ok: false, status: 401, error: "Sign in first." });
  assert.deepEqual(await authorizeRecordingAccess(authDeps, "bad", "call-1"), { ok: false, status: 401, error: "Invalid session." });
  assert.deepEqual(await authorizeRecordingAccess(authDeps, "good-token", "call-1"), { ok: true });
  const foreign = await authorizeRecordingAccess(authDeps, "good-token", "call-2");
  assert.deepEqual(foreign, { ok: false, status: 404, error: "Call not found." });
  assert.deepEqual(await authorizeRecordingAccess(authDeps, "good-token", "call-x"), foreign);
});

// ── transcript timestamps: stored truth only ─────────────────────────────────
test("worker messages keep real offsets and NEVER get the array index", () => {
  const rows = workerMessagesToRows([
    { role: "assistant", text: "Hello!", secondsFromStart: 1.2 },
    { role: "user", text: "Hi." },                       // worker had no timestamp
    { role: "user", text: "negative", secondsFromStart: -3 },
    { role: "user", text: "junk", secondsFromStart: "5" },
  ]);
  assert.deepEqual(rows, [
    { role: "bot", message: "Hello!", secondsFromStart: 1.2 },
    { role: "user", message: "Hi.", secondsFromStart: null },
    { role: "user", message: "negative", secondsFromStart: null },
    { role: "user", message: "junk", secondsFromStart: null },
  ]);
});

test("worker message mapping tolerates junk input", () => {
  assert.deepEqual(workerMessagesToRows(undefined), []);
  assert.deepEqual(workerMessagesToRows("nope"), []);
  assert.deepEqual(workerMessagesToRows([null, 42, { role: "assistant", content: "via content" }]), [
    { role: "bot", message: "via content", secondsFromStart: null },
  ]);
});

// ── column-scope guarantees (both directions) ────────────────────────────────
test("no summary/outcome/extraction writer names the recording columns", async () => {
  const writers = [
    "src/app/api/vapi/events/route.ts",
    "src/app/api/livekit/call-log/route.ts",
    "src/lib/post-call.ts",
    "src/lib/call-summary-server.ts",
    "src/app/api/voice/outcome/route.ts",
  ];
  for (const f of writers) {
    const src = await readFile(new URL(`../${f}`, import.meta.url), "utf8");
    assert.equal(/recording_(path|status|egress)/.test(src), false, `${f} must not write recording columns`);
  }
});

test("the recording pipeline conversely never names staff or summary fields", async () => {
  for (const f of ["src/lib/call-recording-server.ts", "src/lib/call-recording.ts"]) {
    const src = await readFile(new URL(`../${f}`, import.meta.url), "utf8");
    assert.equal(src.includes("staff_outcome"), false, f);
    assert.equal(src.includes("summary_ai"), false, f);
    assert.equal(/[^_]summary:/.test(src), false, f);
  }
});
