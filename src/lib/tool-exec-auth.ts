// Machine-to-machine authorization for /api/agents/tool-exec — pure logic
// with an injected token resolver (bound to lib/livekit.ts resolveWorkerToken
// in the route), so every mode and mismatch is unit-testable without a DB.
//
// Why dual-mode: the deployed voice worker (livekit-agent/agent.py) already
// holds the per-workspace worker token (it cannot fetch its agent config
// without one — /api/livekit/agent-config verifies it), but its run_tool()
// call historically sent no credential. Requiring the token outright would
// break live calls until the worker is redeployed. Rollout:
//
//   1. Deploy the app with TOOL_EXEC_REQUIRE_AUTH unset (MONITOR mode):
//      requests without a token still work but are logged; any token that IS
//      presented is fully verified (a wrong or cross-workspace token is
//      rejected even in monitor mode — a bad credential is never a free pass).
//   2. Redeploy the worker (it now sends its token on every tool call).
//   3. Confirm the logs show authenticated calls only, then set
//      TOOL_EXEC_REQUIRE_AUTH=1 (STRICT mode): no token → 401, before any
//      agent lookup, so the endpoint no longer confirms whether an agent
//      UUID exists.
//
// Workspace rule in both modes: a token bound to a workspace may only act on
// agents of THAT workspace (same semantics as /api/livekit/agent-config and
// the Builder HTTP adapter). A valid but unbound global env token
// (LIVEKIT_WORKER_TOKEN fallback, single-clinic setups) authenticates the
// caller as the deployed worker; binding the token in Settings → LiveKit is
// the recommended configuration and is what makes cross-tenant access
// impossible even with a leaked env value.

export interface ToolExecAuthDeps {
  /** Verifies a worker token; ws is set when the token is workspace-bound. */
  resolveToken(token: unknown): Promise<{ ok: boolean; ws?: string; error?: string }>;
  /** Strict mode: reject requests that carry no token at all. */
  requireAuth: boolean;
}

export type ToolExecAuthResult =
  | { ok: true; tokenWorkspace: string | null; warn?: "unauthenticated" | "unbound_token" }
  | { ok: false; status: 401 | 403; error: string };

/** Token from the JSON body (`token`, the repo's worker convention) or an Authorization bearer. */
export function extractWorkerToken(body: unknown, authorizationHeader: string | null | undefined): string {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const fromBody = typeof b.token === "string" ? b.token.trim() : "";
  if (fromBody) return fromBody;
  const m = /^Bearer\s+(.+)$/i.exec(String(authorizationHeader ?? "").trim());
  return m ? m[1].trim() : "";
}

// `agentWorkspace: undefined` defers the workspace check (the route calls once
// before the agent lookup — so missing/invalid credentials are rejected without
// confirming the agent exists — and again with the agent's real workspace).
// `null` means the agent row HAS no workspace: a bound token then fails closed.
export async function authorizeToolExec(
  deps: ToolExecAuthDeps,
  input: { token: string; agentWorkspace: string | null | undefined }
): Promise<ToolExecAuthResult> {
  if (!input.token) {
    if (deps.requireAuth) return { ok: false, status: 401, error: "Missing worker token." };
    return { ok: true, tokenWorkspace: null, warn: "unauthenticated" }; // monitor mode: allowed, logged by the route
  }

  let resolved: { ok: boolean; ws?: string; error?: string };
  try {
    resolved = await deps.resolveToken(input.token);
  } catch {
    resolved = { ok: false };
  }
  // A presented credential must be valid in EVERY mode.
  if (!resolved.ok) return { ok: false, status: 401, error: "Invalid worker token." };

  // Workspace-bound token: only agents of that workspace, in EVERY mode.
  if (resolved.ws) {
    if (input.agentWorkspace !== undefined && resolved.ws !== input.agentWorkspace) {
      return { ok: false, status: 403, error: "This worker token does not belong to this agent's workspace." };
    }
    return { ok: true, tokenWorkspace: resolved.ws };
  }

  // Valid but unbound (global env fallback): authenticated as the deployed
  // worker, no tenant narrowing possible — flagged so the route can log it.
  return { ok: true, tokenWorkspace: null, warn: "unbound_token" };
}

export function toolExecAuthRequired(env: Record<string, string | undefined> = process.env): boolean {
  return env.TOOL_EXEC_REQUIRE_AUTH === "1";
}
