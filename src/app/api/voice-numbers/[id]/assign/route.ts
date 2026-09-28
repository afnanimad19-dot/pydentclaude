import type { NextRequest } from "next/server";
import { withRouting } from "@/lib/number-routing-route";
import { reassignNumber } from "@/lib/number-routing";

// Reassign a phone number to a voice agent — the guarded transaction in
// lib/number-routing.ts (admin only; workspace from the bearer token).
// Body: { targetAgentId, expectedCurrentAgentId, idempotencyKey, confirmNumber? }
export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return withRouting(req, { requireAdmin: true }, ({ ws, userId, deps }) =>
    reassignNumber(deps, {
      workspaceId: ws,
      actorUserId: userId,
      numberId: id,
      targetAgentId: body.targetAgentId ? String(body.targetAgentId) : null,
      expectedCurrentAgentId: body.expectedCurrentAgentId ? String(body.expectedCurrentAgentId) : null,
      idempotencyKey: String(body.idempotencyKey ?? ""),
      confirmNumber: body.confirmNumber ? String(body.confirmNumber) : undefined,
    })
  );
}
