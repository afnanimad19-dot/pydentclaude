import { retrieveKnowledge, splitSources } from "@/lib/kb-retrieval";

// Authorization for the legacy /api/kb/* routes (pure; the route passes the
// real authorizeRequest from server-auth-deps). The workspace ALWAYS comes from
// the caller's verified session — a `ws` in the body or query is never trusted.
// Every route requires a signed-in workspace member, including the parse-only
// ones, so they can't be used as free OCR / parsing / crawling compute.

export type KbAuthResult =
  | { ok: true; userId: string; workspaceId: string }
  | { ok: false; status: 401 | 403; error: string };

export async function withKbAuth(
  authorize: () => Promise<KbAuthResult>,
  run: (ctx: { workspaceId: string; userId: string }) => Promise<Response>
): Promise<Response> {
  let auth: KbAuthResult;
  try {
    auth = await authorize();
  } catch {
    auth = { ok: false, status: 401, error: "Sign in first." };
  }
  if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status });
  return run({ workspaceId: auth.workspaceId, userId: auth.userId });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DebugAgentRow {
  id: string;
  name: string;
  workspace_id: string | null;
  knowledge_base: string | null;
  kb_files: string[] | null;
}

/**
 * Retrieval diagnostics for ONE agent of the caller's own workspace.
 * `findAgent` must be workspace-scoped; the row's workspace is re-checked here
 * too, and a `ws` the caller passes that differs from their session is refused.
 */
export async function kbRetrievalDebug(
  findAgent: (ws: string, key: { id?: string; name?: string }) => Promise<DebugAgentRow | null>,
  input: { workspaceId: string; requestedWs?: string | null; agentKey: string; q: string }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const requested = String(input.requestedWs ?? "").trim();
  if (requested && requested !== input.workspaceId) {
    return { status: 403, body: { error: "You can only inspect agents in your own workspace." } };
  }
  const agentKey = input.agentKey.trim();
  const q = input.q.trim();
  if (!agentKey || !q) return { status: 400, body: { error: "Pass ?agent=<agent name or id>&q=<question>." } };
  const agent = await findAgent(input.workspaceId, UUID_RE.test(agentKey) ? { id: agentKey } : { name: agentKey });
  if (!agent || String(agent.workspace_id ?? "") !== input.workspaceId) {
    return { status: 404, body: { error: "Agent not found in this workspace." } };
  }
  const kb = String(agent.knowledge_base ?? "");
  const sources = splitSources(kb).map((s) => ({ name: s.name, chars: s.text.length }));
  const terms = [...new Set(q.toLowerCase().match(/[a-zÀ-ɏ0-9]{3,}/gi) ?? [])];
  const lower = kb.toLowerCase();
  const termPresence = Object.fromEntries(terms.map((t) => [t, lower.includes(t)]));
  const r = retrieveKnowledge(kb, [q]);
  return {
    status: 200,
    body: {
      agent: agent.name,
      query: q,
      kbChars: kb.length,
      kbFiles: agent.kb_files ?? [],
      sources,
      termPresence,
      retrieval: { mode: r.mode, contextChars: r.contextChars, chunks: r.chunks },
    },
  };
}
