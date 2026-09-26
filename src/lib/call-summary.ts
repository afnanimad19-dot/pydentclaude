// AI Call Summary — turns a finished call's stored transcript + the worker's
// recorded tool results into a short factual summary for the Call Details page.
//
// Everything here is pure and dependency-injected (like builder-tools.ts) so
// grounding, idempotence and authorization are unit-testable without Supabase
// or an LLM. call-summary-server.ts binds the real chat model and database.
//
// Grounding rule (the whole point): the summary may claim an action was
// COMPLETED only when the worker recorded a successful tool call for it
// (structured_data.toolCalls = [{name, ms, ok}]). Everything else is at most
// "discussed" or "attempted" — the model is told exactly which actions are
// confirmed and instructed never to invent success.

export const SUMMARY_AI_KEY = "summary_ai";

/** A "processing" marker older than this is treated as failed (the serverless
 *  runtime froze before the generation finished) and the UI offers Retry. */
export const PROCESSING_FRESH_MS = 2 * 60_000;

const TRANSCRIPT_CHAR_LIMIT = 24_000;
const SUMMARY_CHAR_LIMIT = 4_000;
export const DEFAULT_SUMMARY_DEADLINE_MS = 8_000;

export interface SummaryAiState {
  status: "processing" | "available" | "failed";
  at: string; // ISO timestamp of the transition
  error?: string;
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/** Returns the model's reply text. Throwing = generation failure. */
export type SummaryChat = (messages: ChatMessage[]) => Promise<string>;

/** Storage for ONE call row. Writes touch only the summary column and the
 *  summary_ai key inside structured_data — never tool results, extraction
 *  data or any other column, so a racing call-log re-post can't lose data. */
export interface SummaryStore {
  markProcessing(at: string): Promise<void>;
  markFailed(error: string, at: string): Promise<void>;
  /** Persist the summary ONLY if the stored one is still empty (a Vapi
   *  summary or a concurrent generation must never be overwritten).
   *  Returns false when a summary was already there. */
  saveSummary(summary: string, at: string): Promise<boolean>;
}

// ── tool evidence ────────────────────────────────────────────────────────────

export interface ToolEvidence {
  name: string;
  ok: boolean;
}

/** Normalize structured_data.toolCalls ([{name, ms, ok}]) defensively. */
export function normalizeToolCalls(v: unknown): ToolEvidence[] {
  if (!Array.isArray(v)) return [];
  const out: ToolEvidence[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const name = String((item as { name?: unknown }).name ?? "").trim();
    if (!name) continue;
    out.push({ name, ok: (item as { ok?: unknown }).ok === true });
  }
  return out;
}

/** The transcript to summarize: the stored transcript text when present,
 *  otherwise rebuilt from the stored messages timeline (older calls) — only
 *  ever from stored evidence, never fabricated. */
export function transcriptOf(transcript: unknown, messages: unknown, agentName: string): string {
  const direct = String(transcript ?? "").trim();
  if (direct) return direct;
  if (!Array.isArray(messages)) return "";
  const lines: string[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const r = m as { role?: unknown; message?: unknown; text?: unknown; content?: unknown };
    const text = String(r.message ?? r.text ?? r.content ?? "").trim();
    if (!text) continue;
    const who = r.role === "user" ? "Caller" : agentName || "Agent";
    lines.push(`${who}: ${text}`);
  }
  return lines.join("\n");
}

// ── prompt ───────────────────────────────────────────────────────────────────

export function buildSummaryPrompt(opts: {
  transcript: string;
  toolCalls: ToolEvidence[];
  agentName: string;
}): ChatMessage[] {
  const succeeded = opts.toolCalls.filter((t) => t.ok).map((t) => t.name);
  const failed = opts.toolCalls.filter((t) => !t.ok).map((t) => t.name);

  const evidence = opts.toolCalls.length
    ? `Confirmed tool results for this call:\n` +
      `- Actions that COMPLETED successfully: ${succeeded.length ? succeeded.join(", ") : "none"}.\n` +
      `- Actions that were attempted but FAILED: ${failed.length ? failed.join(", ") : "none"}.`
    : "No tool actions were recorded for this call. Treat every booking, cancellation, reschedule, transfer or payment as NOT completed, no matter what the transcript says.";

  const system =
    "You summarize a finished phone call handled by a dental clinic's AI receptionist. " +
    "Write a concise factual summary in plain prose (no markdown, no headings, at most 6 sentences) covering: " +
    "why the caller called, what information was collected, which actions were actually completed, " +
    "anything left unresolved, and what follow-up (if any) is appropriate. " +
    "STRICT GROUNDING: state that a booking, cancellation, reschedule, transfer, payment or any other action " +
    "was completed ONLY if it appears in the list of successfully completed tool actions below. " +
    "If it is not in that list, describe it as requested or discussed — never as done. " +
    "Never guess or invent details the transcript does not contain.";

  const user =
    `${evidence}\n\n` +
    `Transcript of the call handled by ${opts.agentName || "the agent"}:\n` +
    opts.transcript.slice(0, TRANSCRIPT_CHAR_LIMIT);

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ── generation ───────────────────────────────────────────────────────────────

export interface SummaryGenResult {
  summary?: string;
  error?: string;
}

/** Generate a grounded summary. Never throws; bounded by deadlineMs so an
 *  awaiting request handler is never held past a safe margin. */
export async function generateCallSummary(
  chat: SummaryChat,
  opts: { transcript: string; toolCalls: ToolEvidence[]; agentName: string; deadlineMs?: number }
): Promise<SummaryGenResult> {
  if (!opts.transcript.trim()) return { error: "No transcript is stored for this call." };
  const deadline = opts.deadlineMs ?? DEFAULT_SUMMARY_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Summary generation timed out.")), deadline);
    });
    const text = await Promise.race([chat(buildSummaryPrompt(opts)), timeout]);
    const summary = String(text ?? "").trim().slice(0, SUMMARY_CHAR_LIMIT);
    if (!summary) return { error: "The model returned an empty summary." };
    return { summary };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Summary generation failed." };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── orchestration ────────────────────────────────────────────────────────────

export interface SummaryRunInput {
  /** Current stored summary — non-empty means PRESERVE (Vapi included). */
  summary: string;
  transcript: string;
  structuredData: Record<string, unknown>;
  agentName: string;
  /** LiveKit privacy mode from structured_data ("" for Vapi rows = allowed). */
  privacy?: string;
  deadlineMs?: number;
}

export type SummaryRunOutcome =
  | { status: "available"; summary: string }
  | { status: "skipped"; reason: "already_summarized" | "in_progress" | "analysis_disabled" }
  | { status: "failed"; reason: string };

function summaryAiOf(structuredData: Record<string, unknown>): Partial<SummaryAiState> {
  const v = structuredData?.[SUMMARY_AI_KEY];
  return v && typeof v === "object" ? (v as Partial<SummaryAiState>) : {};
}

/**
 * Run summary generation for one stored call, idempotently:
 *  - an existing non-empty summary is never touched;
 *  - a FRESH "processing" marker means another submission is already on it;
 *  - privacy modes that forbid analysis are refused without any write;
 *  - success fills the summary only if still empty; failure records the reason
 *    in structured_data.summary_ai so the UI can show Failed + Retry.
 */
export async function runCallSummary(
  deps: { chat: SummaryChat; store: SummaryStore; now?: () => Date },
  call: SummaryRunInput
): Promise<SummaryRunOutcome> {
  if (String(call.summary ?? "").trim()) return { status: "skipped", reason: "already_summarized" };
  if (call.privacy && call.privacy !== "store_analyze") return { status: "skipped", reason: "analysis_disabled" };

  const now = deps.now ?? (() => new Date());
  const prior = summaryAiOf(call.structuredData);
  if (prior.status === "processing" && prior.at) {
    const age = now().getTime() - new Date(prior.at).getTime();
    if (age >= 0 && age < PROCESSING_FRESH_MS) return { status: "skipped", reason: "in_progress" };
  }

  const stamp = now().toISOString();
  if (!call.transcript.trim()) {
    await deps.store.markFailed("No transcript is stored for this call.", stamp);
    return { status: "failed", reason: "No transcript is stored for this call." };
  }

  await deps.store.markProcessing(stamp);
  const gen = await generateCallSummary(deps.chat, {
    transcript: call.transcript,
    toolCalls: normalizeToolCalls(call.structuredData?.toolCalls),
    agentName: call.agentName,
    deadlineMs: call.deadlineMs,
  });

  const doneStamp = now().toISOString();
  if (gen.error || !gen.summary) {
    await deps.store.markFailed(gen.error ?? "Summary generation failed.", doneStamp);
    return { status: "failed", reason: gen.error ?? "Summary generation failed." };
  }
  const written = await deps.store.saveSummary(gen.summary, doneStamp);
  if (!written) return { status: "skipped", reason: "already_summarized" };
  return { status: "available", summary: gen.summary };
}

// ── UI state derivation ──────────────────────────────────────────────────────

export interface SummaryView {
  kind: "available" | "processing" | "failed" | "none";
  error?: string;
  /** Whether the Retry / Generate action makes sense (evidence exists). */
  canRetry: boolean;
}

export function deriveSummaryView(opts: {
  summary: string;
  structuredData: Record<string, unknown>;
  hasTranscript: boolean;
  nowMs?: number;
}): SummaryView {
  if (String(opts.summary ?? "").trim()) return { kind: "available", canRetry: false };
  const state = summaryAiOf(opts.structuredData);
  const retry = opts.hasTranscript;
  if (state.status === "processing" && state.at) {
    const age = (opts.nowMs ?? Date.now()) - new Date(state.at).getTime();
    if (age >= 0 && age < PROCESSING_FRESH_MS) return { kind: "processing", canRetry: false };
    return { kind: "failed", error: "Summary generation did not complete.", canRetry: retry };
  }
  if (state.status === "failed") {
    return { kind: "failed", error: String(state.error ?? "Summary generation failed."), canRetry: retry };
  }
  return { kind: "none", canRetry: retry };
}

// ── retry authorization (pure — the route is thin wiring) ───────────────────

export interface RetryAuthDeps {
  /** Supabase session JWT → user id, null when invalid. */
  getUserId(token: string): Promise<string | null>;
  /** User id → their active workspace id (profiles.workspace_id). */
  getProfileWorkspace(userId: string): Promise<string | null>;
  /** voice_calls.id → its workspace, null when the row does not exist. */
  getCallWorkspace(callId: string): Promise<string | null>;
}

export type RetryAuthResult =
  | { ok: true }
  | { ok: false; status: 400 | 401 | 404; error: string };

/** Workspace-authorized retry: the caller must be signed in AND the call must
 *  belong to their workspace. Foreign or unknown calls both answer 404 so a
 *  tenant can't probe another tenant's call ids. */
export async function authorizeSummaryRetry(
  deps: RetryAuthDeps,
  token: string | null | undefined,
  callId: string
): Promise<RetryAuthResult> {
  if (!callId || typeof callId !== "string") return { ok: false, status: 400, error: "callId is required." };
  if (!token) return { ok: false, status: 401, error: "Sign in first." };
  const userId = await deps.getUserId(token);
  if (!userId) return { ok: false, status: 401, error: "Invalid session." };
  const ws = await deps.getProfileWorkspace(userId);
  if (!ws) return { ok: false, status: 401, error: "No workspace for this account." };
  const callWs = await deps.getCallWorkspace(callId);
  if (!callWs || callWs !== ws) return { ok: false, status: 404, error: "Call not found." };
  return { ok: true };
}
