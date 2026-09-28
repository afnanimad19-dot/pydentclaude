// Which Pydent agent a LiveKit worker job runs — pure, fail-closed.
//
// The dispatch metadata MUST name the agent ({ pydentAgentId, ws }). There is
// deliberately NO fallback: an earlier version picked the workspace's OLDEST
// voice agent when pydentAgentId was missing, which could silently answer a
// production call with the wrong agent. A missing/invalid id, an unknown agent,
// or an agent outside the caller's workspace is refused.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WorkerAgentLookupDeps {
  /** A VOICE agent by id (any workspace), or null. */
  getVoiceAgent: (id: string) => Promise<{ id: string; workspace_id: string | null; [k: string]: unknown } | null>;
}

export type WorkerAgentLookup<A> =
  | { ok: true; agent: A; workspaceId: string }
  | { ok: false; status: 400 | 403 | 404; error: string };

export async function resolveWorkerAgent<A extends { id: string; workspace_id: string | null }>(
  deps: { getVoiceAgent: (id: string) => Promise<A | null> },
  input: { tokenWorkspace?: string | null; bodyWorkspace?: unknown; pydentAgentId?: unknown }
): Promise<WorkerAgentLookup<A>> {
  const id = typeof input.pydentAgentId === "string" ? input.pydentAgentId.trim() : "";
  if (!id || !UUID_RE.test(id)) return { ok: false, status: 400, error: "pydentAgentId is required in the dispatch metadata." };
  const bodyWs = typeof input.bodyWorkspace === "string" ? input.bodyWorkspace.trim() : "";
  const tokenWs = String(input.tokenWorkspace ?? "").trim();
  // A per-workspace worker token pins the worker to its own clinic.
  if (tokenWs && bodyWs && bodyWs !== tokenWs) return { ok: false, status: 403, error: "Agent does not belong to this workspace." };
  const ws = tokenWs || bodyWs;
  if (!ws) return { ok: false, status: 400, error: "ws is required in the dispatch metadata." };
  const agent = await deps.getVoiceAgent(id);
  if (!agent) return { ok: false, status: 404, error: "No voice agent found for this call." };
  if (String(agent.workspace_id ?? "") !== ws) return { ok: false, status: 403, error: "Agent does not belong to this workspace." };
  return { ok: true, agent, workspaceId: ws };
}
