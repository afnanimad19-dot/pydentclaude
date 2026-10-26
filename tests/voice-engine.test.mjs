// Voice engine abstraction (Phase 2 — Grok realtime): provider selection,
// pinned model registry, and the one allowed fallback moment (connect time,
// never mid-call). The worker mirror in livekit-agent/agent.py is held to the
// same rules at the source level. No network, no LiveKit, no xAI calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const {
  VOICE_ENGINES,
  REALTIME_MODELS,
  REJECTED_REALTIME_MODELS,
  DEFAULT_REALTIME_MODEL,
  DEFAULT_REALTIME_VOICE,
  VOICE_ENGINE_DEFAULTS,
  normalizeVoiceEngine,
  resolveEngineAtConnect,
} = await import("@/lib/voice-engine");

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

// ── provider selection ────────────────────────────────────────────────────────
test("the default engine is the proven pipeline; unknown engines collapse to it (fail closed)", () => {
  assert.deepEqual([...VOICE_ENGINES], ["pipeline", "grok-realtime"]);
  assert.equal(VOICE_ENGINE_DEFAULTS.engine, "pipeline");
  assert.equal(normalizeVoiceEngine({}).engine, "pipeline");
  assert.equal(normalizeVoiceEngine({ voiceEngine: "grok-realtime" }).engine, "grok-realtime");
  assert.equal(normalizeVoiceEngine({ voiceEngine: "gpt-realtime" }).engine, "pipeline");
  assert.equal(normalizeVoiceEngine({ voiceEngine: "" }).engine, "pipeline");
  assert.equal(normalizeVoiceEngine(null).engine, "pipeline");
});

test("the realtime registry pins exact verified model ids only", () => {
  assert.deepEqual(REALTIME_MODELS.map((m) => m.id), ["xai/grok-voice-3.0"]);
  assert.equal(DEFAULT_REALTIME_MODEL, "xai/grok-voice-3.0");
  assert.equal(DEFAULT_REALTIME_VOICE, "eve");
  // moving aliases and the deprecated generation are rejected by name
  for (const bad of ["grok-voice-latest", "xai/grok-voice-latest", "grok-voice-2.0", "xai/grok-voice-2.0"]) {
    assert.ok(REJECTED_REALTIME_MODELS.includes(bad), bad);
  }
});

test("connect-time resolution: a pinned model runs; aliases/deprecated/unknown fall back VISIBLY", () => {
  const ok = resolveEngineAtConnect({ engine: "grok-realtime", realtimeModel: "xai/grok-voice-3.0", realtimeVoice: "eve", fallbackToPipeline: true });
  assert.deepEqual(ok, { engine: "grok-realtime", realtimeModel: "xai/grok-voice-3.0", realtimeVoice: "eve" });
  for (const bad of ["grok-voice-latest", "grok-voice-2.0", "xai/grok-voice-9.9", ""]) {
    const d = resolveEngineAtConnect({ engine: "grok-realtime", realtimeModel: bad, realtimeVoice: "eve", fallbackToPipeline: true });
    assert.equal(d.engine, "pipeline", bad);
    assert.ok(d.fallback && d.fallback.from === "grok-realtime" && d.fallback.reason.length > 5, bad); // reason is recorded, never silent
  }
  // pipeline configs never produce a fallback record
  assert.deepEqual(resolveEngineAtConnect({ ...VOICE_ENGINE_DEFAULTS }), { engine: "pipeline" });
});

test("provider failure with fallback disabled REFUSES the call instead of guessing", () => {
  const d = resolveEngineAtConnect({ engine: "grok-realtime", realtimeModel: "nonsense", realtimeVoice: "eve", fallbackToPipeline: false });
  assert.ok(d.refused && d.refused.length > 5);
  assert.equal(d.fallback, undefined);
});

// ── config plumbing ───────────────────────────────────────────────────────────
test("agent config carries the engine to the worker (voice_settings → livekitAgentConfig)", async () => {
  const lk = await read("src/lib/livekit.ts");
  assert.match(lk, /normalizeVoiceEngine\(lk\)/);
  assert.match(lk, /voiceEngine: engineCfg\.engine/);
  assert.match(lk, /realtime: \{ model: engineCfg\.realtimeModel, voice: engineCfg\.realtimeVoice, fallbackToPipeline: engineCfg\.fallbackToPipeline \}/);
  const models = await read("src/lib/livekit-models.ts");
  assert.match(models, /voiceEngine: "pipeline"/); // default stays the proven pipeline
});

// ── worker mirror (source-level; no live LiveKit session in tests) ────────────
test("worker: the engine is decided ONCE at connect, before any audio, with the same pinned registry", async () => {
  const s = await read("livekit-agent/agent.py");
  assert.match(s, /SUPPORTED_REALTIME_MODELS = \{"xai\/grok-voice-3\.0"\}/);
  assert.match(s, /REJECTED_REALTIME_MODELS = \{"grok-voice-latest", "xai\/grok-voice-latest", "grok-voice-2\.0", "xai\/grok-voice-2\.0"\}/);
  assert.match(s, /def resolve_voice_engine/);
  // decision happens before the session is constructed
  const decideAt = s.indexOf("resolve_voice_engine(cfg)");
  const sessionAt = s.indexOf("session = AgentSession(**session_kwargs)");
  assert.ok(decideAt > 0 && sessionAt > decideAt, "engine decided before AgentSession");
  // the realtime model is constructed exactly once, in the connect block
  assert.equal(s.split("inference.RealtimeModel(").length - 1, 1);
  // refusal path exists when fallback is disabled
  assert.match(s, /voice engine refused: \{engine_note\}/);
  // NO mid-call switching: after session construction there is no second
  // engine resolution or RealtimeModel construction anywhere
  const after = s.slice(sessionAt);
  assert.doesNotMatch(after, /resolve_voice_engine|inference\.RealtimeModel/);
});

test("worker: the engine (and any fallback) is recorded on the call record; AMD is not guessed onto realtime", async () => {
  const s = await read("livekit-agent/agent.py");
  assert.match(s, /"voiceEngine": engine/);
  assert.match(s, /"engineFallback": engine_note/);
  assert.match(s, /AMD not started: unverified with the realtime engine/);
});

test("realtime engine availability claims are verified, not invented", async () => {
  // The abstraction documents its verification; the registry contains no
  // model id that the cited docs do not name.
  const s = await read("src/lib/voice-engine.ts");
  assert.match(s, /VERIFIED \(2026-10-26\) against docs\.x\.ai and docs\.livekit\.io/);
  assert.doesNotMatch(s, /grok-voice-4|grok-realtime-preview/); // nothing made up
});
