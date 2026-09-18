// LiveKit Builder configuration import: parsing, truth-status, model mapping,
// secret redaction, and the never-clobber merge rules.

import { test } from "node:test";
import assert from "node:assert/strict";

const { parseBuilderExport, mapBuilderModels, callEndingText, mergeImportedAgent, BUILDER_FIELDS } =
  await import("@/lib/livekit-builder-import");

const LAURA_EXPORT = JSON.stringify({
  agent_name: "receptionist-livekit-laura",
  instructions: "You are Laura, the receptionist for Leila Hariri Dental...",
  welcome_message: "Hello! Thank you for calling Leila Hariri Dental.",
  welcome_enabled: true,
  allow_interruptions: true,
  pipeline: "stt-llm-tts",
  stt: { provider: "xai", model: "speech-to-text", language: "English" },
  llm: { provider: "openai", model: "gpt-5.6-luna", reasoning_effort: "low" },
  tts: { provider: "cartesia", model: "sonic-3.6", voice: "Ariana", language: "en-US" },
  background_audio: "none",
  end_call: true,
  final_response: "Only end the call after the caller has received the requested information. Before ending, restate what will happen next.",
  api_key: "sk-SHOULD-NEVER-SURVIVE",
});

test("a full Builder JSON export parses with every present field marked imported", () => {
  const { snapshot, status } = parseBuilderExport(LAURA_EXPORT);
  assert.equal(status.instructions, "imported");
  assert.equal(status.welcomeMessage, "imported");
  assert.equal(status.greetingInterruptible, "imported");
  assert.equal(status.endCallFinalResponse, "imported");
  assert.equal(status.stt, "imported");
  assert.equal(status.llm, "imported");
  assert.equal(status.tts, "imported");
  assert.equal(status.voice, "imported");
  assert.equal(snapshot.welcomeMessage, "Hello! Thank you for calling Leila Hariri Dental.");
  assert.equal(snapshot.reasoningEffort, "low");
  assert.equal(snapshot.voice, "Ariana");
  assert.equal(snapshot.tts, "cartesia/sonic-3.6");
});

test("fields absent from the export stay unavailable — never fabricated", () => {
  const { snapshot, status } = parseBuilderExport('{"instructions": "hi"}');
  assert.equal(status.instructions, "imported");
  for (const f of BUILDER_FIELDS.filter((x) => x !== "instructions")) {
    assert.equal(status[f], "unavailable", f);
  }
  assert.equal(Object.keys(snapshot).length, 1);
});

test("secret-looking keys are dropped and never reach the snapshot", () => {
  const { snapshot } = parseBuilderExport(LAURA_EXPORT);
  assert.ok(!JSON.stringify(snapshot).includes("SHOULD-NEVER-SURVIVE"));
});

test("non-JSON paste becomes instructions only, with a warning", () => {
  const { snapshot, status, warnings } = parseBuilderExport("You are Laura. Be kind.");
  assert.equal(snapshot.instructions, "You are Laura. Be kind.");
  assert.equal(status.instructions, "imported");
  assert.equal(status.tts, "unavailable");
  assert.equal(warnings.length, 1);
});

test("empty paste imports nothing", () => {
  const { snapshot } = parseBuilderExport("   ");
  assert.deepEqual(snapshot, {});
});

test("model mapping: known models map to catalog ids, unknown stay unmapped with a warning", () => {
  const m = mapBuilderModels({
    stt: "Deepgram Nova-3",
    llm: "openai/gpt-5.6-luna", // not in the catalog — must NOT be guessed
    tts: "Cartesia Sonic 3.6",
    voice: "Ariana",
  });
  assert.equal(m.stt, "deepgram/nova-3");
  assert.equal(m.tts, "cartesia/sonic-3.6");
  assert.equal(m.llm, undefined);
  assert.ok(m.warnings.some((w) => w.includes("gpt-5.6-luna")));
  assert.equal(m.voice, "Ariana");
});

test("an exact inference id passes through unchanged", () => {
  const m = mapBuilderModels({ llm: "openai/gpt-4.1-mini", stt: "deepgram/nova-3" });
  assert.equal(m.llm, "openai/gpt-4.1-mini");
  assert.equal(m.stt, "deepgram/nova-3");
  assert.equal(m.warnings.length, 0);
});

test("call-ending settings become an editable guardrails block", () => {
  const t = callEndingText({ endCallConditions: "caller confirmed next step", endCallFinalResponse: "restate what happens next" });
  assert.match(t, /CALL ENDING — end the call only when: caller confirmed next step/);
  assert.match(t, /CALL ENDING — before ending: restate what happens next/);
  assert.equal(callEndingText({}), "");
});

test("merge never overwrites populated fields with empty/undefined and preserves tools + KB", () => {
  const existing = {
    name: "Laura",
    instructions: "existing prompt",
    firstMessage: "existing greeting",
    canBook: true,
    canReschedule: true,
    canCancel: false,
    kbFiles: ["doc1.pdf", "doc2.md"],
    knowledgeBase: "--- doc1.pdf ---\nfacts",
  };
  const merged = mergeImportedAgent(existing, {
    instructions: "",        // unavailable -> must not clobber
    firstMessage: undefined, // unavailable -> must not clobber
    name: "Laura Imported",  // real value -> may update
  });
  assert.equal(merged.instructions, "existing prompt");
  assert.equal(merged.firstMessage, "existing greeting");
  assert.equal(merged.name, "Laura Imported");
  assert.equal(merged.canBook, true);
  assert.equal(merged.canCancel, false);
  assert.deepEqual(merged.kbFiles, ["doc1.pdf", "doc2.md"]);
  assert.equal(merged.knowledgeBase, "--- doc1.pdf ---\nfacts");
});

test("builderImport metadata survives a normalizeVoiceSettings round trip", async () => {
  const { normalizeVoiceSettings } = await import("@/lib/agent-config");
  const meta = { source: "livekit-builder", agentName: "receptionist-livekit-laura", importedAt: "2026-09-18T00:00:00Z", fields: { instructions: "imported" } };
  const v = normalizeVoiceSettings({ builderImport: meta, livekit: { agentName: "receptionist-livekit-laura" } });
  assert.deepEqual(v.builderImport, meta);
  const again = normalizeVoiceSettings(v);
  assert.deepEqual(again.builderImport, meta);
  assert.equal(again.livekit.agentName, "receptionist-livekit-laura");
});
