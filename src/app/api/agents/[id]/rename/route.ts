import type { NextRequest } from "next/server";
import { withAgentManagement } from "@/lib/agent-management-route";
import { renameAgent } from "@/lib/agent-management";

// Rename a Pydent agent: updates agents.name ONLY (owner / manager).
// Body: { name }
export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return withAgentManagement(req, ({ ws, deps }) => renameAgent(deps, { workspaceId: ws, agentId: id, name: body.name }));
}
