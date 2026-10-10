// /api/chat hardening (Phase 2C) — the PURE rules, unit-tested without HTTP.
//
// Trust model: the route authenticates the session (authorizeRequest) and the
// workspace is ALWAYS the session's — body.ws is ignored. A client may still
// supply draft agent fields (instructions, behavior, knowledgeBase): that is
// the dashboard's test-your-unsaved-edits flow, it is authenticated, scoped to
// the member's own workspace, and grants nothing — the legacy knowledgeBase
// was always client-shaped on this route. What a client can NEVER do is reach
// Central Knowledge with its own ids: central retrieval runs only for an
// `agentId` the server loaded from the SESSION workspace, and the injected
// retrieval field never comes from the body (guarded by tests).

import type { AgentReplyInput } from "@/lib/agent-reply";
import type { RetrievalResult } from "@/lib/kb-retrieval";

export const CHAT_MAX_MESSAGES = 40;
export const CHAT_MAX_MESSAGE_CHARS = 8000;
export const CHAT_RATE_WINDOW_MS = 60_000;
export const CHAT_RATE_MAX = 30;

export interface RateWindow {
  windowStart: number;
  count: number;
}

/**
 * Fixed-window per-user limiter. In-memory and therefore BEST-EFFORT on
 * serverless (each instance counts separately) — it bounds per-instance abuse
 * and accidental loops; it is not a billing control.
 */
export function consumeRateLimit(
  store: Map<string, RateWindow>,
  userId: string,
  now: number,
  opts: { windowMs?: number; max?: number } = {}
): boolean {
  const windowMs = opts.windowMs ?? CHAT_RATE_WINDOW_MS;
  const max = opts.max ?? CHAT_RATE_MAX;
  const w = store.get(userId);
  if (!w || now - w.windowStart >= windowMs) {
    store.set(userId, { windowStart: now, count: 1 });
    return true;
  }
  if (w.count >= max) return false;
  w.count++;
  return true;
}

/** Bounded, shape-checked chat history — anything else is dropped. */
export function sanitizeChatMessages(raw: unknown): { role: "user" | "assistant"; content: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const role = (m as Record<string, unknown>).role;
    const content = (m as Record<string, unknown>).content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
    out.push({ role, content: content.slice(0, CHAT_MAX_MESSAGE_CHARS) });
  }
  return out.slice(-CHAT_MAX_MESSAGES);
}

export interface ServerChatAgent {
  id: string;
  workspace_id: string;
  name: string | null;
  knowledge_base: string | null;
}

const optStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Build the AgentReplyInput for one authorized chat turn. `ws` is the SESSION
 * workspace; `serverAgent`/`retrieval` were resolved server-side (or are
 * absent). Client text fields pass through as the draft-testing flow requires;
 * ws and retrieval can never come from the body.
 */
export function buildChatInput(
  body: Record<string, unknown>,
  ws: string,
  serverAgent: ServerChatAgent | null,
  retrieval: RetrievalResult | null
): AgentReplyInput {
  const caps = (body.capabilities ?? {}) as Record<string, unknown>;
  return {
    model: optStr(body.model),
    ws,
    agentName: optStr(body.agentName) ?? serverAgent?.name ?? undefined,
    agentIdentity: optStr(body.agentIdentity),
    instructions: optStr(body.instructions),
    behavior: optStr(body.behavior),
    // Draft KB edits are testable; a saved agent with no client KB falls back
    // to its stored blob. Central agents ignore this entirely (1B semantics).
    knowledgeBase: optStr(body.knowledgeBase) ?? serverAgent?.knowledge_base ?? "",
    language: optStr(body.language),
    capabilities: { canBook: !!caps.canBook, canReschedule: !!caps.canReschedule, canCancel: !!caps.canCancel },
    patientContext: optStr(body.patientContext),
    sessionNote: optStr(body.sessionNote),
    messages: sanitizeChatMessages(body.messages),
    ...(retrieval ? { retrieval } : {}),
  };
}
