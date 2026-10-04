import type { NextRequest } from "next/server";
import { knowledgeDeps } from "@/lib/knowledge-server";
import { withKnowledge } from "@/lib/knowledge-route";
import { deleteResource, getResourceDetail, updateResource } from "@/lib/knowledge-service";

// One knowledge resource. GET: any member. PATCH / DELETE: owner/manager.
// An id outside the caller's workspace is a 404, indistinguishable from a missing one.
export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withKnowledge(knowledgeDeps(req), "read", "detail", ({ ws, store }) => getResourceDetail(store, ws, id));
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  return withKnowledge(knowledgeDeps(req), "write", "update", ({ ws, userId, store }) => updateResource(store, ws, userId, id, body));
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withKnowledge(knowledgeDeps(req), "write", "delete", ({ ws, store }) => deleteResource(store, ws, id));
}
