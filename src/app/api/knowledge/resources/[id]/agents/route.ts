import type { NextRequest } from "next/server";
import { knowledgeDeps } from "@/lib/knowledge-server";
import { withKnowledge } from "@/lib/knowledge-route";
import { assignAgent, listResourceAgents } from "@/lib/knowledge-service";

// Agent assignments of one knowledge resource (Phase 1A).
// GET: any member — the assigned agents plus the workspace's other agents for
// the picker. POST { agentId }: owner/manager — assign (idempotent).
// The workspace always comes from the signed-in session; a resource or agent
// of another workspace is a 404, indistinguishable from a missing one.
export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withKnowledge(knowledgeDeps(req), "read", "agents_list", ({ ws, store }) => listResourceAgents(store, ws, id));
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  return withKnowledge(knowledgeDeps(req), "write", "agent_assign", ({ ws, store }) => assignAgent(store, ws, id, body));
}
