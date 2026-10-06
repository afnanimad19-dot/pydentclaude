import type { NextRequest } from "next/server";
import { knowledgeDeps } from "@/lib/knowledge-server";
import { withKnowledge } from "@/lib/knowledge-route";
import { unassignAgent } from "@/lib/knowledge-service";

// Remove one agent assignment from a resource (owner/manager). Workspace-scoped:
// an assignment, resource or agent of another workspace reads as a 404.
export const runtime = "nodejs";

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string; agentId: string }> }) {
  const { id, agentId } = await ctx.params;
  return withKnowledge(knowledgeDeps(req), "write", "agent_unassign", ({ ws, store }) => unassignAgent(store, ws, id, agentId));
}
