// Worker-token resolution ordering — pure and dependency-injected so the
// precedence can be regression-tested without a database.
//
// Order matters: the WORKSPACE binding is resolved first. A token generated
// in Settings → LiveKit must always resolve to its workspace, even when the
// same value is also set as the global LIVEKIT_WORKER_TOKEN env var (the
// common single-clinic setup, where one token is distributed to both the
// deployed worker and the server env). If the env match ran first it would
// shadow the workspace binding, returning an authenticated-but-unbound
// result — which the Builder adapter (correctly, fail-closed) refuses.
// The env token is only a fallback for a value no workspace owns.

export interface WorkerTokenDeps {
  /** Current value of process.env.LIVEKIT_WORKER_TOKEN ("" when unset). */
  envToken: string;
  /** Returns the workspace_id owning livekit_config.worker_token === token, else null. */
  lookupWorkspace(token: string): Promise<string | null>;
}

export async function resolveWorkerTokenOrdered(
  token: unknown,
  deps: WorkerTokenDeps
): Promise<{ ok: boolean; ws?: string; error?: string }> {
  const t = String(token ?? "").trim();
  if (!t) return { ok: false, error: "Missing worker token." };
  try {
    const ws = await deps.lookupWorkspace(t);
    if (ws) return { ok: true, ws: String(ws) };
  } catch {
    /* column may not be migrated yet — fall through to the env fallback */
  }
  const envTok = (deps.envToken || "").trim();
  if (envTok && t === envTok) return { ok: true };
  return { ok: false, error: "Unauthorized worker — generate the worker token in Pydent → Settings → LiveKit and put it in the worker's LIVEKIT_WORKER_TOKEN." };
}
