import type { NextRequest } from "next/server";
import { withAgentManagement } from "@/lib/agent-management-route";
import { duplicateAgent } from "@/lib/agent-management";

// Duplicate a Pydent agent into a NEW Draft agent (owner / manager). Phone
// routing, provider ids and the LiveKit console binding are never copied.
// Body: { name, sections: { instructions, voice, tools, knowledge, callEnding } }
export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return withAgentManagement(req, ({ ws, deps }) =>
    duplicateAgent(deps, { workspaceId: ws, agentId: id, name: body.name, sections: body.sections })
  );
}
