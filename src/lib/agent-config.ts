// Advanced voice-agent configuration — the single source of truth shared by the
// browser (Edit Agent UI), the server (API validation) and the LiveKit worker
// contract. Everything lives in the existing `agents.voice_settings` JSONB blob,
// so adding a knob needs no migration and OLD AGENTS KEEP WORKING: any key an
// agent is missing is filled from the documented defaults by normalizeVoiceSettings().
//
// Every setting here reaches actual runtime behaviour in livekit-agent/agent.py.
// Where LiveKit exposes something different from the UI wording (noise
// reduction levels, for example) the mapping is documented next to the field.

import type { VoiceSettings, ExtractionField } from "@/lib/db";

export const AGENT_CONFIG_VERSION = 1;

// ── Tools ────────────────────────────────────────────────────────────────────
// The tools the worker can register with the LLM. `always` tools cannot be
// switched off (ending a call must always be possible). Legacy agents predate
// this list, so `defaultToolState` derives the initial on/off state from the
// agent's existing can_book / can_reschedule / can_cancel flags — nothing to
// re-configure after upgrading.
export interface AgentToolDef {
  id: string;
  label: string;
  description: string;
  always?: boolean;
  /** Legacy capability flag that decides this tool's default state. */
  legacyFlag?: "canBook" | "canReschedule" | "canCancel";
  /** Extra runtime requirement, surfaced in the UI when unmet. */
  requires?: "transferNumber";
}

export const AGENT_TOOLS: AgentToolDef[] = [
  { id: "end_call", label: "End call", description: "Let the agent hang up politely when the conversation is finished.", always: true },
  { id: "get_available_slots", label: "Check availability", description: "Look up real open appointment times before offering them.", legacyFlag: "canBook" },
  { id: "book_appointment", label: "Book appointment", description: "Create the appointment on the Pydent + Google calendar.", legacyFlag: "canBook" },
  { id: "reschedule_appointment", label: "Reschedule appointment", description: "Move the caller's upcoming appointment to a new time.", legacyFlag: "canReschedule" },
  { id: "cancel_appointment", label: "Cancel appointment", description: "Cancel the caller's upcoming appointment.", legacyFlag: "canCancel" },
  { id: "lookup_patient", label: "Look up patient", description: "Find an existing patient record by phone or name." },
  { id: "create_patient", label: "Create patient", description: "Add a new patient/lead record from the call." },
  { id: "send_email", label: "Send email", description: "Email the caller a confirmation or the details they asked for." },
  { id: "transfer_call", label: "Transfer to a human", description: "Warm-transfer the call to the clinic's number.", requires: "transferNumber" },
];

export type AgentToolState = Record<string, boolean>;

export function defaultToolState(agent?: { canBook?: boolean; canReschedule?: boolean; canCancel?: boolean }): AgentToolState {
  const state: AgentToolState = {};
  for (const t of AGENT_TOOLS) {
    if (t.always) { state[t.id] = true; continue; }
    if (t.legacyFlag) { state[t.id] = agent?.[t.legacyFlag] ?? true; continue; }
    // Tools with no legacy equivalent default ON except the transfer tool,
    // which needs a number configured before it can do anything.
    state[t.id] = t.requires !== "transferNumber";
  }
  return state;
}

// ── Background audio ─────────────────────────────────────────────────────────
// Real LiveKit BackgroundAudioPlayer clips (livekit.agents.BuiltinAudioClip).
export const BACKGROUND_AUDIO: { id: string; label: string }[] = [
  { id: "none", label: "None (silent)" },
  { id: "office", label: "Office ambience — quiet clinic reception" },
  { id: "city", label: "City ambience" },
  { id: "crowd", label: "Crowded room" },
  { id: "forest", label: "Forest ambience" },
];

// ── Ranges (enforced on BOTH the client sliders and the server) ──────────────
export const RANGES = {
  minSpeechDuration: { min: 0.0, max: 1.0, step: 0.01, def: 0.1 },
  minSilenceDuration: { min: 0.1, max: 3.0, step: 0.05, def: 0.3 },
  activationThreshold: { min: 0.1, max: 0.9, step: 0.05, def: 0.5 },
  prefixPaddingDuration: { min: 0.0, max: 3.0, step: 0.05, def: 0.3 },
  endOfSpeechTimeout: { min: 0.0, max: 3.0, step: 0.05, def: 0.2 },
  detectionTimeout: { min: 0.5, max: 10.0, step: 0.1, def: 2.0 },
  amdTimeout: { min: 5, max: 60, step: 1, def: 10 },
  silenceBeforeCheck: { min: 5, max: 600, step: 5, def: 60 },
  maxCheckAttempts: { min: 1, max: 10, step: 1, def: 4 },
  maxSilenceDuration: { min: 10, max: 1800, step: 10, def: 120 },
  maxCallDuration: { min: 1, max: 180, step: 1, def: 60 },
  interruptionMinDuration: { min: 0.0, max: 2.0, step: 0.05, def: 0.5 },
  interruptionMinWords: { min: 0, max: 5, step: 1, def: 1 },
} as const;

export type RangeKey = keyof typeof RANGES;

function clampNum(v: unknown, key: RangeKey): number {
  const r = RANGES[key];
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return r.def;
  return Math.min(r.max, Math.max(r.min, n));
}

function pickEnum<T extends string>(v: unknown, allowed: readonly T[], def: T): T {
  return allowed.includes(v as T) ? (v as T) : def;
}

const EXTRACTION_TYPES = ["text", "number", "boolean", "date", "datetime", "enum"] as const;
export type ExtractionType = (typeof EXTRACTION_TYPES)[number];

/** Legacy extraction fields used "string"; map it to "text". */
function normalizeExtractionField(f: unknown): (ExtractionField & { type: ExtractionType; options?: string[] }) | null {
  if (!f || typeof f !== "object") return null;
  const o = f as Record<string, unknown>;
  const name = String(o.name ?? "").trim().slice(0, 64);
  if (!name) return null; // a field with no name can never be extracted — drop it
  const rawType = o.type === "string" ? "text" : o.type;
  const type = pickEnum(rawType, EXTRACTION_TYPES, "text");
  const options = Array.isArray(o.options)
    ? (o.options as unknown[]).map((x) => String(x).trim()).filter(Boolean).slice(0, 40)
    : undefined;
  return {
    name,
    description: String(o.description ?? "").slice(0, 500),
    // ExtractionField in db.ts is the legacy narrow type; the widened type is
    // what we persist and what the worker consumes.
    type: type as ExtractionType,
    ...(type === "enum" && options?.length ? { options } : {}),
  } as ExtractionField & { type: ExtractionType; options?: string[] };
}

/**
 * Fill in defaults and clamp every value into a safe range.
 *
 * This is the ONLY place defaults live. It is called:
 *  - in the browser when opening the editor (so old agents show real values),
 *  - on save,
 *  - and server-side in livekitAgentConfig() before the worker ever sees it,
 * so a corrupt/hand-edited row can never crash the worker.
 */
export function normalizeVoiceSettings(
  raw: unknown,
  agent?: { canBook?: boolean; canReschedule?: boolean; canCancel?: boolean }
): VoiceSettings {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const transferNumber = String(v.transferNumber ?? "").trim().slice(0, 32);
  const toolsRaw = (v.tools && typeof v.tools === "object" ? v.tools : {}) as Record<string, unknown>;
  const defaults = defaultToolState(agent);
  const tools: AgentToolState = {};
  for (const t of AGENT_TOOLS) {
    const chosen = t.id in toolsRaw ? !!toolsRaw[t.id] : defaults[t.id];
    // A tool whose requirement isn't met can never run — force it off so the
    // LLM is not offered a tool that would fail.
    tools[t.id] = t.always ? true : t.requires === "transferNumber" && !transferNumber ? false : chosen;
  }

  // ── Interruptions / barge-in ──
  // The mode used to live at voice_settings.livekit.interruptions as a bare
  // string. It is read from there when the structured object is absent, so
  // agents saved before this build keep the barge-in behaviour they had.
  const legacyLk = (v.livekit && typeof v.livekit === "object" ? v.livekit : {}) as Record<string, unknown>;
  const iRaw = (v.interruptions && typeof v.interruptions === "object" ? v.interruptions : {}) as Record<string, unknown>;
  const iMode = pickEnum(iRaw.mode ?? legacyLk.interruptions, ["adaptive", "eager", "off"] as const, "adaptive");
  // Eager barge-in reacts on raw voice activity; adaptive waits for a word.
  const iDurDef = iMode === "eager" ? 0.2 : 0.5;
  const iWordsDef = iMode === "eager" ? 0 : 1;
  const interruptions = {
    mode: iMode,
    minDuration: iRaw.minDuration === undefined ? iDurDef : clampNum(iRaw.minDuration, "interruptionMinDuration"),
    minWords: iRaw.minWords === undefined ? iWordsDef : Math.round(clampNum(iRaw.minWords, "interruptionMinWords")),
    resumeFalseInterruption: iRaw.resumeFalseInterruption === undefined ? true : !!iRaw.resumeFalseInterruption,
  };

  const extractionFields = Array.isArray(v.extractionFields)
    ? (v.extractionFields as unknown[]).map(normalizeExtractionField).filter(Boolean).slice(0, 30)
    : [];

  return {
    minSpeechDuration: clampNum(v.minSpeechDuration, "minSpeechDuration"),
    minSilenceDuration: clampNum(v.minSilenceDuration, "minSilenceDuration"),
    activationThreshold: clampNum(v.activationThreshold, "activationThreshold"),
    prefixPaddingDuration: clampNum(v.prefixPaddingDuration, "prefixPaddingDuration"),
    endOfSpeechTimeout: clampNum(v.endOfSpeechTimeout, "endOfSpeechTimeout"),

    turnDetectionEnabled: v.turnDetectionEnabled === undefined ? true : !!v.turnDetectionEnabled,
    detectionMode: pickEnum(v.detectionMode, ["smart", "fixed"] as const, "smart"),
    detectionTimeout: clampNum(v.detectionTimeout, "detectionTimeout"),

    transcriber: pickEnum(v.transcriber, ["nova-2", "nova-3"] as const, "nova-2"),

    noiseReductionEnabled: !!v.noiseReductionEnabled,
    reductionLevel: pickEnum(v.reductionLevel, ["low", "medium", "high"] as const, "medium"),

    amdEnabled: !!v.amdEnabled,
    multilingualAmd: !!v.multilingualAmd,
    amdTimeout: clampNum(v.amdTimeout, "amdTimeout"),

    silenceBeforeCheck: clampNum(v.silenceBeforeCheck, "silenceBeforeCheck"),
    maxCheckAttempts: clampNum(v.maxCheckAttempts, "maxCheckAttempts"),
    maxSilenceDuration: clampNum(v.maxSilenceDuration, "maxSilenceDuration"),
    maxCallDuration: clampNum(v.maxCallDuration, "maxCallDuration"),

    dataStorage: pickEnum(v.dataStorage, ["store_analyze", "store_only", "no_store"] as const, "store_analyze"),

    transferNumber,
    transferMessage: String(v.transferMessage ?? "").slice(0, 300),

    extractionFields: extractionFields as ExtractionField[],

    // Extra keys carried through the blob (typed loosely in db.ts).
    // Keep livekit.interruptions in step with the structured object so any
    // consumer still reading the legacy key sees the same mode.
    ...(v.livekit ? { livekit: { ...(v.livekit as object), interruptions: iMode } as VoiceSettings["livekit"] } : {}),
    interruptions,
    backgroundAudio: pickEnum(v.backgroundAudio, BACKGROUND_AUDIO.map((b) => b.id) as unknown as readonly string[], "none"),
    tools,
    configVersion: AGENT_CONFIG_VERSION,
  } as VoiceSettings;
}

/** Human-readable problems with a config — shown in the UI before saving. */
export function validateVoiceSettings(v: VoiceSettings): string[] {
  const errors: string[] = [];
  if (v.maxSilenceDuration < v.silenceBeforeCheck) {
    errors.push("Max silence duration must be at least the silence-before-check value, otherwise the call ends before the agent ever checks in.");
  }
  if (v.detectionTimeout < v.endOfSpeechTimeout) {
    errors.push("Turn-detection timeout must be greater than the end-of-speech timeout.");
  }
  const names = new Set<string>();
  for (const f of v.extractionFields ?? []) {
    const n = (f.name ?? "").trim();
    if (!n) errors.push("Every post-call extraction field needs a name.");
    else if (names.has(n.toLowerCase())) errors.push(`Duplicate extraction field name: "${n}".`);
    else names.add(n.toLowerCase());
  }
  const tools = (v as VoiceSettings & { tools?: AgentToolState }).tools ?? {};
  if (tools.transfer_call && !v.transferNumber) {
    errors.push("Transfer to a human is enabled but no transfer number is set.");
  }
  return errors;
}
