// Import from a LiveKit Builder "Download code" ZIP.
//
// The Builder's three-dot menu exports the generated agent project; the real
// configuration (instructions, welcome message, models, voice, end-call rules)
// lives in src/agent.py. This module turns that ZIP into the SAME normalized
// Builder configuration the paste importer produces, so both paths share one
// preview, one model mapping, one secret scrubber and one non-destructive
// merge (lib/livekit-builder-import.ts).
//
// SECURITY MODEL
//  * Runs entirely in the browser (fflate, in memory) — the ZIP is never
//    uploaded to a Pydent server, so bundled .env files can't even reach us.
//  * agent.py is untrusted TEXT. It is never executed, evaluated, imported or
//    written to disk; a narrow pattern parser reads only the LiveKit-generated
//    forms and marks everything else unavailable.
//  * Hard limits (documented below) defend against zip bombs, huge archives,
//    and per-entry inflation; entry names are validated against traversal and
//    absolute paths; .env/secret-looking entries are excluded from
//    decompression entirely; all extracted values pass the shared secret
//    scrubber before anything is stored.
//  * This module performs ZERO network requests.

import { unzipSync, type UnzipFileInfo } from "fflate";
import {
  BUILDER_FIELDS,
  type BuilderField,
  type BuilderSnapshot,
  type FieldStatus,
  type ParsedBuilderExport,
  type ParsedBuilderTools,
  type ImportedTool,
  type EndCallConfig,
  normalizeToolName,
} from "@/lib/livekit-builder-import";

// ── Limits (conservative for a generated agent project) ─────────────────────
export const ZIP_LIMITS = {
  /** Largest accepted upload. Builder exports are well under 1 MB. */
  maxZipBytes: 20 * 1024 * 1024,
  /** Most entries a legitimate export could plausibly contain. */
  maxEntries: 2000,
  /** Total uncompressed size across entries we even consider. */
  maxTotalUncompressedBytes: 50 * 1024 * 1024,
  /** Largest agent.py we will read. */
  maxAgentPyBytes: 2 * 1024 * 1024,
};
export type ZipLimits = typeof ZIP_LIMITS;

// Entries never decompressed, whatever they contain.
const EXCLUDED_ENTRY = /(^|\/)\.env(\..*)?$|(^|\/)(secrets?|credentials?)(\/|\.|$)|\.(pem|key|p12|pfx)$/i;

function badEntryName(name: string): string | null {
  if (/^([a-zA-Z]:)?[\\/]/.test(name)) return `absolute path entry "${name}"`;
  if (name.split(/[\\/]/).some((seg) => seg === "..")) return `path-traversal entry "${name}"`;
  return null;
}

export interface ZipParseResult {
  parsed: ParsedBuilderExport;
  tools: ParsedBuilderTools;
  sourceFile: string;
  /** SHA-256 of the agent.py text — identifies repeated imports of the same code. */
  fingerprint: string;
}

/** Locate + read src/agent.py from the ZIP bytes, enforcing every limit. */
export function extractAgentPy(zipBytes: Uint8Array, limits: ZipLimits = ZIP_LIMITS): { source: string; path: string } {
  if (zipBytes.length > limits.maxZipBytes) {
    throw new Error(`The ZIP is ${(zipBytes.length / 1048576).toFixed(1)} MB — larger than the ${limits.maxZipBytes / 1048576} MB limit.`);
  }
  let entryCount = 0;
  let totalUncompressed = 0;
  const candidates: string[] = [];
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zipBytes, {
      filter: (f: UnzipFileInfo) => {
        entryCount++;
        if (entryCount > limits.maxEntries) throw new Error(`The ZIP has more than ${limits.maxEntries} entries.`);
        const bad = badEntryName(f.name);
        if (bad) throw new Error(`Unsafe ZIP rejected: ${bad}.`);
        totalUncompressed += f.originalSize ?? 0;
        if (totalUncompressed > limits.maxTotalUncompressedBytes) {
          throw new Error(`The ZIP expands past the ${limits.maxTotalUncompressedBytes / 1048576} MB uncompressed limit.`);
        }
        if (EXCLUDED_ENTRY.test(f.name)) return false; // .env / secrets: never decompressed
        // Only agent.py candidates are ever decompressed.
        if (!/(^|\/)agent\.py$/.test(f.name)) return false;
        if ((f.originalSize ?? 0) > limits.maxAgentPyBytes) {
          throw new Error(`"${f.name}" is larger than the ${limits.maxAgentPyBytes / 1048576} MB agent.py limit.`);
        }
        candidates.push(f.name);
        return true;
      },
    });
  } catch (e) {
    if (e instanceof Error && /Unsafe ZIP|entries|limit/.test(e.message)) throw e;
    throw new Error("That file could not be read as a ZIP archive.");
  }
  if (candidates.length === 0) {
    throw new Error('No agent.py found in the ZIP — expected "src/agent.py" from LiveKit Builder’s Download code.');
  }
  // Prefer the canonical path; otherwise the file must be unambiguous.
  const exact = candidates.find((c) => c === "src/agent.py" || c.endsWith("/src/agent.py"));
  const path = exact ?? (candidates.length === 1 ? candidates[0] : null);
  if (!path) {
    throw new Error(`The ZIP contains ${candidates.length} agent.py files (${candidates.join(", ")}) and none at src/agent.py — cannot choose safely.`);
  }
  return { source: new TextDecoder().decode(files[path]), path };
}

// ── Narrow parser for the LiveKit-generated agent.py ────────────────────────
// This is NOT a Python parser. It recognizes only the specific generated
// forms: string literals (single/double/triple-quoted, with escapes), keyword
// arguments, booleans, and first-string-argument constructor calls. Anything
// else is left unavailable — never guessed.

/** Read one Python string literal starting at src[i] (must be a quote). */
function readPyString(src: string, i: number): { value: string; end: number } | null {
  const triple = src.startsWith('"""', i) || src.startsWith("'''", i);
  const q = triple ? src.slice(i, i + 3) : src[i];
  if (!triple && q !== '"' && q !== "'") return null;
  let j = i + q.length;
  let out = "";
  while (j < src.length) {
    if (src.startsWith(q, j)) return { value: out, end: j + q.length };
    const c = src[j];
    if (c === "\\") {
      const n = src[j + 1];
      const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "'": "'", "0": "\0" };
      if (n === "x" && /^[0-9a-f]{2}/i.test(src.slice(j + 2, j + 4))) {
        out += String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16));
        j += 4;
      } else if (n === "u" && /^[0-9a-f]{4}/i.test(src.slice(j + 2, j + 6))) {
        out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
        j += 6;
      } else if (n === "\n") {
        j += 2; // line continuation inside a string
      } else {
        out += map[n] ?? n;
        j += 2;
      }
      continue;
    }
    if (!triple && (c === "\n" || c === "\r")) return null; // unterminated
    out += c;
    j++;
  }
  return null; // unterminated
}

/** Skip an optional string prefix like r/f/b before a quote. */
function skipStrPrefix(src: string, i: number): number {
  return /[rbfu]/i.test(src[i] ?? "") && /['"]/.test(src[i + 1] ?? "") ? i + 1 : i;
}

/** Read a string value allowing Python's generated forms:
 *  "a", '''a''', and parenthesized implicit concatenation:
 *  ( "part one " 
 "part two" ). Returns the joined value. */
function readPyStringValue(src: string, i: number): { value: string; end: number } | null {
  let j = i;
  const ws = () => { while (/[\s]/.test(src[j] ?? "")) j++; };
  ws();
  let parens = 0;
  while (src[j] === "(") { parens++; j++; ws(); }
  let out: string | null = null;
  for (;;) {
    const k = skipStrPrefix(src, j);
    const s = readPyString(src, k);
    if (!s) break;
    out = (out ?? "") + s.value;
    j = s.end;
    ws();
  }
  if (out === null) return null;
  while (parens > 0 && src[j] === ")") { parens--; j++; ws(); }
  return { value: out, end: j };
}

/** Value of `name=<python value>` anywhere in `region` (string/bool/identifier). */
function kwarg(region: string, name: string): string | boolean | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*`, "g");
  const m = re.exec(region);
  if (!m) return undefined;
  const i = m.index + m[0].length;
  const str = readPyStringValue(region, i);
  if (str) return str.value;
  const rest = region.slice(skipStrPrefix(region, i));
  if (/^True\b/.test(rest)) return true;
  if (/^False\b/.test(rest)) return false;
  const ident = /^[A-Za-z_][\w.]*/.exec(rest);
  if (ident) {
    // A variable reference: resolve simple module-level `NAME = "..."` bindings.
    return `\u0000ref:${ident[0]}`;
  }
  return undefined;
}

/** The parenthesized argument region of the first `callName(` occurrence. */
function callRegion(src: string, callName: string): string | null {
  const re = new RegExp(`\\b${callName.replace(/\./g, "\\.")}\\s*\\(`, "g");
  const m = re.exec(src);
  if (!m) return null;
  let depth = 1;
  let j = m.index + m[0].length;
  const start = j;
  while (j < src.length && depth > 0) {
    const c = src[j];
    if (c === '"' || c === "'") {
      const s = readPyString(src, skipStrPrefix(src, j) === j ? j : j); // strings skipped atomically
      if (s) { j = s.end; continue; }
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    j++;
  }
  return src.slice(start, j - 1);
}

/** First plain string argument of a call region (the model id position). */
function firstStringArg(region: string): string | undefined {
  let i = 0;
  while (i < region.length) {
    const c = region[i];
    if (c === " " || c === "\n" || c === "\r" || c === "\t" || c === ",") { i++; continue; }
    const k = skipStrPrefix(region, i);
    const s = readPyString(region, k);
    if (s) return s.value;
    // `model=` / `name=` kwarg in first position also counts
    const km = /^([a-z_]+)\s*=\s*/i.exec(region.slice(i));
    if (km && ["model", "name", "model_id"].includes(km[1])) {
      const s2 = readPyString(region, skipStrPrefix(region, i + km[0].length));
      if (s2) return s2.value;
    }
    return undefined; // first arg is not a string — don't guess
  }
  return undefined;
}

/** Resolve `\u0000ref:NAME` via simple module-level `NAME = "..."` assignments. */
function resolveRef(src: string, v: string | boolean | undefined): string | boolean | undefined {
  if (typeof v !== "string" || !v.startsWith("\u0000ref:")) return v;
  const name = v.slice(5);
  const re = new RegExp(`^\\s*${name}\\s*=\\s*`, "m");
  const m = re.exec(src);
  if (!m) return undefined;
  return readPyStringValue(src, m.index + m[0].length)?.value;
}

const asStr = (v: string | boolean | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const asBool = (v: string | boolean | undefined): boolean | undefined => (typeof v === "boolean" ? v : undefined);

/** Parse the generated agent.py into the shared Builder representation. */
export function parseAgentPy(source: string): { parsed: ParsedBuilderExport; tools: ParsedBuilderTools } {
  const status = Object.fromEntries(BUILDER_FIELDS.map((f) => [f, "unavailable"])) as Record<BuilderField, FieldStatus>;
  const warnings: string[] = [];
  const snapshot: BuilderSnapshot = {};
  const set = <K extends BuilderField>(field: K, value: BuilderSnapshot[K] | undefined) => {
    if (value === undefined || value === "") return;
    (snapshot as Record<string, unknown>)[field] = value;
    status[field] = "imported";
  };
  const kw = (region: string | null, name: string) => (region ? resolveRef(source, kwarg(region, name)) : undefined);

  // Instructions: `instructions=` kwarg anywhere (Agent(...) in generated code).
  set("instructions", asStr(resolveRef(source, kwarg(source, "instructions"))));

  // Models: inference.STT/LLM/TTS constructor calls.
  const sttR = callRegion(source, "inference.STT") ?? callRegion(source, "STT");
  const llmR = callRegion(source, "inference.LLM") ?? callRegion(source, "LLM");
  const ttsR = callRegion(source, "inference.TTS") ?? callRegion(source, "TTS");
  if (sttR) {
    set("stt", firstStringArg(sttR) ?? asStr(kw(sttR, "model")));
    set("sttLanguage", asStr(kw(sttR, "language")));
  }
  if (llmR) {
    set("llm", firstStringArg(llmR) ?? asStr(kw(llmR, "model")));
    const eff = asStr(kw(llmR, "reasoning_effort")) ?? (/["']reasoning_effort["']\s*:\s*["']([a-z]+)["']/.exec(llmR)?.[1]);
    set("reasoningEffort", eff);
  }
  if (ttsR) {
    set("tts", firstStringArg(ttsR) ?? asStr(kw(ttsR, "model")));
    set("voice", asStr(kw(ttsR, "voice")));
    set("voiceLanguage", asStr(kw(ttsR, "language")));
  }

  // Welcome message: kwarg, or a WELCOME-style constant, or session.say("...").
  const welcome =
    asStr(resolveRef(source, kwarg(source, "welcome_message"))) ??
    asStr(resolveRef(source, kwarg(source, "greeting"))) ??
    (() => {
      const m = /^\s*(WELCOME(?:_MESSAGE)?|GREETING)\s*=\s*/m.exec(source);
      return m ? readPyStringValue(source, m.index + m[0].length)?.value : undefined;
    })() ??
    (() => {
      const r = callRegion(source, "session.say");
      return r ? firstStringArg(r) ?? asStr(resolveRef(source, /^[A-Za-z_][\w]*/.exec(r.trim()) ? `\u0000ref:${/^[A-Za-z_][\w]*/.exec(r.trim())![0]}` : undefined)) : undefined;
    })();
  set("welcomeMessage", welcome);
  if (welcome) set("welcomeEnabled", true);
  const sayR = callRegion(source, "session.say");
  set("greetingInterruptible", asBool(kw(sayR, "allow_interruptions")) ?? asBool(resolveRef(source, kwarg(source, "allow_interruptions"))));

  // Audio / turn taking.
  const nc = /noise_cancellation\.([A-Z][A-Z0-9_]*)/.exec(source)?.[1];
  if (nc) {
    set("noiseCancellation", true);
    snapshot.noiseCancellationModel = nc;
    status.noiseCancellationModel = "imported";
  }
  set("backgroundAudio", asStr(resolveRef(source, kwarg(source, "ambient_sound"))) ?? asStr(resolveRef(source, kwarg(source, "background_audio"))));
  if (/TurnDetector\s*\(/.test(source)) { snapshot.turnDetector = "livekit-inference"; status.turnDetector = "imported"; }
  const preemptive = asBool(resolveRef(source, kwarg(source, "preemptive_generation")));
  if (preemptive !== undefined) { snapshot.preemptiveGeneration = preemptive; status.preemptiveGeneration = "imported"; }

  // End call: generated end-call tool/config.
  const endCallPresent = /\bend_call\b/.test(source);
  const ecInstr =
    asStr(resolveRef(source, kwarg(source, "end_call_instructions"))) ??
    asStr(resolveRef(source, kwarg(source, "final_response"))) ??
    (() => {
      const m = /^\s*(END_CALL(?:_INSTRUCTIONS)?|FINAL_RESPONSE)\s*=\s*/m.exec(source);
      return m ? readPyStringValue(source, m.index + m[0].length)?.value : undefined;
    })();
  const ecConditions = asStr(resolveRef(source, kwarg(source, "end_call_conditions"))) ?? "";
  const deleteRoom = asBool(resolveRef(source, kwarg(source, "delete_room")));
  const summaryUrl = asStr(resolveRef(source, kwarg(source, "summary_endpoint"))) ?? asStr(resolveRef(source, kwarg(source, "summary_url"))) ?? "";
  if (endCallPresent) set("endCallEnabled", true);
  if (ecConditions) set("endCallConditions", ecConditions);
  if (ecInstr) set("endCallFinalResponse", ecInstr);

  // Tools: only statically declared function tools. Names in prose never count.
  const tools: ImportedTool[] = [];
  const seen = new Set<string>();
  const toolNames: string[] = [];
  for (const m of source.matchAll(/@function_tool[\s\S]{0,300}?\basync\s+def\s+([a-z_][\w]*)\s*\(/g)) toolNames.push(m[1]);
  for (const m of source.matchAll(/@function_tool\s*\(\s*name\s*=\s*["']([\w-]+)["']/g)) toolNames.push(m[1]);
  for (const rawName of toolNames) {
    const name = normalizeToolName(rawName);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (name === "end_call") {
      tools.push({ name, displayName: rawName, type: "end_call", enabled: true, source: "livekit-builder", executable: true, mappedTo: "end_call" });
    } else if (/knowledge/.test(name)) {
      tools.push({ name, displayName: rawName, type: "knowledge_base", enabled: true, source: "livekit-builder", executable: true, mappedTo: "search_knowledge" });
    } else {
      // A Builder-generated python function is not executable in Pydent.
      tools.push({ name, displayName: rawName, type: "imported", enabled: true, source: "livekit-builder", executable: false });
    }
  }

  let endCall: EndCallConfig | undefined;
  if (endCallPresent || ecInstr || ecConditions) {
    endCall = {
      enabled: endCallPresent,
      conditions: ecConditions,
      finalResponse: ecInstr ?? "",
      deleteRoom: deleteRoom ?? false,
      summaryUrl: /^https?:\/\//i.test(summaryUrl) ? summaryUrl : "",
      summaryHeaders: {},
    };
  }
  if (Object.keys(snapshot).length === 0) {
    warnings.push("No recognizable LiveKit-generated configuration was found in agent.py.");
  }
  return {
    parsed: { snapshot, status, warnings },
    tools: { tools, endCall, referencedOnly: [], warnings: [] },
  };
}

/** SHA-256 hex of a string (Web Crypto — browser and Node 18+). */
async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Full pipeline: ZIP bytes -> normalized Builder configuration. */
export async function parseBuilderZip(zipBytes: Uint8Array, limits: ZipLimits = ZIP_LIMITS): Promise<ZipParseResult> {
  const { source, path } = extractAgentPy(zipBytes, limits);
  const { parsed, tools } = parseAgentPy(source);
  return { parsed, tools, sourceFile: path, fingerprint: await sha256Hex(source) };
}
