// Contract tests for the shared agent-configuration module: defaults,
// backward compatibility with agents saved before these settings existed,
// clamping of out-of-range values, tool gating and cross-field validation.
//
//   npm test
//
// Run with Node's built-in test runner + TypeScript stripping; tests/alias-loader
// resolves the "@/..." path alias the same way Next does, so there is no build
// step and the tests import exactly the code that ships.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeVoiceSettings,
  validateVoiceSettings,
  defaultToolState,
  AGENT_TOOLS,
  RANGES,
  AGENT_CONFIG_VERSION,
} from "@/lib/agent-config";

test("an empty blob normalizes to the documented defaults", () => {
  const v = normalizeVoiceSettings({});
  assert.equal(v.minSpeechDuration, RANGES.minSpeechDuration.def);
  assert.equal(v.minSilenceDuration, RANGES.minSilenceDuration.def);
  assert.equal(v.activationThreshold, RANGES.activationThreshold.def);
  assert.equal(v.prefixPaddingDuration, RANGES.prefixPaddingDuration.def);
  assert.equal(v.endOfSpeechTimeout, RANGES.endOfSpeechTimeout.def);
  assert.equal(v.turnDetectionEnabled, true);
  assert.equal(v.detectionMode, "smart");
  assert.equal(v.dataStorage, "store_analyze");
  assert.equal(v.backgroundAudio, "none");
  assert.equal(v.configVersion, AGENT_CONFIG_VERSION);
});

test("values persist through a normalize round trip", () => {
  const saved = normalizeVoiceSettings({
    minSilenceDuration: 0.8,
    activationThreshold: 0.7,
    detectionMode: "fixed",
    detectionTimeout: 3.5,
    noiseReductionEnabled: true,
    reductionLevel: "high",
    maxCallDuration: 15,
    backgroundAudio: "office",
    dataStorage: "store_only",
  });
  const reopened = normalizeVoiceSettings(saved);
  assert.deepEqual(reopened, saved);
  assert.equal(reopened.reductionLevel, "high");
  assert.equal(reopened.maxCallDuration, 15);
  assert.equal(reopened.backgroundAudio, "office");
});

test("out-of-range and junk values are clamped, never passed through", () => {
  const v = normalizeVoiceSettings({
    minSilenceDuration: 9999,
    activationThreshold: -4,
    maxCallDuration: "not a number",
    detectionMode: "telepathy",
    reductionLevel: "nuclear",
    dataStorage: "sell_it",
    backgroundAudio: "airhorn",
  });
  assert.equal(v.minSilenceDuration, RANGES.minSilenceDuration.max);
  assert.equal(v.activationThreshold, RANGES.activationThreshold.min);
  assert.equal(v.maxCallDuration, RANGES.maxCallDuration.def);
  assert.equal(v.detectionMode, "smart");
  assert.equal(v.reductionLevel, "medium");
  assert.equal(v.dataStorage, "store_analyze");
  assert.equal(v.backgroundAudio, "none");
});

test("a null/garbage blob still produces a usable config", () => {
  for (const junk of [null, undefined, 0, "", [], "nope"]) {
    const v = normalizeVoiceSettings(junk);
    assert.equal(v.configVersion, AGENT_CONFIG_VERSION);
    assert.equal(validateVoiceSettings(v).length, 0);
  }
});

test("legacy agents inherit tool state from can_book / can_reschedule / can_cancel", () => {
  const legacy = { canBook: true, canReschedule: false, canCancel: false };
  const v = normalizeVoiceSettings({}, legacy);
  assert.equal(v.tools.book_appointment, true);
  assert.equal(v.tools.get_available_slots, true);
  assert.equal(v.tools.reschedule_appointment, false);
  assert.equal(v.tools.cancel_appointment, false);
  assert.equal(v.tools.end_call, true, "end_call is always on");
});

test("every catalogued tool gets a state, and end_call cannot be switched off", () => {
  const v = normalizeVoiceSettings({ tools: { end_call: false } });
  for (const t of AGENT_TOOLS) assert.equal(typeof v.tools[t.id], "boolean", t.id);
  assert.equal(v.tools.end_call, true);
});

test("transfer_call is forced off until a transfer number exists", () => {
  const without = normalizeVoiceSettings({ tools: { transfer_call: true } });
  assert.equal(without.tools.transfer_call, false);
  const with_ = normalizeVoiceSettings({ tools: { transfer_call: true }, transferNumber: "+97141234567" });
  assert.equal(with_.tools.transfer_call, true);
});

test("defaultToolState with no legacy flags enables everything except transfer", () => {
  const s = defaultToolState();
  assert.equal(s.transfer_call, false);
  assert.equal(s.send_email, true);
  assert.equal(s.lookup_patient, true);
});

test("extraction fields: legacy \"string\" becomes \"text\", nameless fields are dropped", () => {
  const v = normalizeVoiceSettings({
    extractionFields: [
      { name: "Caller name", description: "who called", type: "string" },
      { name: "", description: "no name", type: "text" },
      { name: "Outcome", description: "", type: "enum", options: [" booked ", "", "none"] },
      { name: "Age", description: "", type: "wombat" },
      "not an object",
    ],
  });
  assert.equal(v.extractionFields.length, 3);
  assert.equal(v.extractionFields[0].type, "text");
  assert.deepEqual(v.extractionFields[1].options, ["booked", "none"]);
  assert.equal(v.extractionFields[2].type, "text", "unknown types fall back to text");
});

test("barge-in mode migrates from the legacy livekit.interruptions string", () => {
  const v = normalizeVoiceSettings({ livekit: { interruptions: "eager" } });
  assert.equal(v.interruptions.mode, "eager");
  assert.equal(v.interruptions.minDuration, 0.2, "eager preset");
  assert.equal(v.interruptions.minWords, 0);
  // and the legacy key stays in step so anything still reading it agrees
  assert.equal(v.livekit.interruptions, "eager");
});

test("explicit barge-in values win over the mode preset and are clamped", () => {
  const v = normalizeVoiceSettings({ interruptions: { mode: "adaptive", minDuration: 99, minWords: 2, resumeFalseInterruption: false } });
  assert.equal(v.interruptions.minDuration, RANGES.interruptionMinDuration.max);
  assert.equal(v.interruptions.minWords, 2);
  assert.equal(v.interruptions.resumeFalseInterruption, false);
});

test("validation catches the cross-field mistakes the UI can make", () => {
  const bad = normalizeVoiceSettings({ silenceBeforeCheck: 300, maxSilenceDuration: 60 });
  assert.match(validateVoiceSettings(bad).join(" "), /Max silence duration/);

  const dup = normalizeVoiceSettings({
    extractionFields: [
      { name: "Outcome", description: "", type: "text" },
      { name: "outcome", description: "", type: "text" },
    ],
  });
  assert.match(validateVoiceSettings(dup).join(" "), /Duplicate extraction field/);

  const timeout = normalizeVoiceSettings({ endOfSpeechTimeout: 2.5, detectionTimeout: 1 });
  assert.match(validateVoiceSettings(timeout).join(" "), /Turn-detection timeout/);
});

test("a sane config has no validation errors", () => {
  assert.deepEqual(validateVoiceSettings(normalizeVoiceSettings({})), []);
});
