import { NextRequest, NextResponse } from "next/server";
import { getHfxCreds, hfxCall, hfxConfigured } from "@/lib/hyperfx";

// One campaign's full picture, Meta-style: the campaign → its ad sets → their
// ads, plus a last-30-days daily performance series for the overview graph.
// Read-only; management actions live in ../manage.
export const runtime = "nodejs";

/* eslint-disable @typescript-eslint/no-explicit-any */

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const VALID_PRESETS = new Set(["today", "yesterday", "last_7d", "last_14d", "last_28d", "last_30d", "last_90d"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Same Meta-style range selection as the list route: preset or custom since/until.
function rangeArgs(req: NextRequest): Record<string, unknown> {
  const since = req.nextUrl.searchParams.get("since") ?? "";
  const until = req.nextUrl.searchParams.get("until") ?? "";
  if (DATE_RE.test(since) && DATE_RE.test(until)) return { time_range: { since, until } };
  const preset = req.nextUrl.searchParams.get("preset") ?? "";
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

  // Ad sets (budget often lives here, not on the campaign) + their ads.
  const rawSets: any[] = adsetsRes.ok
    ? (Array.isArray(adsetsRes.data) ? adsetsRes.data : (adsetsRes.data as any)?.ad_sets ?? (adsetsRes.data as any)?.adsets ?? (adsetsRes.data as any)?.data ?? [])
    : [];
  const adsets = await Promise.all(
    rawSets.slice(0, 10).map(async (s: any) => {
      const adsRes = await hfxCall("meta_business_get_ads", { ad_set_id: String(s.id), limit: 25 }, creds);
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
        ads: rawAds.map((a: any) => ({ id: String(a.id ?? ""), name: a.name ?? "Ad", status: a.effective_status ?? a.status ?? "—" })),
      };
    })
  );

  // Daily series for the graph + totals.
  const rawDaily: any[] = dailyRes.ok
    ? (Array.isArray(dailyRes.data) ? dailyRes.data : (dailyRes.data as any)?.data ?? [])
    : [];
  const daily = rawDaily
    .map((r: any) => ({
      date: String(r.date_start ?? r.date ?? "").slice(0, 10),
      spend: num(r.spend),
      impressions: num(r.impressions),
      clicks: num(r.clicks),
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
