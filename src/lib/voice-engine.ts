// Voice engine abstraction (Phase 2 — Grok realtime integration). Pure,
// client-safe decision logic: which engine a call runs on, and the ONLY
// moment a fallback may happen (at connect, before the agent has said a
// word). There is deliberately NO mid-call switching: swapping models during
// a live call could lose conversation context or duplicate tool actions
// (double bookings), so a fatal engine error mid-call ends the call cleanly
// through the normal end_call path instead.
//
// VERIFIED (2026-10-26) against docs.x.ai and docs.livekit.io:
//   * The Grok Voice Agent API is a turn-based speech-to-speech realtime
//     model, OpenAI-Realtime-compatible, with server-VAD barge-in and
//     function tools. Arabic (ar-AE among others) is supported; input
//     language is auto-detected.
//   * LiveKit Agents reaches it two ways: LiveKit Inference
//     (inference.RealtimeModel, model "xai/grok-voice-3.0", billed through
//     LiveKit Cloud — the same credentials the worker already uses, which is
//     why it is the default path) or the livekit-agents[xai] plugin with a
//     separate XAI_API_KEY ("grok-voice-3.0").
//   * "grok-voice-3.0" is the flagship; "grok-voice-latest" is a moving
//     alias (refused here — production pins exact versions); grok-voice-2.0
//     is deprecated (refused).

export const VOICE_ENGINES = ["pipeline", "grok-realtime"] as const;
export type VoiceEngine = (typeof VOICE_ENGINES)[number];

/** Realtime models the worker is allowed to run, by exact pinned id. */
export const REALTIME_MODELS: { id: string; label: string }[] = [
  { id: "xai/grok-voice-3.0", label: "Grok Voice 3.0 (realtime speech-to-speech · Arabic supported)" },
];

export const DEFAULT_REALTIME_MODEL = "xai/grok-voice-3.0";
/** Grok Voice built-in voice; see xAI's voice table for the full roster. */
export const DEFAULT_REALTIME_VOICE = "eve";

/** Moving aliases and deprecated generations are refused outright: a
 *  production call must never silently change model generation. */
export const REJECTED_REALTIME_MODELS = [
  "grok-voice-latest",
  "xai/grok-voice-latest",
  "grok-voice-2.0",
  "xai/grok-voice-2.0",
] as const;

export interface VoiceEngineConfig {
  engine: VoiceEngine;
  realtimeModel: string;
  realtimeVoice: string;
  /** Fall back to the proven pipeline AT CONNECT TIME if the realtime engine
   *  cannot start. Never mid-call. */
  fallbackToPipeline: boolean;
}

export const VOICE_ENGINE_DEFAULTS: VoiceEngineConfig = {
  engine: "pipeline",
  realtimeModel: DEFAULT_REALTIME_MODEL,
  realtimeVoice: DEFAULT_REALTIME_VOICE,
  fallbackToPipeline: true,
};

/** Normalize stored settings (agents.voice_settings.livekit.*). Anything
 *  unrecognized collapses to the proven pipeline (fail closed). */
export function normalizeVoiceEngine(raw: unknown): VoiceEngineConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const engine = (VOICE_ENGINES as readonly string[]).includes(String(r.voiceEngine ?? "")) ? (String(r.voiceEngine) as VoiceEngine) : "pipeline";
  const model = String(r.realtimeModel ?? "").trim() || DEFAULT_REALTIME_MODEL;
  const voice = String(r.realtimeVoice ?? "").trim() || DEFAULT_REALTIME_VOICE;
  return {
    engine,
    realtimeModel: model,
    realtimeVoice: voice,
    fallbackToPipeline: r.realtimeFallback !== false,
  };
}

export interface EngineConnectDecision {
  engine: VoiceEngine;
  /** Set only for grok-realtime. */
  realtimeModel?: string;
  realtimeVoice?: string;
  /** Present when the configured engine was replaced at connect time. */
  fallback?: { from: VoiceEngine; reason: string };
  /** Present when the call must be refused instead (no safe engine). */
  refused?: string;
}

/**
 * The ONE place an engine substitution may happen: before the session is
 * built, before any audio. A realtime config that cannot run (unknown or
 * unpinned model, deprecated generation) falls back to the pipeline when
 * allowed — visibly, with the reason recorded for the call log — or refuses
 * the call when fallback is disabled. Mid-call there is no switching, ever.
 */
export function resolveEngineAtConnect(cfg: VoiceEngineConfig): EngineConnectDecision {
  if (cfg.engine !== "grok-realtime") return { engine: "pipeline" };
  const model = String(cfg.realtimeModel ?? "").trim();
  const known = REALTIME_MODELS.some((m) => m.id === model);
  const rejected = (REJECTED_REALTIME_MODELS as readonly string[]).includes(model);
  if (known && !rejected) {
    return { engine: "grok-realtime", realtimeModel: model, realtimeVoice: cfg.realtimeVoice || DEFAULT_REALTIME_VOICE };
  }
  const reason = rejected
    ? `realtime model "${model}" is a moving alias or deprecated generation (pin ${DEFAULT_REALTIME_MODEL})`
    : `realtime model "${model}" is not in the pinned allowlist`;
  if (cfg.fallbackToPipeline) return { engine: "pipeline", fallback: { from: "grok-realtime", reason } };
  return { engine: "pipeline", refused: reason };
}
