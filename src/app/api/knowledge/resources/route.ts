import type { NextRequest } from "next/server";
import { knowledgeDeps } from "@/lib/knowledge-server";
import { withKnowledge, withViewer } from "@/lib/knowledge-route";
import { createResource, listResources } from "@/lib/knowledge-service";

// Central Knowledge Base resources. GET: any workspace member. POST: owner/manager.
// The workspace is always the caller's session workspace.
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  // `viewer.canManage` comes from the session role only (UI hint; mutations re-check).
  return withKnowledge(knowledgeDeps(req), "read", "list", async ({ ws, store, role }) =>
    withViewer(await listResources(store, ws, { q: sp.get("q"), type: sp.get("type"), status: sp.get("status") }), role)
  );
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  return withKnowledge(knowledgeDeps(req), "write", "create", ({ ws, userId, store }) => createResource(store, ws, userId, body));
}
