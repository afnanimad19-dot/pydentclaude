// Phase 2A — /api/calendar/gcal logic (lib/calendar-mirror.ts). Pure, with
// injected push/status services: no Google calls, no database, no real events.
//
// Pins the security contract: the workspace is the SESSION workspace the route
// passes in (a `ws` field in the body is ignored), and the status check never
// performs a calendar write (the old unauthenticated event-creating GET is gone).

import { test } from "node:test";
import assert from "node:assert/strict";

const { mirrorBookingEvent, calendarMirrorStatus } = await import("@/lib/calendar-mirror");

const SESSION_WS = "11111111-1111-1111-1111-111111111111";

function recordingDeps(overrides = {}) {
  const calls = { google: [], engine: [] };
  const deps = {
    pushGoogle: async (ws, ev) => { calls.google.push({ ws, ev }); return "evt-google-1"; },
    pushEngine: async (ws, ev) => { calls.engine.push({ ws, ev }); return { ok: true, id: "evt-engine-1" }; },
    googleConnected: async () => true,
    engineConfigured: async () => true,
    ...overrides,
  };
  return { deps, calls };
}

// ── Workspace authority ──────────────────────────────────────────────────────
test("a ws field in the body is ignored — pushes run for the SESSION workspace only", async () => {
  const { deps, calls } = recordingDeps();
  const r = await mirrorBookingEvent(deps, SESSION_WS, {
    ws: "22222222-2222-2222-2222-222222222222", // attacker-chosen tenant: must be ignored
    summary: "Cleaning — Test Patient", date: "2026-11-05", time: "10:00",
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(calls.google.length, 1);
  assert.equal(calls.google[0].ws, SESSION_WS);
});

// ── Validation ────────────────────────────────────────────────────────────────
test("missing or malformed date/time is a 400 with no push attempted", async () => {
  const { deps, calls } = recordingDeps();
  for (const body of [{}, { date: "2026-11-05" }, { date: "05/11/2026", time: "10:00" }, { date: "2026-11-05", time: "ten" }]) {
    const r = await mirrorBookingEvent(deps, SESSION_WS, body);
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
  }
  assert.equal(calls.google.length + calls.engine.length, 0);
});

// ── Authorized event creation: fallback order preserved ──────────────────────
test("Google OAuth path first; engine is not called when Google succeeds", async () => {
  const { deps, calls } = recordingDeps();
  const r = await mirrorBookingEvent(deps, SESSION_WS, { summary: "Exam", date: "2026-11-05", time: "09:30" });
  assert.deepEqual([r.body.ok, r.body.via], [true, "google"]);
  assert.equal(calls.engine.length, 0);
});

test("engine fallback runs when the OAuth push yields no event", async () => {
  const { deps, calls } = recordingDeps({ pushGoogle: async () => null });
  const r = await mirrorBookingEvent(deps, SESSION_WS, { summary: "Exam", date: "2026-11-05", time: "09:30" });
  assert.deepEqual([r.body.ok, r.body.via], [true, "engine"]);
  assert.equal(calls.engine.length, 1);
  assert.equal(calls.engine[0].ws, SESSION_WS);
});

test("both paths failing reports ok:false truthfully (no fake success)", async () => {
  const { deps } = recordingDeps({ pushGoogle: async () => null, pushEngine: async () => ({ ok: false, error: "engine not configured" }) });
  const r = await mirrorBookingEvent(deps, SESSION_WS, { summary: "Exam", date: "2026-11-05", time: "09:30" });
  assert.deepEqual([r.body.ok, r.body.via], [false, "none"]);
  assert.match(String(r.body.error), /engine not configured/);
});

test("a throwing push is contained — no crash, honest failure", async () => {
  const { deps } = recordingDeps({ pushGoogle: async () => { throw new Error("google down"); } });
  const r = await mirrorBookingEvent(deps, SESSION_WS, { summary: "Exam", date: "2026-11-05", time: "09:30" });
  assert.equal(r.body.ok, false);
});

// ── Status is read-only ────────────────────────────────────────────────────────
test("status NEVER creates an event: push deps throw if touched", async () => {
  const deps = {
    pushGoogle: async () => { throw new Error("status must not write"); },
    pushEngine: async () => { throw new Error("status must not write"); },
    googleConnected: async (ws) => { assert.equal(ws, SESSION_WS); return true; },
    engineConfigured: async () => false,
  };
  const r = await calendarMirrorStatus(deps, SESSION_WS);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.google, { connected: true });
  assert.deepEqual(r.body.engine, { configured: false });
  assert.equal(r.body.ok, true);
});

test("status with nothing connected reports ok:false and how to fix it", async () => {
  const deps = {
    pushGoogle: async () => { throw new Error("no"); },
    pushEngine: async () => { throw new Error("no"); },
    googleConnected: async () => false,
    engineConfigured: async () => false,
  };
  const r = await calendarMirrorStatus(deps, SESSION_WS);
  assert.equal(r.body.ok, false);
  assert.match(String(r.body.note), /Settings/);
});

test("a failing status probe reads as not-connected, never as an error page", async () => {
  const deps = {
    pushGoogle: async () => null,
    pushEngine: async () => ({ ok: false }),
    googleConnected: async () => { throw new Error("token table unreachable"); },
    engineConfigured: async () => true,
  };
  const r = await calendarMirrorStatus(deps, SESSION_WS);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.google, { connected: false });
});
