import { NextRequest, NextResponse } from "next/server";
import { getHfxCreds, hfxCall, hfxConfigured } from "@/lib/hyperfx";

// The Meta Ads tab's data: ad accounts, the chosen account's campaigns, and its
// last-30-days performance — all through the Hyperfx meta_business toolkit
// (the Meta account is connected once on hyperfx.ai; no Meta keys live here).
export const runtime = "nodejs";

/* eslint-disable @typescript-eslint/no-explicit-any */

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export async function GET(req: NextRequest) {
  const creds = await getHfxCreds(req.nextUrl.searchParams.get("ws"));
  if (!hfxConfigured(creds)) {
    return NextResponse.json({ configured: false, error: "Save this clinic's Hyperfx credentials in Settings → Connections, or set HYPERFX_MCP_URL / HYPERFX_API_KEY in Netlify." }, { status: 400 });
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
    // amount_spent arrives in cents as a string.
    spentTotal: num(a.amount_spent) / 100,
  }));
  if (accounts.length === 0) {
    return NextResponse.json({ configured: true, connected: true, accounts: [], campaigns: [], insights: null });
  }

  const requested = req.nextUrl.searchParams.get("account");
  const account = accounts.find((a: any) => a.id === requested) ?? accounts[0];
  const actId = account.id.startsWith("act_") ? account.id : `act_${account.id}`;

  const [campaignsRes, insightsRes] = await Promise.all([
    hfxCall("meta_business_search_campaigns", { account_id: account.id, detail: "summary", limit: 50 }, creds),
    hfxCall("meta_business_ad_insights", { object_id: actId, object_type: "account", date_preset: "last_30d", include_actions: false, include_video_metrics: false }, creds),
  ]);

  const campaigns = campaignsRes.ok
    ? ((campaignsRes.data as any)?.campaigns ?? []).map((c: any) => ({
        id: String(c.id ?? ""),
        name: c.name ?? c.id ?? "Campaign",
        status: c.effective_status ?? c.status ?? "—",
        objective: c.objective ?? "—",
        dailyBudget: c.daily_budget != null ? num(c.daily_budget) / 100 : null,
        lifetimeBudget: c.lifetime_budget != null ? num(c.lifetime_budget) / 100 : null,
        startTime: c.start_time ?? null,
      }))
    : [];

  // Insights come back as {data:[rows]} or a bare array; sum whatever rows exist.
  let insights: { spend: number; impressions: number; clicks: number; ctr: number; cpc: number } | null = null;
  if (insightsRes.ok) {
    const raw = insightsRes.data as any;
    const rows: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : raw && typeof raw === "object" ? [raw] : [];
    if (rows.length) {
      const spend = rows.reduce((s, r) => s + num(r.spend), 0);
      const impressions = rows.reduce((s, r) => s + num(r.impressions), 0);
      const clicks = rows.reduce((s, r) => s + num(r.clicks), 0);
      insights = {
        spend,
        impressions,
        clicks,
        ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
        cpc: clicks > 0 ? spend / clicks : 0,
      };
    }
  }

  return NextResponse.json({
    configured: true,
    connected: true,
    accounts,
    account: account.id,
    campaigns,
    insights,
    campaignsError: campaignsRes.ok ? null : campaignsRes.error,
    insightsError: insightsRes.ok ? null : insightsRes.error,
  });
}
