import type { NextRequest } from "next/server";
import { withRouting } from "@/lib/number-routing-route";
import { getRoutingStatus, linkLivekitRoute, reconcileNumber } from "@/lib/number-routing";

// GET  — read-only routing status: database agent, verified routing agent, the
//        agent the provider ACTUALLY dispatches (live read), drift, eligibility.
//        Any workspace member.
// POST — admin-only, never writes to the provider:
//        { action: "link-livekit", trunkId, ruleId, idempotencyKey, protect? }
//            verify an EXISTING trunk + dispatch rule, then record them;
//        { action: "reconcile", idempotencyKey }
//            adopt the provider's verified routing into Pydent's records.
export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withRouting(req, { requireAdmin: false }, ({ ws, deps }) => getRoutingStatus(deps, ws, id));
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return withRouting(req, { requireAdmin: true }, async ({ ws, userId, deps }) => {
    const key = String(body.idempotencyKey ?? "");
    if (body.action === "link-livekit") {
      return linkLivekitRoute(deps, {
        workspaceId: ws,
        actorUserId: userId,
        numberId: id,
        trunkId: String(body.trunkId ?? ""),
        ruleId: String(body.ruleId ?? ""),
        idempotencyKey: key,
        protect: body.protect !== false,
      });
    }
    if (body.action === "reconcile") return reconcileNumber(deps, { workspaceId: ws, actorUserId: userId, numberId: id, idempotencyKey: key });
    return { httpStatus: 400, body: { ok: false, error: 'action must be "link-livekit" or "reconcile".' } };
  });
}
