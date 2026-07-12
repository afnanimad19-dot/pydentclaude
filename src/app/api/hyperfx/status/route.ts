import { NextRequest, NextResponse } from "next/server";
import { getHfxCreds, hfxCall, hfxConfigured, hfxListTools } from "@/lib/hyperfx";

// Reports whether the marketing engine is configured and reachable, and which
// platforms are CONNECTED (authenticated on the portal) — read from the live
// toolkit catalog, not from the session's enabled tools, so a freshly connected
// app shows up immediately. Tool enablement happens automatically on first use.
export const runtime = "nodejs";

/* eslint-disable @typescript-eslint/no-explicit-any */

const PLATFORM_TOOLKITS: Record<string, string> = {
  meta_business: "Meta Ads",
  google_ads: "Google Ads",
  google_calendar: "Google Calendar",
  google_analytics_toolkit: "Google Analytics",
  google_search_console_toolkit: "Search Console",
  hyperseo: "HyperSEO",
  tiktok_marketing: "TikTok Ads",
  tiktok: "TikTok",
  linkedin_ads_toolkit: "LinkedIn Ads",
  instagram_toolkit: "Instagram",
  meta_ads_library: "Meta Ads Library",
  gmail: "Gmail",
  google_sheets: "Google Sheets",
};

export async function GET(req: NextRequest) {
  const creds = await getHfxCreds(req.nextUrl.searchParams.get("ws"));
  if (!hfxConfigured(creds)) {
    return NextResponse.json({ configured: false, ok: false, error: "No Hyperfx credentials — save this clinic's MCP URL + API key below, or set HYPERFX_MCP_URL / HYPERFX_API_KEY in Netlify." });
  }

  // Connected platforms come from the catalog's authenticated flags; the tool
  // count comes from the session's enabled tools (informational only).
  const [catalog, toolsRes] = await Promise.all([
    hfxCall("discover_toolkits", { query: "" }, creds),
    hfxListTools(creds),
  ]);
  if (!catalog.ok && !toolsRes.ok) {
    return NextResponse.json({ configured: true, ok: false, error: catalog.error ?? toolsRes.error });
  }

  const platforms: string[] = [];
  if (catalog.ok && Array.isArray(catalog.data)) {
    for (const t of catalog.data as any[]) {
      const label = PLATFORM_TOOLKITS[t?.id];
      if (label && t?.authenticated) platforms.push(label);
    }
  }

  return NextResponse.json({
    configured: true,
    ok: true,
    toolCount: toolsRes.ok ? toolsRes.tools?.length ?? 0 : 0,
    platforms: platforms.sort(),
  });
}
