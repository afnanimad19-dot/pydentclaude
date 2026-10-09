import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/server-auth-deps";
import { withKbAuth } from "@/lib/kb-auth";
import { defaultWebsiteDeps, engineFetchForWorkspace, importWebsite, websiteResponse } from "@/lib/kb-website";

// Fetches a clinic's website and returns its readable text, so an agent can
// learn from it (hours, services, pricing, FAQs). The import itself — Firecrawl
// → bounded same-domain crawl → engine fallback, all behind the Phase 0 SSRF
// boundary — lives in lib/kb-website.ts (shared with the Central Knowledge
// Base); this route only handles HTTP.
//
// Security: requires a signed-in workspace member; the workspace (for engine
// credentials) comes from the session, never the body.

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  return withKbAuth(() => authorizeRequest(req), ({ workspaceId }) => handle(req, workspaceId));
}

async function handle(req: NextRequest, ws: string) {
  // Any `ws` in the body is ignored — the workspace is the caller's session.
  const { url } = await req.json().catch(() => ({}));
  const out = websiteResponse(await importWebsite(url, defaultWebsiteDeps(engineFetchForWorkspace(ws))));
  return NextResponse.json(out.body, { status: out.status });
}
