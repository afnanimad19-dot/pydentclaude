import type { NextRequest } from "next/server";
import { knowledgeDeps } from "@/lib/knowledge-server";
import { withKnowledge } from "@/lib/knowledge-route";
import { duplicateResource } from "@/lib/knowledge-service";

// Duplicate a knowledge resource (owner/manager): the resource and all its
// documents are copied in ONE database transaction (no assignments copied).
export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withKnowledge(knowledgeDeps(req), "write", "duplicate", ({ ws, userId, store }) => duplicateResource(store, ws, userId, id));
}
