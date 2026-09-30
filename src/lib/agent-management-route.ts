import { NextResponse, type NextRequest } from "next/server";
import { authorizeRequest, serviceRoleConfigured } from "@/lib/server-auth-deps";
import { makeAgentMgmtDeps } from "@/lib/agent-management-server";
import { AGENT_MANAGER_ROLES, type AgentMgmtDeps, type MgmtOutcome } from "@/lib/agent-management";

// Shared plumbing for /api/agents/[id]/{rename,duplicate,delete}: the
// workspace ALWAYS comes from the bearer token (never the request body), only
// owners and managers may manage agents, and every failure is fail-closed.
export async function withAgentManagement(
  req: NextRequest,
  run: (ctx: { ws: string; userId: string; deps: AgentMgmtDeps }) => Promise<MgmtOutcome>
) {
  const auth = await authorizeRequest(req, {
    allowedRoles: AGENT_MANAGER_ROLES,
    roleError: "Only a workspace owner or manager can rename, duplicate or delete agents.",
  });
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  if (!serviceRoleConfigured()) {
    return NextResponse.json({ ok: false, error: "Server is missing SUPABASE_SERVICE_ROLE_KEY — agent management is disabled." }, { status: 503 });
  }
  try {
    const out = await run({ ws: auth.workspaceId, userId: auth.userId, deps: makeAgentMgmtDeps(auth.workspaceId) });
    return NextResponse.json(out.body, { status: out.httpStatus });
  } catch (e) {
    // Includes any verification that could not complete: nothing was changed.
    const msg = e instanceof Error ? e.message.slice(0, 300) : "Request failed.";
    return NextResponse.json({ ok: false, code: "verification_failed", error: `${msg} No changes were made.` }, { status: 500 });
  }
}
