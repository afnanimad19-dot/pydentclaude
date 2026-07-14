import { NextRequest, NextResponse } from "next/server";
import { getHfxCreds, hfxCall, hfxConfigured } from "@/lib/hyperfx";

// The Meta Ads tab's data: ad accounts, campaigns, and REAL performance for a
// Meta-style date range — either a preset (today / yesterday / last_7d / … /
// last_90d) or a custom since+until from the calendar picker. One campaign-level
// insights call returns each campaign's real spend/clicks AND the account totals.
export const runtime = "nodejs";

/* eslint-disable @typescript-eslint/no-explicit-any */

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const VALID_PRESETS = new Set(["today", "yesterday", "last_7d", "last_14d", "last_28d", "last_30d", "last_90d"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Range params → the insights tool's arguments (preset or custom time_range).
function rangeArgs(req: NextRequest): Record<string, unknown> {
  const since = req.nextUrl.searchParams.get("since") ?? "";
  const until = req.nextUrl.searchParams.get("until") ?? "";
  if (DATE_RE.test(since) && DATE_RE.test(until)) return { time_range: { since, until } };
  const preset = req.nextUrl.searchParams.get("preset") ?? "";
  return { date_preset: VALID_PRESETS.has(preset) ? preset : "last_30d" };
}

export async function GET(req: NextRequest) {
  const creds = await getHfxCreds(req.nextUrl.searchParams.get("ws"));
  if (!hfxConfigured(creds)) {
    return NextResponse.json({ configured: false, error: "Save this clinic's marketing-engine credentials in Settings → Connections, or set HYPERFX_MCP_URL / HYPERFX_API_KEY in Netlify." }, { status: 400 });
  }

  const accountsRes = await hfxCall("meta_business_list_ad_accounts", { detail: "summary" }, creds);
  if (!accountsRes.ok) {
    const notConnected = /auth|connect|permission|token|credential|unknown tool|not found/i.test(accountsRes.error ?? "");
    return NextResponse.json({ configured: true, connected: !notConnected, error: accountsRes.error }, { status: 502 });
  }
  const payload = accountsRes.data as any;
  const accounts = (payload?.accounts ?? []).map((a: any) => ({
    id: String(a.id ?? ""),
    name: a.name ?? a.id ?? "Ad account",
    status: a.account_status === 1 ? "Active" : a.account_status === 2 ? "Disabled" : "—",
    currency: a.currency ?? "USD",
    spentTotal: num(a.amount_spent) / 100, // lifetime, arrives in cents
  }));
  if (accounts.length === 0) {
    return NextResponse.json({ configured: true, connected: true, accounts: [], campaigns: [], insights: null });
  }

  const requested = req.nextUrl.searchParams.get("account");
  const account = accounts.find((a: any) => a.id === requested) ?? accounts[0];
  const actId = account.id.startsWith("act_") ? account.id : `act_${account.id}`;

  // Campaign-level insights for the selected range: one call → per-campaign real
  // numbers AND (summed) the account totals.
  const [campaignsRes, insightsRes] = await Promise.all([
    hfxCall("meta_business_search_campaigns", { account_id: account.id, detail: "summary", limit: 50 }, creds),
    hfxCall("meta_business_ad_insights", { object_id: actId, object_type: "account", level: "campaign", include_actions: false, include_video_metrics: false, ...rangeArgs(req) }, creds),
  ]);

  // Per-campaign performance map for the range.
  const perf = new Map<string, { spend: number; impressions: number; clicks: number }>();
  let totals: { spend: number; impressions: number; clicks: number } | null = null;
  if (insightsRes.ok) {
    const raw = insightsRes.data as any;
    const rows: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : raw && typeof raw === "object" ? [raw] : [];
    totals = { spend: 0, impressions: 0, clicks: 0 };
    for (const r of rows) {
      const row = { spend: num(r.spend), impressions: num(r.impressions), clicks: num(r.clicks) };
      totals.spend += row.spend;
      totals.impressions += row.impressions;
      totals.clicks += row.clicks;
      const cid = String(r.campaign_id ?? "");
      if (cid) {
        const prev = perf.get(cid) ?? { spend: 0, impressions: 0, clicks: 0 };
        perf.set(cid, { spend: prev.spend + row.spend, impressions: prev.impressions + row.impressions, clicks: prev.clicks + row.clicks });
      }
    }
  }

  const campaigns = campaignsRes.ok
    ? ((campaignsRes.data as any)?.campaigns ?? []).map((c: any) => {
        const p = perf.get(String(c.id ?? ""));
        return {
          id: String(c.id ?? ""),
          name: c.name ?? c.id ?? "Campaign",
          status: c.effective_status ?? c.status ?? "—",
          objective: c.objective ?? "—",
          dailyBudget: c.daily_budget != null ? num(c.daily_budget) / 100 : null,
          lifetimeBudget: c.lifetime_budget != null ? num(c.lifetime_budget) / 100 : null,
          startTime: c.start_time ?? null,
          // real delivery for the selected range (0 = ran but spent nothing; null = no insights)
          spend: insightsRes.ok ? (p?.spend ?? 0) : null,
          clicks: insightsRes.ok ? (p?.clicks ?? 0) : null,
          impressions: insightsRes.ok ? (p?.impressions ?? 0) : null,
        };
      })
    : [];

  return NextResponse.json({
    configured: true,
    connected: true,
    accounts,
    account: account.id,
    campaigns,
    insights: totals
      ? { ...totals, ctr: totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0, cpc: totals.clicks > 0 ? totals.spend / totals.clicks : 0 }
      : null,
    campaignsError: campaignsRes.ok ? null : campaignsRes.error,
    insightsError: insightsRes.ok ? null : insightsRes.error,
  });
}
