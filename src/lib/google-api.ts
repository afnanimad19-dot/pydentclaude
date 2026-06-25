import { createClient } from "@supabase/supabase-js";

// Reads a clinic's stored Google token for a given product (google_analytics,
// google_search_console, …), refreshing it when expired. Server-only.

function admin() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://mzqynjywncbvqfikbzgm.supabase.co";
  if (!serviceKey) return null;
  return createClient(supabaseUrl, serviceKey);
}

export async function getValidGoogleToken(ws: string, provider: string): Promise<string | null> {
  const db = admin();
  if (!db) return null;
  const { data } = await db.from("oauth_tokens").select("access_token, refresh_token, expires_at").eq("workspace_id", ws).eq("provider", provider).maybeSingle();
  if (!data?.access_token) return null;
  const stillValid = data.expires_at && new Date(data.expires_at).getTime() > Date.now() + 60_000;
  if (stillValid) return data.access_token;

  // Refresh.
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!data.refresh_token || !clientId || !clientSecret) return data.access_token; // try the (possibly stale) token
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: data.refresh_token, grant_type: "refresh_token" }),
    });
    if (!res.ok) return data.access_token;
    const t = await res.json();
    if (t.access_token) {
      await db.from("oauth_tokens").update({ access_token: t.access_token, expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString() }).eq("workspace_id", ws).eq("provider", provider);
      return t.access_token;
    }
  } catch { /* ignore */ }
  return data.access_token;
}

const fmt = (d: Date) => d.toISOString().slice(0, 10);
function range(days: number) {
  const end = new Date();
  const start = new Date(Date.now() - days * 86400000);
  return { startDate: fmt(start), endDate: fmt(end) };
}

// GA4: find the first property, then run a basic traffic report.
export async function runAnalyticsReport(ws: string, days = 28): Promise<string> {
  const token = await getValidGoogleToken(ws, "google_analytics");
  if (!token) return "Google Analytics isn't connected. Connect it in Settings → Connections.";
  try {
    const acc = await fetch("https://analyticsadmin.googleapis.com/v1beta/accountSummaries", { headers: { Authorization: `Bearer ${token}` } });
    const accJson = await acc.json();
    if (!acc.ok) return `Analytics error: ${accJson?.error?.message ?? acc.status}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const property: string | undefined = accJson.accountSummaries?.flatMap((a: any) => a.propertySummaries ?? [])?.[0]?.property;
    if (!property) return "No GA4 property found on this Google account.";
    const { startDate, endDate } = range(days);
    const rep = await fetch(`https://analyticsdata.googleapis.com/v1beta/${property}:runReport`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        dateRanges: [{ startDate, endDate }],
        metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "screenPageViews" }],
        dimensions: [{ name: "pagePath" }],
        orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
        limit: 5,
      }),
    });
    const rj = await rep.json();
    if (!rep.ok) return `Analytics report error: ${rj?.error?.message ?? rep.status}`;
    const totals = rj.totals?.[0]?.metricValues ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const top = (rj.rows ?? []).map((r: any) => `  • ${r.dimensionValues?.[0]?.value} — ${r.metricValues?.[2]?.value} views`).join("\n");
    return `GA4 (${startDate} → ${endDate}): ${totals[0]?.value ?? 0} sessions, ${totals[1]?.value ?? 0} active users, ${totals[2]?.value ?? 0} pageviews.\nTop pages:\n${top || "  (none)"}`;
  } catch (e) {
    return `Analytics failed: ${e instanceof Error ? e.message : "error"}`;
  }
}

// Search Console: top PAGES (by clicks) for the verified site.
export async function runSearchConsolePages(ws: string, days = 28): Promise<string> {
  const token = await getValidGoogleToken(ws, "google_search_console");
  if (!token) return "Search Console isn't connected. Connect it in Settings → Connections.";
  try {
    const sitesRes = await fetch("https://www.googleapis.com/webmasters/v3/sites", { headers: { Authorization: `Bearer ${token}` } });
    const sitesJson = await sitesRes.json();
    if (!sitesRes.ok) return `Search Console error: ${sitesJson?.error?.message ?? sitesRes.status}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const site = (sitesJson.siteEntry ?? []).find((s: any) => s.permissionLevel !== "siteUnverifiedUser")?.siteUrl ?? sitesJson.siteEntry?.[0]?.siteUrl;
    if (!site) return "No verified site found in Search Console.";
    const { startDate, endDate } = range(days);
    const q = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ startDate, endDate, dimensions: ["page"], rowLimit: 5 }),
    });
    const qj = await q.json();
    if (!q.ok) return `Search Console query error: ${qj?.error?.message ?? q.status}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (qj.rows ?? []).map((r: any) => `  • ${r.keys?.[0]} — ${r.clicks} clicks, ${r.impressions} impressions, pos ${Math.round(r.position)}`).join("\n");
    return `Search Console for ${site} (${startDate} → ${endDate}) — top pages:\n${rows || "  (no data yet)"}`;
  } catch (e) {
    return `Search Console failed: ${e instanceof Error ? e.message : "error"}`;
  }
}

// Google Business Profile: publish a local post (update). Needs Business Profile
// API access (Google must allowlist your project) — surfaces a clear error if not.
export async function postToGoogleBusiness(ws: string, summary: string, ctaUrl?: string): Promise<string> {
  const token = await getValidGoogleToken(ws, "google_business");
  if (!token) return "Google Business Profile isn't connected. Connect it in Settings → Connections.";
  try {
    const accRes = await fetch("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", { headers: { Authorization: `Bearer ${token}` } });
    const accJson = await accRes.json();
    if (!accRes.ok) return `Business Profile error: ${accJson?.error?.message ?? accRes.status} (your Google project may need Business Profile API access).`;
    const account = accJson.accounts?.[0]?.name;
    if (!account) return "No Business Profile account found.";
    const locRes = await fetch(`https://mybusinessbusinessinformation.googleapis.com/v1/${account}/locations?readMask=name,title`, { headers: { Authorization: `Bearer ${token}` } });
    const locJson = await locRes.json();
    const location = locJson.locations?.[0]?.name;
    if (!location) return "No location found on this Business Profile.";
    const body: Record<string, unknown> = { languageCode: "en", summary: summary.slice(0, 1490), topicType: "STANDARD" };
    if (ctaUrl) body.callToAction = { actionType: "LEARN_MORE", url: ctaUrl };
    const postRes = await fetch(`https://mybusiness.googleapis.com/v4/${account}/${location}/localPosts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const pj = await postRes.json();
    if (!postRes.ok) return `Business Profile post failed: ${pj?.error?.message ?? postRes.status} (Business Profile posting requires Google API approval for your project).`;
    return "Posted an update to your Google Business Profile.";
  } catch (e) {
    return `Business Profile failed: ${e instanceof Error ? e.message : "error"}`;
  }
}

export async function runSearchConsoleReport(ws: string, days = 28): Promise<string> {
  const token = await getValidGoogleToken(ws, "google_search_console");
  if (!token) return "Search Console isn't connected. Connect it in Settings → Connections.";
  try {
    const sitesRes = await fetch("https://www.googleapis.com/webmasters/v3/sites", { headers: { Authorization: `Bearer ${token}` } });
    const sitesJson = await sitesRes.json();
    if (!sitesRes.ok) return `Search Console error: ${sitesJson?.error?.message ?? sitesRes.status}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const site = (sitesJson.siteEntry ?? []).find((s: any) => s.permissionLevel !== "siteUnverifiedUser")?.siteUrl ?? sitesJson.siteEntry?.[0]?.siteUrl;
    if (!site) return "No verified site found in Search Console.";
    const { startDate, endDate } = range(days);
    const q = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ startDate, endDate, dimensions: ["query"], rowLimit: 5 }),
    });
    const qj = await q.json();
    if (!q.ok) return `Search Console query error: ${qj?.error?.message ?? q.status}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (qj.rows ?? []).map((r: any) => `  • "${r.keys?.[0]}" — ${r.clicks} clicks, ${r.impressions} impressions, pos ${Math.round(r.position)}`).join("\n");
    return `Search Console for ${site} (${startDate} → ${endDate}) — top queries:\n${rows || "  (no data yet)"}`;
  } catch (e) {
    return `Search Console failed: ${e instanceof Error ? e.message : "error"}`;
  }
}
