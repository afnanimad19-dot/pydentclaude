import type { NextRequest } from "next/server";
import { knowledgeDeps } from "@/lib/knowledge-server";
import { withKnowledge } from "@/lib/knowledge-route";
import { addUrl } from "@/lib/knowledge-service";

// Add (or re-fetch) a web address in a URL resource (owner/manager). Body: { url }.
// The page is fetched on the server through the Phase 0 SSRF boundary.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  return withKnowledge(knowledgeDeps(req), "write", "url_add", ({ ws, userId, store, importSite, now }) => addUrl(store, ws, userId, id, body, importSite, now));
}
