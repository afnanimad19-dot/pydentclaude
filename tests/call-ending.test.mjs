// Call Ending & Goodbye: normalization/back-compat, closing-message
// resolution (clinic-name default), mode-specific prompt rules (explicit vs
// automatic vs manual, thank-you-is-not-goodbye, ask-anything-else-once,
// interruption keeps the call open), and the silence-timeout mapping onto the
// worker's lifecycle limits. All pure — the worker consumes the compiled
// result per call.

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  CALL_ENDING_DEFAULT,
  normalizeCallEnding,
  defaultGeneralGoodbye,
  resolveClosingMessages,
  callEndingRules,
  applySilencePolicy,
  HANGUP_DELAYS,
  SILENCE_TIMEOUTS,
} = await import("@/lib/call-ending");

// ── normalization & backward compatibility ──────────────────────────────────
test("agents saved before the feature read as DISABLED with safe defaults", () => {
  for (const legacy of [undefined, null, {}, "junk", 42]) {
    const ce = normalizeCallEnding(legacy);
    assert.equal(ce.enabled, false, JSON.stringify(legacy));
    assert.equal(ce.mode, "explicit");
    assert.equal(ce.confirmBeforeEnding, true);
    assert.equal(ce.hangupDelaySec, 1);
    assert.equal(ce.silenceTimeoutSec, 0);
    assert.deepEqual(ce.messages, CALL_ENDING_DEFAULT.messages);
  }
});

test("only literal true enables; malformed values collapse to safe ones", () => {
  assert.equal(normalizeCallEnding({ enabled: "true" }).enabled, false);
  assert.equal(normalizeCallEnding({ enabled: 1 }).enabled, false);
  const ce = normalizeCallEnding({
    enabled: true,
    mode: "aggressive",          // not a mode
    hangupDelaySec: 7,           // outside 0–3
    silenceTimeoutSec: 22,       // not one of the allowed steps
    messages: { general: "  hi  ", bookingConfirmed: 5, extra: "ignored" },
  });
  assert.equal(ce.enabled, true);
  assert.equal(ce.mode, "explicit");
  assert.equal(ce.hangupDelaySec, 1);
  assert.equal(ce.silenceTimeoutSec, 0);
  assert.equal(ce.messages.general, "hi"); // trimmed
  assert.equal(ce.messages.bookingConfirmed, "");
  assert.equal("extra" in ce.messages, false);
});

test("valid choices survive normalization exactly (settings persistence)", () => {
  const saved = {
    enabled: true,
    mode: "automatic",
    confirmBeforeEnding: false,
    hangupDelaySec: 3,
    silenceTimeoutSec: 45,
    messages: { general: "Bye!", bookingConfirmed: "Booked!", bookingChanged: "Changed!", enquiry: "Answered!", unresolved: "We'll follow up." },
  };
  assert.deepEqual(normalizeCallEnding(saved), saved);
  // Every offered dropdown value is accepted.
  for (const d of HANGUP_DELAYS) assert.equal(normalizeCallEnding({ hangupDelaySec: d }).hangupDelaySec, d);
  for (const s of SILENCE_TIMEOUTS) assert.equal(normalizeCallEnding({ silenceTimeoutSec: s }).silenceTimeoutSec, s);
});

test("messages are length-capped", () => {
  const ce = normalizeCallEnding({ messages: { general: "x".repeat(2000) } });
  assert.equal(ce.messages.general.length, 500);
});

// ── closing messages & the clinic-name default ───────────────────────────────
test("the default goodbye is templated with the clinic name — LHDM example", () => {
  assert.equal(
    defaultGeneralGoodbye("Leila Hariri Dental & Medical"),
    "Thank you for calling Leila Hariri Dental & Medical. Have a wonderful day!"
  );
  assert.equal(defaultGeneralGoodbye(""), "Thank you for calling. Have a wonderful day!");
  assert.equal(defaultGeneralGoodbye(undefined), "Thank you for calling. Have a wonderful day!");
});

test("an admin-written general goodbye wins over the clinic default", () => {
  const ce = normalizeCallEnding({ enabled: true, messages: { general: "Custom bye." } });
  assert.equal(resolveClosingMessages(ce, "Some Clinic").general, "Custom bye.");
  const empty = normalizeCallEnding({ enabled: true });
  assert.equal(resolveClosingMessages(empty, "Some Clinic").general, "Thank you for calling Some Clinic. Have a wonderful day!");
});

// ── prompt rules per mode ────────────────────────────────────────────────────
test("disabled feature contributes NO rules (legacy prompts unchanged)", () => {
  assert.deepEqual(callEndingRules(normalizeCallEnding(undefined)), []);
});

test("explicit mode: thank-you alone is not a goodbye; end only on clear intent", () => {
  const rules = callEndingRules(normalizeCallEnding({ enabled: true, mode: "explicit" })).join("\n");
  assert.match(rules, /ONLY when the caller clearly says goodbye/);
  assert.match(rules, /standalone "thank you" .* NOT a goodbye/);
  assert.match(rules, /that's all, goodbye/);
  assert.match(rules, /I don't need anything else/);
});

test("automatic mode ends on clear completion but still guards bare thank-you", () => {
  const rules = callEndingRules(normalizeCallEnding({ enabled: true, mode: "automatic" })).join("\n");
  assert.match(rules, /clearly indicates the conversation is finished/);
  assert.match(rules, /standalone "thank you" .* NOT by itself the end/);
});

test("manual mode: no end_call, the caller hangs up", () => {
  const rules = callEndingRules(normalizeCallEnding({ enabled: true, mode: "manual" }));
  assert.equal(rules.length, 1);
  assert.match(rules[0], /never end the call yourself/);
  assert.doesNotMatch(rules[0], /end_call tool with/);
});

test("confirm-before-ending asks ONCE and never re-asks after a clear no", () => {
  const withConfirm = callEndingRules(normalizeCallEnding({ enabled: true, confirmBeforeEnding: true })).join("\n");
  assert.match(withConfirm, /ask once whether the caller needs anything else/);
  assert.match(withConfirm, /NEVER ask if they already said they need nothing else/);
  const without = callEndingRules(normalizeCallEnding({ enabled: true, confirmBeforeEnding: false })).join("\n");
  assert.doesNotMatch(without, /ask once whether the caller needs anything else/);
  assert.doesNotMatch(without, /BEFORE ENDING/);
});

test("the LLM is told not to speak its own goodbye and to keep helping on interruption", () => {
  const rules = callEndingRules(normalizeCallEnding({ enabled: true })).join("\n");
  assert.match(rules, /Do NOT speak a goodbye yourself/);
  assert.match(rules, /booking_confirmed only if a booking tool actually succeeded/);
  assert.match(rules, /IF THE CALLER SPEAKS during the closing message .* call stays open/);
  assert.match(rules, /ONE clarifying question instead of ending/);
});

// ── silence-timeout mapping ──────────────────────────────────────────────────
const LEGACY = { silenceBeforeCheck: 60, maxCheckAttempts: 4, maxSilenceDuration: 120, maxCallMinutes: 60 };

test("feature off leaves the legacy lifecycle limits untouched", () => {
  assert.deepEqual(applySilencePolicy(LEGACY, normalizeCallEnding(undefined)), LEGACY);
});

test("an enabled silence timeout checks in before the cut", () => {
  const out = applySilencePolicy(LEGACY, normalizeCallEnding({ enabled: true, silenceTimeoutSec: 30 }));
  assert.equal(out.maxSilenceDuration, 30);
  assert.equal(out.silenceBeforeCheck, 15);           // "are you still there?" comes first
  assert.ok(out.maxCheckAttempts >= 1);
  assert.equal(out.maxCallMinutes, 60);               // untouched
  // Even the shortest option keeps a sane check-in window.
  const short = applySilencePolicy(LEGACY, normalizeCallEnding({ enabled: true, silenceTimeoutSec: 15 }));
  assert.equal(short.silenceBeforeCheck, 7);
  assert.equal(short.maxSilenceDuration, 15);
});

test("silence 'Disabled' means silence never ends the call", () => {
  const out = applySilencePolicy(LEGACY, normalizeCallEnding({ enabled: true, silenceTimeoutSec: 0 }));
  assert.ok(out.maxSilenceDuration >= 24 * 60 * 60);
  assert.ok(out.maxCheckAttempts >= 1_000_000);
});
