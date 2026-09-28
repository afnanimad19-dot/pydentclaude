import type { NextRequest } from "next/server";
import { withRouting } from "@/lib/number-routing-route";
import { rollbackAssignment } from "@/lib/number-routing";

// Restore the exact provider snapshot recorded before the most recent applied
// change (admin only). Refuses when the provider was changed since.
// Body: { assignmentId, idempotencyKey, confirmNumber? }
export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return withRouting(req, { requireAdmin: true }, ({ ws, userId, deps }) =>
    rollbackAssignment(deps, {
      workspaceId: ws,
      actorUserId: userId,
      numberId: id,
      assignmentId: String(body.assignmentId ?? ""),
      idempotencyKey: String(body.idempotencyKey ?? ""),
      confirmNumber: body.confirmNumber ? String(body.confirmNumber) : undefined,
    })
  );
}
