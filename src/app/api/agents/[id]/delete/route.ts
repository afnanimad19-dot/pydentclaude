import type { NextRequest } from "next/server";
import { withAgentManagement } from "@/lib/agent-management-route";
import { checkDeletion, deleteAgent } from "@/lib/agent-management";

// Delete a PYDENT agent only (owner / manager). Never reassigns or unlinks a
// number and never touches LiveKit, Vapi or any provider resource.
//   GET  → read-only safety check (blockers, typed-confirmation need, cascades)
//   POST → { confirm: true, confirmName? } re-runs every check, then deletes
export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withAgentManagement(req, ({ ws, deps }) => checkDeletion(deps, { workspaceId: ws, agentId: id }));
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return withAgentManagement(req, ({ ws, deps }) =>
    deleteAgent(deps, { workspaceId: ws, agentId: id, confirm: body.confirm, confirmName: body.confirmName })
  );
}
