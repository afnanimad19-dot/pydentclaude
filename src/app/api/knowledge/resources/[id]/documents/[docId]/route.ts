import type { NextRequest } from "next/server";
import { knowledgeDeps } from "@/lib/knowledge-server";
import { withKnowledge } from "@/lib/knowledge-route";
import { deleteDocument } from "@/lib/knowledge-service";

// Remove one document from a resource (owner/manager). The document must
// belong to this resource in the caller's workspace.
export const runtime = "nodejs";

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string; docId: string }> }) {
  const { id, docId } = await ctx.params;
  return withKnowledge(knowledgeDeps(req), "write", "document_delete", ({ ws, userId, store }) => deleteDocument(store, ws, userId, id, docId));
}
