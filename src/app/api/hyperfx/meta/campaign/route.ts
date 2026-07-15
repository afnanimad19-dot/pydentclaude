import { NextRequest, NextResponse } from "next/server";
import { getHfxCreds, hfxCall, hfxConfigured, hfxFlatRow, hfxMetric, hfxRowHasMetrics, hfxRows } from "@/lib/hyperfx";

// One campaign's full picture, Meta-style: the campaign → its ad sets → their
// ads, plus a last-30-days daily performance series for the overview graph.
// Read-only; management actions live in ../manage.
export const runtime = "nodejs";

/* eslint-disable @typescript-eslint/no-explicit-any */

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const VALID_PRESETS = new Set(["today", "yesterday", "last_7d", "last_14d", "last_28d", "last_30d", "last_90d", "maximum"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Same Meta-style range selection as the list route: preset or custom since/until.
// "maximum" becomes an explicit ~35-month range (the engine ignores that preset;
// Meta's API caps lookback at ~37 months).
function rangeArgs(req: NextRequest): Record<string, unknown> {
  const since = req.nextUrl.searchParams.get("since") ?? "";
  const until = req.nextUrl.searchParams.get("until") ?? "";
  if (DATE_RE.test(since) && DATE_RE.test(until)) return { time_range: { since, until } };
  const preset = req.nextUrl.searchParams.get("preset") ?? "";
  if (preset === "maximum") {
    const now = new Date();
    const start = new Date(now);
    start.setMonth(start.getMonth() - 35);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return { time_range: { since: iso(start), until: iso(now) } };
  }
  return { date_preset: VALID_PRESETS.has(preset) ? preset : "last_30d" };
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "Campaign id required." }, { status: 400 });
  const creds = await getHfxCreds(req.nextUrl.searchParams.get("ws"));
  if (!hfxConfigured(creds)) return NextResponse.json({ error: "Marketing engine not configured." }, { status: 400 });

  const [adsetsRes, dailyRes] = await Promise.all([
    hfxCall("meta_business_get_ad_sets", { campaign_id: id, limit: 25 }, creds),
    hfxCall("meta_business_ad_insights", { object_id: id, object_type: "campaign", time_increment: "1", include_actions: false, include_video_metrics: false, ...rangeArgs(req) }, creds),
  ]);

  // Ad sets (budget often lives here, not on the campaign) + their ads +
  // each set's own performance so the drawer can rank which performs best.
  const rawSets: any[] = adsetsRes.ok
    ? (Array.isArray(adsetsRes.data) ? adsetsRes.data : (adsetsRes.data as any)?.ad_sets ?? (adsetsRes.data as any)?.adsets ?? (adsetsRes.data as any)?.data ?? [])
    : [];

  // The engine's object_type naming for ad sets isn't documented — try both
  // spellings once and remember which one the server accepts.
  let adsetObjType: string | null = null;
  const rangeArgsMemo = rangeArgs(req);
  const RESULT_TYPES = ["lead", "onsite_conversion.lead_grouped", "onsite_conversion.total_messaging_connection", "onsite_conversion.messaging_conversation_started_7d", "purchase", "omni_purchase", "link_click"];
  async function adsetPerf(sid: string) {
    for (const t of adsetObjType ? [adsetObjType] : ["adset", "ad_set"]) {
      const r = await hfxCall("meta_business_ad_insights", { object_id: sid, object_type: t, include_actions: true, include_video_metrics: false, ...rangeArgsMemo }, creds);
      if (!r.ok) continue;
      adsetObjType = t;
      let spend = 0, impressions = 0, clicks = 0;
      const byType = new Map<string, number>();
      for (const raw of hfxRows(r.data).filter(hfxRowHasMetrics)) {
        const row = hfxFlatRow(raw);
        spend += hfxMetric(row, "spend"); impressions += hfxMetric(row, "impressions"); clicks += hfxMetric(row, "clicks");
        for (const a of Array.isArray(row.actions) ? row.actions : []) {
          const k = String(a?.action_type ?? "");
          byType.set(k, (byType.get(k) ?? 0) + num(a?.value));
        }
      }
      let results = 0;
      for (const rt of RESULT_TYPES) { const v = byType.get(rt); if (v && v > 0) { results = v; break; } }
      return { spend, impressions, clicks, results, ctr: impressions > 0 ? (clicks / impressions) * 100 : 0 };
    }
    return null;
  }

  const adsets = await Promise.all(
    rawSets.slice(0, 10).map(async (s: any) => {
      const [adsRes, perf] = await Promise.all([
        hfxCall("meta_business_get_ads", { ad_set_id: String(s.id), limit: 25 }, creds),
        adsetPerf(String(s.id)),
      ]);
      const rawAds: any[] = adsRes.ok
        ? (Array.isArray(adsRes.data) ? adsRes.data : (adsRes.data as any)?.ads ?? (adsRes.data as any)?.data ?? [])
        : [];
      return {
        id: String(s.id ?? ""),
        name: s.name ?? "Ad set",
        status: s.effective_status ?? s.status ?? "—",
        dailyBudget: s.daily_budget != null ? num(s.daily_budget) / 100 : null,
        lifetimeBudget: s.lifetime_budget != null ? num(s.lifetime_budget) / 100 : null,
        optimization: s.optimization_goal ?? null,
        perf,
        ads: rawAds.map((a: any) => ({ id: String(a.id ?? ""), name: a.name ?? "Ad", status: a.effective_status ?? a.status ?? "—" })),
      };
    })
  );

  // Daily series for the graph + totals.
  const rawDaily: any[] = dailyRes.ok ? hfxRows(dailyRes.data) : [];
  const daily = rawDaily
    .map(hfxFlatRow)
    .map((r: any) => ({
      date: String(r.date_start ?? r.date ?? r.date_stop ?? "").slice(0, 10),
      spend: hfxMetric(r, "spend"),
      impressions: hfxMetric(r, "impressions"),
      clicks: hfxMetric(r, "clicks"),
    }))
    .filter((r) => r.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const totals = daily.reduce(
    (t, r) => ({ spend: t.spend + r.spend, impressions: t.impressions + r.impressions, clicks: t.clicks + r.clicks }),
    { spend: 0, impressions: 0, clicks: 0 }
  );

  return NextResponse.json({
    ok: true,
    adsets,
    daily,
    totals: {
      ...totals,
      ctr: totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0,
      cpc: totals.clicks > 0 ? totals.spend / totals.clicks : 0,
    },
    adsetsError: adsetsRes.ok ? null : adsetsRes.error,
    insightsError: dailyRes.ok ? null : dailyRes.error,
  });
}
