import { NextRequest, NextResponse } from "next/server";
import { getHfxCreds, hfxConfigured, hfxListTools } from "@/lib/hyperfx";

// Reports whether the Hyperfx backend is configured and reachable, and which
// platform toolkits are live on the connected MCP (by tool-name prefix), so the
// Connections card and the Meta Ads page can show accurate state.
export const runtime = "nodejs";

const PLATFORM_PREFIXES: Record<string, string> = {
  meta_business_: "Meta Ads",
  google_ads_: "Google Ads",
  google_calendar_: "Google Calendar",
  hyperseo_: "HyperSEO",
  tiktok_: "TikTok Ads",
  linkedin_ads_: "LinkedIn Ads",
  search_facebook_: "Meta Ads Library",
  google_sheets_: "Google Sheets",
};

export async function GET(req: NextRequest) {
  const creds = await getHfxCreds(req.nextUrl.searchParams.get("ws"));
  if (!hfxConfigured(creds)) {
    return NextResponse.json({ configured: false, ok: false, error: "No Hyperfx credentials — save this clinic's MCP URL + API key below, or set HYPERFX_MCP_URL / HYPERFX_API_KEY in Netlify." });
  }
  const r = await hfxListTools(creds);
  if (!r.ok) return NextResponse.json({ configured: true, ok: false, error: r.error });
  const platforms = new Set<string>();
  for (const t of r.tools ?? []) {
    for (const [prefix, label] of Object.entries(PLATFORM_PREFIXES)) {
      if (t.name.startsWith(prefix)) platforms.add(label);
    }
  }
  return NextResponse.json({ configured: true, ok: true, toolCount: r.tools?.length ?? 0, platforms: [...platforms].sort() });
}
