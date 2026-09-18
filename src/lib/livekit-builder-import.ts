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
  "noiseCancellationModel",
  "backgroundAudio",
  "turnDetector",
  "preemptiveGeneration",
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
  /** The exact LiveKit noise-cancellation model name (e.g. from a code export). */
  noiseCancellationModel?: string;
  backgroundAudio?: string;
  /** Turn detector kind detected in a code export (snapshot only). */
  turnDetector?: string;
  /** Preemptive generation flag from a code export (snapshot only). */
  preemptiveGeneration?: boolean;
}

export interface ParsedBuilderExport {
  snapshot: BuilderSnapshot;
  status: Record<BuilderField, FieldStatus>;
  warnings: string[];
}

const SECRET_KEY = /secret|token|api[-_]?key|authorization|password|bearer|credential|cookie|private[-_]?key/i;

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
    // Text that LOOKS like an attempted JSON export but fails to parse is
    // rejected outright — silently turning broken JSON into the Instructions
    // prompt could overwrite a real prompt with garbage on a re-import.
    if (/^[[{]/.test(unfenced)) {
      warnings.push("The pasted text looks like JSON but could not be parsed — nothing was imported. Fix the export and paste again.");
      return { snapshot, status, warnings };
    }
    // Plain prose: the only thing we can honestly take is the instructions text.
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

// ════════════════════════════════════════════════════════════════════════════
// Agent tools import
//
// A Builder export may carry a tools/actions list. Pydent's OWN executable
// tools are the AGENT_TOOLS catalog run by the Pydent worker (booking, patient
// lookup, email, transfer, search_knowledge) plus the always-on end_call —
// those stay authoritative and are NEVER modified by an import. What is
// imported here is a faithful, sanitized REPRESENTATION of the Builder's
// tools:
//   * a tool matching a Pydent capability is marked pydent_native (executable
//     through the existing capability — nothing new is registered);
//   * an HTTP/webhook tool is stored as configuration ONLY — the current
//     Pydent runtime does not execute arbitrary HTTP tools, and the UI says so
//     instead of pretending;
//   * anything else is kept as an inert imported snapshot.
// A tool name appearing in the Instructions text is NEVER enough to create a
// tool — only entries in an actual tools/actions array are parsed.
// ════════════════════════════════════════════════════════════════════════════

export type ImportedToolType = "end_call" | "http" | "knowledge_base" | "pydent_native" | "imported";

export interface ImportedTool {
  name: string;         // normalized snake_case identity (merge key)
  displayName: string;
  type: ImportedToolType;
  description?: string;
  enabled: boolean;
  source: "livekit-builder" | "manual";
  /** true only when Pydent's existing runtime actually executes this behavior. */
  executable: boolean;
  /** AGENT_TOOLS id when this maps to an existing Pydent capability. */
  mappedTo?: string;
  // http tools only — never guessed; absent when the export didn't state them.
  method?: string;
  url?: string;
  headers?: Record<string, string>; // secret values stripped, names kept
  inputSchema?: unknown;            // recursively sanitized
  timeoutMs?: number;
  /** true when an auth-looking header/value was removed — the tool needs its
   *  credentials re-entered wherever it is actually executed. */
  authRequired?: boolean;
}

export interface EndCallConfig {
  enabled: boolean;
  conditions: string;
  finalResponse: string;
  deleteRoom: boolean;
  summaryUrl: string;
  /** Secret values stripped; names kept so the shape is visible. */
  summaryHeaders: Record<string, string>;
  authRequired?: boolean;
}

// Names of Pydent's native worker tools an import can map onto (aliases incl.).
const NATIVE_TOOL_ALIASES: Record<string, string> = {
  get_available_slots: "get_available_slots",
  check_availability: "get_available_slots",
  availability: "get_available_slots",
  book_appointment: "book_appointment",
  book: "book_appointment",
  manage_appointment: "reschedule_appointment",
  reschedule_appointment: "reschedule_appointment",
  cancel_appointment: "cancel_appointment",
  lookup_patient: "lookup_patient",
  find_patient: "lookup_patient",
  create_patient: "create_patient",
  send_email: "send_email",
  transfer_call: "transfer_call",
  transfer: "transfer_call",
  search_knowledge: "search_knowledge",
};

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const SECRET_VALUE = /^(bearer|basic|token)\s+\S+|^[A-Za-z0-9+/_=-]{24,}$/i;

export function normalizeToolName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "").slice(0, 64);
}

/** Deep-clone with every secret-looking KEY removed, at any depth. */
export function scrubSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(k)) continue;
    out[k] = scrubSecrets(v, depth + 1);
  }
  return out;
}

/** Headers: drop secret-named keys; keep auth-shaped header NAMES with the
 *  value blanked, and report that authentication needs reconfiguring. */
function sanitizeHeaders(raw: unknown): { headers: Record<string, string>; authRequired: boolean } {
  const headers: Record<string, string> = {};
  let authRequired = false;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const value = String(v ?? "");
      // Authorization-style headers: the NAME is kept (so the shape stays
      // visible) but the secret value is blanked, never persisted.
      if (/^authorization$/i.test(k) || SECRET_VALUE.test(value)) {
        headers[k.slice(0, 80)] = "";
        authRequired = true;
        continue;
      }
      // Any other secret-named header is dropped entirely.
      if (SECRET_KEY.test(k)) { authRequired = true; continue; }
      headers[k.slice(0, 80)] = value.slice(0, 300);
    }
  }
  return { headers, authRequired };
}

function toolEntryToImported(entry: unknown): ImportedTool | null {
  if (!entry || typeof entry !== "object") return null;
  const m = new Map<string, unknown>();
  collect(entry, m);
  const rawName = firstString(m, "name", "id", "tool_name", "function", "function_name", "title");
  if (!rawName) return null;
  const name = normalizeToolName(rawName);
  if (!name) return null;

  const displayName = firstString(m, "display_name", "label", "title") ?? rawName;
  const description = firstString(m, "description", "summary");
  const explicitType = (firstString(m, "type", "kind", "category") ?? "").toLowerCase();
  const url = firstString(m, "url", "endpoint", "uri", "webhook_url", "server_url");
  const enabled = firstBool(m, "enabled", "active") ?? true;

  const base = { name, displayName, description, enabled, source: "livekit-builder" as const };

  // End call: folds into the structured end-call config as well.
  if (name === "end_call" || name === "endcall" || /end.?call/.test(explicitType)) {
    return { ...base, name: "end_call", type: "end_call", executable: true, mappedTo: "end_call" };
  }
  // Knowledge base: maps to Pydent's existing KB capability — no new documents.
  if (/knowledge/.test(name) || /knowledge/.test(explicitType)) {
    return { ...base, type: "knowledge_base", executable: true, mappedTo: "search_knowledge" };
  }
  // Native Pydent capability by (alias) name.
  const mapped = NATIVE_TOOL_ALIASES[name];
  if (mapped && !url) {
    return { ...base, type: "pydent_native", executable: true, mappedTo: mapped };
  }
  // HTTP/webhook tool: needs a real URL — never guessed. Stored as
  // configuration only; the current runtime does not execute it.
  const looksHttp = /http|webhook|api|request/.test(explicitType) || !!url;
  if (looksHttp) {
    if (!url || !/^https?:\/\//i.test(url)) {
      // A "http" tool without a stated endpoint has no executable definition.
      return { ...base, type: "imported", executable: false };
    }
    const methodRaw = (firstString(m, "method", "http_method", "verb") ?? "").toUpperCase();
    const { headers, authRequired } = sanitizeHeaders(m.get("headers"));
    const schemaRaw = m.get(norm("input_schema")) ?? m.get(norm("parameters")) ?? m.get(norm("schema"));
    const timeoutS = m.get(norm("timeout"));
    const timeoutMsRaw = m.get(norm("timeout_ms"));
    const timeoutMs =
      typeof timeoutMsRaw === "number" ? timeoutMsRaw : typeof timeoutS === "number" ? timeoutS * 1000 : undefined;
    return {
      ...base,
      type: "http",
      executable: false, // honest: Pydent's runtime has no generic HTTP tool executor
      url,
      ...(HTTP_METHODS.includes(methodRaw) ? { method: methodRaw } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(schemaRaw !== undefined ? { inputSchema: scrubSecrets(schemaRaw) } : {}),
      ...(timeoutMs && Number.isFinite(timeoutMs) ? { timeoutMs: Math.min(120000, Math.max(1000, timeoutMs)) } : {}),
      ...(authRequired ? { authRequired: true } : {}),
    };
  }
  // Unknown: keep as an inert snapshot.
  return { ...base, type: "imported", executable: false };
}

/** Find the tools array wherever it lives: tools / actions / functions, at the
 *  top level or nested (e.g. { agent: { tools: [...] } }). */
function findToolsArray(parsed: unknown, depth = 0): unknown[] | null {
  if (depth > 5 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  for (const key of ["tools", "actions", "functions"]) {
    const v = (parsed as Record<string, unknown>)[key] ?? (parsed as Record<string, unknown>)[key.toUpperCase()];
    if (Array.isArray(v)) return v;
  }
  for (const v of Object.values(parsed as Record<string, unknown>)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const hit = findToolsArray(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

export interface ParsedBuilderTools {
  tools: ImportedTool[];
  endCall?: EndCallConfig;
  /** Native tool names mentioned ONLY in the instructions text — reported for
   *  the preview, never turned into tools. */
  referencedOnly: string[];
  warnings: string[];
}

export function parseBuilderTools(text: string): ParsedBuilderTools {
  const out: ParsedBuilderTools = { tools: [], referencedOnly: [], warnings: [] };
  const raw = (text ?? "").trim();
  if (!raw) return out;
  const unfenced = raw.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    // Not JSON: instructions text alone NEVER creates tools — only report refs.
    out.referencedOnly = referencedToolNames(raw, []);
    return out;
  }

  const arr = findToolsArray(parsed);
  const seen = new Set<string>();
  for (const entry of arr ?? []) {
    const tool = toolEntryToImported(entry);
    if (!tool) continue;
    if (seen.has(tool.name)) {
      out.warnings.push(`Duplicate tool "${tool.name}" in the export — first definition kept.`);
      continue;
    }
    seen.add(tool.name);
    out.tools.push(tool);
  }

  // Structured end-call block (top level or nested under end_call / call_ending).
  const m = new Map<string, unknown>();
  collect(parsed, m);
  const ecEnabled = firstBool(m, "end_call_enabled", "end_call", "endcall");
  const conditions = firstString(m, "end_call_conditions", "conditions") ?? "";
  const finalResponse = firstString(m, "final_response", "final_response_instructions", "closing") ?? "";
  const deleteRoom = firstBool(m, "delete_room", "delete_room_for_all_participants", "deleteroomforallparticipants") ?? false;
  const summaryUrl = firstString(m, "summary_endpoint", "summary_endpoint_url", "summary_url") ?? "";
  const sum = sanitizeHeaders(m.get(norm("summary_headers")) ?? m.get(norm("headers")));
  const hasEndCallTool = out.tools.some((t) => t.type === "end_call");
  if (ecEnabled !== undefined || conditions || finalResponse || summaryUrl || hasEndCallTool) {
    out.endCall = {
      enabled: ecEnabled ?? hasEndCallTool,
      conditions,
      finalResponse,
      deleteRoom,
      summaryUrl: /^https?:\/\//i.test(summaryUrl) ? summaryUrl : "",
      summaryHeaders: sum.headers,
      ...(sum.authRequired ? { authRequired: true } : {}),
    };
  }

  // Instruction-referenced names (report only) — never sources of tools.
  const instructions = firstString(m, "instructions", "prompt", "system_prompt") ?? "";
  out.referencedOnly = referencedToolNames(instructions, out.tools.map((t) => t.name));
  return out;
}

/** Known tool names mentioned in free text but not backed by a definition. */
export function referencedToolNames(text: string, importedNames: string[]): string[] {
  const found = new Set<string>();
  for (const alias of Object.keys(NATIVE_TOOL_ALIASES)) {
    if (new RegExp(`\\b${alias}\\b`, "i").test(text) && !importedNames.includes(normalizeToolName(alias))) {
      found.add(alias);
    }
  }
  return [...found];
}

/**
 * Non-destructive merge of imported tools into an agent's existing list.
 *  - matched by normalized name;
 *  - existing entries are never deleted because they're absent from an import;
 *  - populated fields are never overwritten by empty/undefined imported values;
 *  - a name-only import (no executable config) never downgrades an existing
 *    configured tool.
 */
export function mergeImportedTools(existing: ImportedTool[] | undefined, incoming: ImportedTool[]): ImportedTool[] {
  const out: ImportedTool[] = [...(existing ?? [])];
  for (const inc of incoming) {
    const i = out.findIndex((t) => t.name === inc.name);
    if (i === -1) {
      out.push(inc);
      continue;
    }
    const cur = out[i];
    const merged: ImportedTool = { ...cur };
    for (const [k, v] of Object.entries(inc)) {
      if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) continue;
      if (k === "headers" && typeof v === "object" && Object.keys(v as object).length === 0) continue;
      (merged as unknown as Record<string, unknown>)[k] = v;
    }
    // A config-less import must not strip an existing executable definition.
    if (cur.url && !inc.url) merged.url = cur.url;
    if (cur.method && !inc.method) merged.method = cur.method;
    if (cur.inputSchema !== undefined && inc.inputSchema === undefined) merged.inputSchema = cur.inputSchema;
    out[i] = merged;
  }
  return out.slice(0, 40);
}
