import { NextRequest, NextResponse } from "next/server";
import { getHfxCreds, hfxCall, hfxConfigured } from "@/lib/hyperfx";

// Ads overview for Google Ads and TikTok Ads (the Meta tab has its own richer
// route at /api/hyperfx/meta). Same response shape as the Meta route so the UI
// can render any provider: accounts, campaigns, and a 30-day insights summary.
export const runtime = "nodejs";

/* eslint-disable @typescript-eslint/no-explicit-any */

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function notConnected(error?: string): boolean {
  return /auth|connect|permission|token|credential|unknown tool|not found|no .*account/i.test(error ?? "");
}

async function googleAds(creds: Awaited<ReturnType<typeof getHfxCreds>>) {
  const accountsRes = await hfxCall("google_ads_list_accounts", {}, creds);
  if (!accountsRes.ok) return { connected: !notConnected(accountsRes.error), error: accountsRes.error };
  const raw = (accountsRes.data as any)?.accounts ?? [];
  const accounts = raw
    .filter((a: any) => !a.error && !a.manager)
    .map((a: any) => ({ id: String(a.customer_id ?? a.id ?? ""), name: a.descriptive_name || a.name || a.id, status: "Active", currency: a.currency_code ?? "USD" }));

  const campaignsRes = await hfxCall("google_ads_list_my_campaigns", { limit: 50 }, creds);
  const campaigns = campaignsRes.ok
    ? (Array.isArray(campaignsRes.data) ? (campaignsRes.data as any[]) : []).filter((c) => !c.error).map((c: any) => ({
        id: String(c.id ?? ""),
        name: c.name ?? "Campaign",
        status: c.status ?? "—",
        objective: (c.advertising_channel_type ?? "—").toLowerCase(),
        dailyBudget: c.budget_amount != null ? num(c.budget_amount) / 1_000_000 : null,
        startTime: c.start_date ?? null,
      }))
    : [];

  let insights: { spend: number; impressions: number; clicks: number; ctr: number; cpc: number } | null = null;
  if (accounts.length) {
    const perfRes = await hfxCall("google_ads_get_campaign_performance", { customer_id: accounts[0].id, date_range: "LAST_30_DAYS" }, creds);
    if (perfRes.ok) {
      const rows = (Array.isArray(perfRes.data) ? (perfRes.data as any[]) : []).filter((r) => !r.error);
      if (rows.length) {
        const spend = rows.reduce((s, r) => s + num(r.cost_micros) / 1_000_000, 0);
        const impressions = rows.reduce((s, r) => s + num(r.impressions), 0);
        const clicks = rows.reduce((s, r) => s + num(r.clicks), 0);
        insights = { spend, impressions, clicks, ctr: impressions > 0 ? (clicks / impressions) * 100 : 0, cpc: clicks > 0 ? spend / clicks : 0 };
      }
    }
  }
  return { connected: true, accounts, account: accounts[0]?.id ?? "", campaigns, insights };
}

async function tiktokAds(creds: Awaited<ReturnType<typeof getHfxCreds>>) {
  const campaignsRes = await hfxCall("tiktok_get_campaigns", { page_size: 50 }, creds);
  if (!campaignsRes.ok) return { connected: !notConnected(campaignsRes.error), error: campaignsRes.error };
  const raw = (campaignsRes.data as any)?.campaigns ?? [];
  const campaigns = raw.map((c: any) => ({
    id: String(c.campaign_id ?? ""),
    name: c.campaign_name ?? "Campaign",
    status: c.status === "ENABLE" ? "ACTIVE" : c.status === "DISABLE" ? "PAUSED" : c.status ?? "—",
    objective: (c.objective_type ?? "—").replaceAll("_", " ").toLowerCase(),
    dailyBudget: c.budget != null && c.budget_mode === "BUDGET_MODE_DAY" ? num(c.budget) : null,
    startTime: c.created_time ?? null,
  }));
  const advertiser = raw[0]?.advertiser_id ? String(raw[0].advertiser_id) : "";
  return {
    connected: true,
    accounts: advertiser ? [{ id: advertiser, name: `Advertiser ${advertiser}`, status: "Active", currency: "USD" }] : [],
    account: advertiser,
    campaigns,
    insights: null, // TikTok reporting is an async report task — added later
  };
}

export async function GET(req: NextRequest) {
  const provider = req.nextUrl.searchParams.get("provider") ?? "google";
  const creds = await getHfxCreds(req.nextUrl.searchParams.get("ws"));
  if (!hfxConfigured(creds)) {
    return NextResponse.json({ configured: false, error: "Save this clinic's marketing-engine credentials in Settings → Connections first." }, { status: 400 });
  }
  const result = provider === "tiktok" ? await tiktokAds(creds) : await googleAds(creds);
  const status = "error" in result && result.error ? 502 : 200;
  return NextResponse.json({ configured: true, ...result }, { status });
}
