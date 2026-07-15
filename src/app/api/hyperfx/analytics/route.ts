import { NextRequest, NextResponse } from "next/server";
import { getHfxCreds, hfxCall, hfxConfigured, hfxRows } from "@/lib/hyperfx";

// Google Analytics (GA4) reporting for the Reports tab — via the marketing
// engine. Pulls sessions over time plus breakdowns by country, device, channel
// and top pages, normalized into arrays the charts can render.
export const runtime = "nodejs";
export const maxDuration = 60;

/* eslint-disable @typescript-eslint/no-explicit-any */

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// A GA4 report row can arrive flat ({date, sessions}) or as GA's raw
// {dimensionValues:[{value}], metricValues:[{value}]} — read both.
function ga(row: any, dimIdx: number, metricNames: string[], metricIdx: number): { dim: string; val: number } {
  if (row?.dimensionValues || row?.metricValues) {
    return { dim: String(row.dimensionValues?.[dimIdx]?.value ?? ""), val: num(row.metricValues?.[metricIdx]?.value) };
  }
  // flat: pick the dimension key we asked for and the metric by name
  const dimKeys = ["date", "country", "deviceCategory", "sessionDefaultChannelGroup", "pagePath"];
  const dimVal = row?.[dimKeys[dimIdx]] ?? Object.values(row ?? {})[0];
  return { dim: String(dimVal ?? ""), val: num(row?.[metricNames[metricIdx]]) };
}

async function runReport(creds: any, propertyId: string, dimensions: string[], metrics: string[]): Promise<any[]> {
  const args = {
    property_id: propertyId,
    property: propertyId.startsWith("properties/") ? propertyId : `properties/${propertyId}`,
    dimensions,
    metrics,
    date_range: "last_28_days",
    start_date: "28daysAgo",
    end_date: "today",
    limit: 25,
  };
  const r = await hfxCall("google_analytics_run_report", args, creds);
  if (!r.ok) return [];
  return hfxRows(r.data);
}

export async function GET(req: NextRequest) {
  const creds = await getHfxCreds(req.nextUrl.searchParams.get("ws"));
  if (!hfxConfigured(creds)) return NextResponse.json({ configured: false, error: "Marketing engine not configured." }, { status: 400 });

  // Resolve a GA4 property.
  const acct = await hfxCall("google_analytics_list_accounts", {}, creds);
  if (!acct.ok) {
    const notConnected = /auth|connect|permission|token|unknown tool|not found|enable/i.test(acct.error ?? "");
    return NextResponse.json({ configured: true, connected: !notConnected, error: acct.error }, { status: 502 });
  }
  const props = await hfxCall("google_analytics_list_properties", {}, creds);
  const propRows = props.ok ? hfxRows(props.data) : [];
  const property = String(propRows[0]?.property ?? propRows[0]?.id ?? propRows[0]?.name ?? "").replace(/^properties\//, "");
  if (!property) return NextResponse.json({ configured: true, connected: true, property: null, error: "No GA4 property found on this connection." });

  const [dateRows, countryRows, deviceRows, channelRows, pageRows] = await Promise.all([
    runReport(creds, property, ["date"], ["sessions", "activeUsers"]),
    runReport(creds, property, ["country"], ["sessions"]),
    runReport(creds, property, ["deviceCategory"], ["sessions"]),
    runReport(creds, property, ["sessionDefaultChannelGroup"], ["sessions"]),
    runReport(creds, property, ["pagePath"], ["screenPageViews"]),
  ]);

  const byDate = dateRows
    .map((r) => { const s = ga(r, 0, ["sessions", "activeUsers"], 0); const u = ga(r, 0, ["sessions", "activeUsers"], 1); const d = s.dim; return { date: /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d, sessions: s.val, users: u.val }; })
    .filter((r) => r.date).sort((a, b) => (a.date < b.date ? -1 : 1));
  const mapDim = (rows: any[], metrics: string[]) => rows.map((r) => { const g = ga(r, 0, metrics, 0); return { label: g.dim, value: g.val }; }).filter((r) => r.label && r.value > 0).sort((a, b) => b.value - a.value);

  const totals = byDate.reduce((t, r) => ({ sessions: t.sessions + r.sessions, users: t.users + r.users }), { sessions: 0, users: 0 });

  return NextResponse.json({
    configured: true,
    connected: true,
    property,
    totals,
    byDate,
    byCountry: mapDim(countryRows, ["sessions"]).slice(0, 8),
    byDevice: mapDim(deviceRows, ["sessions"]),
    byChannel: mapDim(channelRows, ["sessions"]).slice(0, 8),
    topPages: mapDim(pageRows, ["screenPageViews"]).slice(0, 10),
  });
}
