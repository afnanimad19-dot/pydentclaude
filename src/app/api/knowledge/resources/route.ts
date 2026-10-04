import type { NextRequest } from "next/server";
import { knowledgeDeps } from "@/lib/knowledge-server";
import { withKnowledge } from "@/lib/knowledge-route";
import { createResource, listResources } from "@/lib/knowledge-service";

// Central Knowledge Base resources. GET: any workspace member. POST: owner/manager.
// The workspace is always the caller's session workspace.
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  return withKnowledge(knowledgeDeps(req), "read", "list", ({ ws, store }) =>
    listResources(store, ws, { q: sp.get("q"), type: sp.get("type"), status: sp.get("status") })
  );
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  return withKnowledge(knowledgeDeps(req), "write", "create", ({ ws, userId, store }) => createResource(store, ws, userId, body));
}
