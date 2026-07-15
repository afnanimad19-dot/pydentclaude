import { NextRequest, NextResponse } from "next/server";
import { getHfxCreds, hfxCall, hfxConfigured } from "@/lib/hyperfx";

// The app marketplace: every platform the marketing engine can connect
// (~85 toolkits — ads, social, CRM, email, calendars, scrapers, SEO), with
// each one's LIVE connected status for this clinic's engine account.
export const runtime = "nodejs";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Internal/dev toolkits a clinic should never see.
const HIDDEN = new Set([
  "agents", "sandbox", "database", "hyper_database", "knowledge_base", "github_toolkit",
  "sentry_toolkit", "linear_toolkit", "jira", "intersoft_toolkit", "zernio", "system_web_toolkit",
  "web_browsing_toolkit", "meeting_bot_toolkit", "geo_search",
]);

const CATEGORY: [RegExp, string][] = [
  [/ads|meta_business|tiktok_marketing|snapchat|amazon_ads|linkedin_ads/, "Advertising"],
  [/instagram|tiktok|linkedin|pinterest_toolkit|x_toolkit|youtube|twitter|reddit|telegram/, "Social media"],
  [/gmail|outlook|zoho|klaviyo|beehiiv|instantly|attentive|sendblue|twilio|microsoft_teams|teams/, "Email · SMS · Messaging"],
  [/hubspot|salesforce|leadconnector|apollo|mindbody|calendly|whop|stripe/, "CRM · Sales · Booking"],
  [/scraper|outscraper|firecrawl|web_scraper|search_scraper|trends|ecommerce/, "Research & scraping"],
  [/hyperseo|search_console|analytics|tag_manager|google_tag|appsflyer|website_analyzer/, "SEO & Analytics"],
  [/wordpress|webflow|wix|ghost|shopify|google_docs|google_drive|google_sheets|notion|slack|air|image_gen|video_generation|unipile|hightouch|calendar/, "Content · Docs · Other"],
];

function categorize(id: string): string {
  for (const [re, label] of CATEGORY) if (re.test(id)) return label;
  return "Content · Docs · Other";
}

export async function GET(req: NextRequest) {
  const creds = await getHfxCreds(req.nextUrl.searchParams.get("ws"));
  if (!hfxConfigured(creds)) {
    return NextResponse.json({ configured: false, apps: [], error: "Marketing engine isn't configured for this clinic yet." });
  }
  const r = await hfxCall("discover_toolkits", { query: "" }, creds);
  if (!r.ok) return NextResponse.json({ configured: true, apps: [], error: r.error }, { status: 502 });

  const raw = Array.isArray(r.data) ? (r.data as any[]) : [];
  const apps = raw
    .filter((t) => t?.id && !HIDDEN.has(t.id))
    .map((t) => ({
      id: String(t.id),
      name: String(t.name ?? t.id),
      description: String(t.description ?? "").slice(0, 140),
      // "Connected" means a REAL account link; no-auth built-ins are engine features, not connections.
      connected: !!t.requires_auth && !!t.authenticated,
      needsAuth: !!t.requires_auth,
      builtin: !t.requires_auth,
      toolCount: Array.isArray(t.tools) ? t.tools.length : 0,
      category: categorize(String(t.id)),
    }))
    .sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));

  return NextResponse.json({ configured: true, apps });
}
