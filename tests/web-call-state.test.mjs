// Browser test-call state machine: connection-state transitions, mic-vs-audio
// separation, edge-triggered blocked-playback notifications, and the
// nothing-after-close guarantee. Pure logic — the DOM/livekit wiring in
// livekit-web-call.ts delegates every decision here.

import { test } from "node:test";
import assert from "node:assert/strict";

const { WebCallState } = await import("@/lib/web-call-state");

function record() {
  const events = [];
  return {
    events,
    ev: {
      onState: (s) => events.push(["state", s]),
      onAudioBlocked: (b) => events.push(["blocked", b]),
      onMicError: (m) => events.push(["mic", m]),
    },
  };
}

// ── Connection state ─────────────────────────────────────────────────────────
test("room connect reports live exactly once", () => {
  const { events, ev } = record();
  const s = new WebCallState(ev);
  s.connected();
  s.connected();
  assert.deepEqual(events, [["state", "live"]]);
});

test("a mic failure surfaces as a mic error and the call STAYS live", () => {
  const { events, ev } = record();
  const s = new WebCallState(ev);
  s.connected();
  s.micFailed("Permission denied");
  assert.deepEqual(events, [["state", "live"], ["mic", "Permission denied"]]);
  assert.equal(s.closed, false); // never flipped to ended/error
});

test("a late mic result cannot update the UI after the call ended", () => {
  const { events, ev } = record();
  const s = new WebCallState(ev);
  s.connected();
  s.ended();
  s.micFailed("Permission denied");   // permission prompt answered after hangup
  s.playback(true);                    // stray playback event after hangup
  s.connected();                       // stray reconnect signal
  assert.deepEqual(events, [["state", "live"], ["state", "ended"]]);
});

test("connect failure closes silently and blocks all later events", () => {
  const { events, ev } = record();
  const s = new WebCallState(ev);
  s.failed();
  s.connected();
  s.micFailed("x");
  s.playback(true);
  assert.equal(s.ended(), false);
  assert.deepEqual(events, []);
});

// ── Blocked playback ─────────────────────────────────────────────────────────
test("blocked playback is edge-triggered: repeats collapse, changes fire", () => {
  const { events, ev } = record();
  const s = new WebCallState(ev);
  s.connected();
  s.playback(true);
  s.playback(true);   // second rejected play() — no repeat
  s.playback(true);
  s.playback(false);  // recovery
  s.playback(false);  // repeated success — no repeat
  s.playback(true);   // blocked again later
  assert.deepEqual(events, [
    ["state", "live"],
    ["blocked", true],
    ["blocked", false],
    ["blocked", true],
  ]);
  assert.equal(s.isBlocked, true);
});

test("audio recovery after enableAudio reports unblocked once", () => {
  const { events, ev } = record();
  const s = new WebCallState(ev);
  s.connected();
  s.playback(true);
  // enableAudio(): startAudio + several element retries all succeed →
  // several playback(false) signals collapse into one notification.
  s.playback(false);
  s.playback(false);
  s.playback(false);
  assert.deepEqual(events.filter((e) => e[0] === "blocked"), [["blocked", true], ["blocked", false]]);
});

// ── Cleanup / close semantics ────────────────────────────────────────────────
test("remote disconnect notifies ended exactly once", () => {
  const { events, ev } = record();
  const s = new WebCallState(ev);
  s.connected();
  assert.equal(s.ended(), true);
  assert.equal(s.ended(), false); // double disconnect → single notification
  assert.deepEqual(events, [["state", "live"], ["state", "ended"]]);
});

test("local stop closes quietly: no ended event, later events ignored", () => {
  const { events, ev } = record();
  const s = new WebCallState(ev);
  s.connected();
  s.closeQuietly();               // the UI initiated the stop — it already knows
  assert.equal(s.closed, true);
  assert.equal(s.ended(), false); // the Disconnected that follows stays silent
  s.playback(true);
  assert.deepEqual(events, [["state", "live"]]);
});

test("handlers without optional callbacks never throw", () => {
  const s = new WebCallState({ onState: () => {} });
  s.connected();
  s.micFailed("x");
  s.playback(true);
  s.ended();
});
