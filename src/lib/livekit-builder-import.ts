// Import of a LiveKit Agent Builder configuration into Pydent.
//
// What LiveKit's public API exposes for a Builder agent — verified against
// livekit_cloud_agent.proto and the lk CLI — is identity ONLY: agent id, name,
// version, deployment status and secret NAMES. The Builder's instructions,
// welcome message, models, voice and call-ending settings are not returned by
// any CloudAgent method. So the import works from two truthful sources:
//
//   1. the API, for agent identity (imported automatically), and
//   2. a Builder export/snapshot the user pastes (the builder's JSON, or the
//      raw instructions text) — parsed here, with EVERY field tracked as
//      "imported" or "unavailable". Nothing is fabricated: a field that was
//      not found stays unavailable and never overwrites existing Pydent data.
//
// Client-safe: no server imports, pure functions, unit-tested in
// tests/builder-import.test.mjs.

import { LIVEKIT_STT, LIVEKIT_LLM, LIVEKIT_TTS } from "@/lib/livekit-models";

export const BUILDER_FIELDS = [
  "instructions",
  "welcomeMessage",
  "welcomeEnabled",
  "greetingInterruptible",
  "endCallEnabled",
  "endCallConditions",
  "endCallFinalResponse",
  "pipeline",
  "stt",
  "sttLanguage",
  "llm",
  "reasoningEffort",
  "tts",
  "voice",
  "voiceLanguage",
  "noiseCancellation",
  "backgroundAudio",
] as const;
export type BuilderField = (typeof BUILDER_FIELDS)[number];
export type FieldStatus = "imported" | "unavailable";

export interface BuilderSnapshot {
  instructions?: string;
  welcomeMessage?: string;
  welcomeEnabled?: boolean;
  greetingInterruptible?: boolean;
  endCallEnabled?: boolean;
  endCallConditions?: string;
  endCallFinalResponse?: string;
  pipeline?: string;
  stt?: string; // raw Builder string, e.g. "xAI Speech to Text"
  sttLanguage?: string;
  llm?: string;
  reasoningEffort?: string;
  tts?: string;
  voice?: string;
  voiceLanguage?: string;
  noiseCancellation?: boolean;
  backgroundAudio?: string;
}

export interface ParsedBuilderExport {
  snapshot: BuilderSnapshot;
  status: Record<BuilderField, FieldStatus>;
  warnings: string[];
}

const SECRET_KEY = /secret|token|api[-_]?key|authorization|password|bearer|credential/i;

function norm(key: string): string {
  return key.toLowerCase().replace(/[\s_-]+/g, "");
}

/** Deep-walk a parsed JSON object collecting values by normalized key name.
 *  Secret-looking keys are dropped entirely — they must never be persisted. */
function collect(obj: unknown, out: Map<string, unknown>, depth = 0): void {
  if (depth > 6 || !obj || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SECRET_KEY.test(k)) continue;
    const nk = norm(k);
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      // Keep the sub-object reachable under its own name (stt/llm/tts blocks).
      if (!out.has(nk)) out.set(nk, v);
      collect(v, out, depth + 1);
    } else if (!out.has(nk) && (typeof v === "string" || typeof v === "boolean" || typeof v === "number")) {
      out.set(nk, v);
    }
  }
}

function firstString(m: Map<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = m.get(norm(k));
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function firstBool(m: Map<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const k of keys) {
    const v = m.get(norm(k));
    if (typeof v === "boolean") return v;
    if (v === "true" || v === "enabled" || v === "on") return true;
    if (v === "false" || v === "disabled" || v === "off" || v === "none") return false;
  }
  return undefined;
}

/** provider/model description of an stt/llm/tts block, whatever its shape. */
function modelString(m: Map<string, unknown>, block: string, ...fallbackKeys: string[]): string | undefined {
  const sub = m.get(norm(block));
  if (sub && typeof sub === "object") {
    const s = new Map<string, unknown>();
    collect(sub, s);
    const provider = firstString(s, "provider");
    const model = firstString(s, "model", "name", "modelid");
    if (provider && model) return /\//.test(model) ? model : `${provider}/${model}`;
    if (model) return model;
    if (provider) return provider;
  }
  const flat = firstString(m, ...fallbackKeys);
  return flat;
}

function subField(m: Map<string, unknown>, block: string, ...keys: string[]): string | undefined {
  const sub = m.get(norm(block));
  if (!sub || typeof sub !== "object") return undefined;
  const s = new Map<string, unknown>();
  collect(sub, s);
  return firstString(s, ...keys);
}

/**
 * Parse whatever the user pasted from the Builder.
 * JSON (optionally in a ``` fence) is mined for known settings; anything that
 * is not JSON is treated as the raw instructions text and nothing more.
 */
export function parseBuilderExport(text: string): ParsedBuilderExport {
  const status = Object.fromEntries(BUILDER_FIELDS.map((f) => [f, "unavailable"])) as Record<BuilderField, FieldStatus>;
  const warnings: string[] = [];
  const snapshot: BuilderSnapshot = {};
  const raw = (text ?? "").trim();
  if (!raw) return { snapshot, status, warnings };

  const unfenced = raw.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    // Not JSON — the only thing we can honestly take is the instructions text.
    snapshot.instructions = raw;
    status.instructions = "imported";
    warnings.push("The pasted text is not a JSON export — it was imported as the Instructions prompt only.");
    return { snapshot, status, warnings };
  }

  const m = new Map<string, unknown>();
  collect(parsed, m);

  const set = <K extends BuilderField>(field: K, value: BuilderSnapshot[K] | undefined) => {
    if (value === undefined || value === "") return;
    (snapshot as Record<string, unknown>)[field] = value;
    status[field] = "imported";
  };

  set("instructions", firstString(m, "instructions", "prompt", "system_prompt", "systemprompt", "system"));
  set("welcomeMessage", firstString(m, "welcome_message", "welcomemessage", "greeting", "first_message", "welcome"));
  set("welcomeEnabled", firstBool(m, "welcome_enabled", "welcome_message_enabled", "greeting_enabled"));
  set("greetingInterruptible", firstBool(m, "allow_interruptions", "greeting_interruptible", "interrupt_greeting", "allow_users_to_interrupt"));
  set("endCallEnabled", firstBool(m, "end_call_enabled", "end_call", "endcall"));
  set("endCallConditions", firstString(m, "end_call_conditions", "endcallconditions", "conditions"));
  set("endCallFinalResponse", firstString(m, "final_response", "finalresponse", "final_response_instructions", "closing"));
  set("pipeline", firstString(m, "pipeline", "mode"));
  set("stt", modelString(m, "stt", "stt_model", "sttmodel", "speech_to_text"));
  set("sttLanguage", subField(m, "stt", "language") ?? firstString(m, "stt_language"));
  set("llm", modelString(m, "llm", "llm_model", "llmmodel", "language_model"));
  set("reasoningEffort", subField(m, "llm", "reasoning_effort", "reasoning") ?? firstString(m, "reasoning_effort"));
  set("tts", modelString(m, "tts", "tts_model", "ttsmodel", "text_to_speech"));
  set("voice", subField(m, "tts", "voice", "voice_id", "voicename") ?? firstString(m, "voice", "voice_id"));
  set("voiceLanguage", subField(m, "tts", "language", "locale") ?? firstString(m, "voice_language", "locale"));
  set("noiseCancellation", firstBool(m, "noise_cancellation", "noisecancellation", "noise_suppression"));
  const bg = firstString(m, "background_audio", "backgroundaudio", "ambient_audio");
  if (bg !== undefined) set("backgroundAudio", bg);
  else {
    const bgBool = firstBool(m, "background_audio", "backgroundaudio");
    if (bgBool === false) set("backgroundAudio", "none");
  }

  if (Object.keys(snapshot).length === 0) {
    warnings.push("Valid JSON, but no recognizable Builder settings were found in it.");
  }
  return { snapshot, status, warnings };
}

// ── Model mapping: Builder display strings -> LiveKit Inference ids ─────────
// Only KNOWN mappings are made; an unrecognized model is left unmapped (with a
// warning) rather than guessed — the user picks a supported model in the
// editor. A raw "provider/model" id is passed through as-is.

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9./-]+/g, " ").split(/\s+/).filter(Boolean);
}

function matchCatalog(rawValue: string, catalog: { id: string; label: string }[]): string | undefined {
  const raw = rawValue.trim();
  if (catalog.some((c) => c.id === raw)) return raw; // already an inference id
  const t = tokens(raw);
  let best: { id: string; score: number } | undefined;
  for (const c of catalog) {
    const hay = tokens(`${c.id} ${c.label}`);
    const score = t.filter((x) => hay.some((h) => h === x || h.includes(x))).length;
    if (score >= Math.max(2, t.length - 1) && (!best || score > best.score)) best = { id: c.id, score };
  }
  return best?.id;
}

export interface MappedModels {
  stt?: string;
  sttLanguage?: string;
  llm?: string;
  tts?: string;
  voice?: string;
  warnings: string[];
}

export function mapBuilderModels(s: BuilderSnapshot): MappedModels {
  const warnings: string[] = [];
  const out: MappedModels = { warnings };

  if (s.stt) {
    out.stt = matchCatalog(s.stt, LIVEKIT_STT);
    if (!out.stt) warnings.push(`STT "${s.stt}" has no match in Pydent's LiveKit model list — pick one in the editor.`);
  }
  if (s.sttLanguage) {
    const l = s.sttLanguage.toLowerCase();
    out.sttLanguage = l.startsWith("en") ? "en" : l.startsWith("ar") ? "ar" : l.slice(0, 2);
  }
  if (s.llm) {
    out.llm = matchCatalog(s.llm, LIVEKIT_LLM);
    if (!out.llm) warnings.push(`LLM "${s.llm}" has no match in Pydent's LiveKit model list — pick one in the editor.`);
  }
  if (s.tts) {
    out.tts = matchCatalog(s.tts, LIVEKIT_TTS);
    if (!out.tts) warnings.push(`TTS "${s.tts}" has no match in Pydent's LiveKit model list — pick one in the editor.`);
  }
  if (s.voice) out.voice = s.voice; // voice ids are free-text in Pydent's picker
  return out;
}

/** The call-ending settings become an editable STYLE GUARDRAILS block. */
export function callEndingText(s: BuilderSnapshot): string {
  const lines: string[] = [];
  if (s.endCallConditions) lines.push(`CALL ENDING — end the call only when: ${s.endCallConditions}`);
  if (s.endCallFinalResponse) lines.push(`CALL ENDING — before ending: ${s.endCallFinalResponse}`);
  return lines.join("\n");
}

/**
 * Merge imported values into an existing agent-shaped object.
 * RULES (spec): never overwrite a populated field with undefined/null/"" — an
 * unavailable Builder field changes nothing; tools/capabilities and knowledge
 * base fields are never touched by an import.
 */
export function mergeImportedAgent<T extends Record<string, unknown>>(existing: T, imported: Partial<T>): T {
  const out: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(imported)) {
    if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) continue;
    out[k] = v;
  }
  return out as T;
}
