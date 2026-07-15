import { NextRequest, NextResponse } from "next/server";
import { getHfxCreds, hfxCall, hfxConfigured, hfxRows } from "@/lib/hyperfx";

// Google Search Console reporting for the Reports tab — via the marketing
// engine. Clicks/impressions over time, top search queries (keywords), and
// breakdowns by country and device, normalized for the charts.
export const runtime = "nodejs";
export const maxDuration = 60;

/* eslint-disable @typescript-eslint/no-explicit-any */

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const iso = (d: Date) => d.toISOString().slice(0, 10);

// A GSC analytics row: {keys:[...], clicks, impressions, ctr, position} — keys[0]
// is the dimension value we queried by.
function gsc(row: any): { key: string; clicks: number; impressions: number; ctr: number; position: number } {
  const key = String((Array.isArray(row?.keys) ? row.keys[0] : row?.key ?? row?.query ?? row?.date ?? row?.country ?? row?.device) ?? "");
  return { key, clicks: num(row?.clicks), impressions: num(row?.impressions), ctr: num(row?.ctr), position: num(row?.position) };
}

async function query(creds: any, siteUrl: string, dimensions: string[], startDate: string, endDate: string, rowLimit = 25): Promise<any[]> {
  const args = { site_url: siteUrl, siteUrl, start_date: startDate, end_date: endDate, startDate, endDate, dimensions, row_limit: rowLimit, rowLimit };
  const r = await hfxCall("google_search_console_query_search_analytics", args, creds);
  if (!r.ok) return [];
  return hfxRows(r.data);
}

export async function GET(req: NextRequest) {
  const creds = await getHfxCreds(req.nextUrl.searchParams.get("ws"));
  if (!hfxConfigured(creds)) return NextResponse.json({ configured: false, error: "Marketing engine not configured." }, { status: 400 });

  const sites = await hfxCall("google_search_console_list_sites", {}, creds);
  if (!sites.ok) {
    const notConnected = /auth|connect|permission|token|unknown tool|not found|enable/i.test(sites.error ?? "");
    return NextResponse.json({ configured: true, connected: !notConnected, error: sites.error }, { status: 502 });
  }
  const siteRows = hfxRows(sites.data);
  const requested = req.nextUrl.searchParams.get("site");
  const siteUrl = String(requested || siteRows[0]?.siteUrl || siteRows[0]?.site_url || siteRows[0]?.url || "");
  if (!siteUrl) return NextResponse.json({ configured: true, connected: true, site: null, error: "No verified site found on this Search Console connection." });

  const end = iso(new Date(Date.now() - 2 * 86400000)); // GSC data lags ~2 days
  const start = iso(new Date(Date.now() - 30 * 86400000));

  const [dateRows, queryRows, countryRows, deviceRows] = await Promise.all([
    query(creds, siteUrl, ["date"], start, end, 90),
    query(creds, siteUrl, ["query"], start, end, 25),
    query(creds, siteUrl, ["country"], start, end, 10),
    query(creds, siteUrl, ["device"], start, end, 5),
  ]);

  const byDate = dateRows.map(gsc).map((r) => ({ date: r.key, clicks: r.clicks, impressions: r.impressions })).filter((r) => r.date).sort((a, b) => (a.date < b.date ? -1 : 1));
  const topQueries = queryRows.map(gsc).map((r) => ({ query: r.key, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })).filter((r) => r.query).sort((a, b) => b.clicks - a.clicks).slice(0, 20);
  const byCountry = countryRows.map(gsc).map((r) => ({ label: r.key, value: r.clicks })).filter((r) => r.label).sort((a, b) => b.value - a.value).slice(0, 8);
  const byDevice = deviceRows.map(gsc).map((r) => ({ label: r.key, value: r.clicks })).filter((r) => r.label).sort((a, b) => b.value - a.value);

  const totals = byDate.reduce((t, r) => ({ clicks: t.clicks + r.clicks, impressions: t.impressions + r.impressions }), { clicks: 0, impressions: 0 });
  const ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
  const avgPos = topQueries.length ? topQueries.reduce((s, q) => s + q.position, 0) / topQueries.length : 0;

  return NextResponse.json({
    configured: true, connected: true,
    site: siteUrl,
    sites: siteRows.map((s: any) => String(s.siteUrl || s.site_url || s.url || "")).filter(Boolean),
    totals: { ...totals, ctr, avgPos },
    byDate, topQueries, byCountry, byDevice,
  });
}
