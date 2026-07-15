import { NextRequest, NextResponse } from "next/server";
import { getHfxCreds, hfxCall, hfxConfigured, hfxFlatRow, hfxMetric, hfxRowHasMetrics, hfxRows, type HfxCreds } from "@/lib/hyperfx";

// One row per ad platform (Meta, Google, TikTok, Snapchat, LinkedIn, Reddit,
// Amazon): is it connected, the account name, and last-30-day spend — so the
// clinic sees all their ads at a glance above the Meta Ads tab. Best-effort per
// platform; anything not connected simply reports connected: false.
export const runtime = "nodejs";
export const maxDuration = 60;

/* eslint-disable @typescript-eslint/no-explicit-any */

interface PlatformStatus { id: string; label: string; connected: boolean; account: string | null; spend: number | null; currency: string; note?: string }
const sum = (rows: any[], key: string) => rows.reduce((s, r) => s + hfxMetric(hfxFlatRow(r), key), 0);

async function meta(creds: HfxCreds): Promise<PlatformStatus> {
  const base = { id: "meta", label: "Meta", connected: false, account: null as string | null, spend: null as number | null, currency: "USD" };
  const acc = await hfxCall("meta_business_list_ad_accounts", { detail: "core" }, creds);
  if (!acc.ok) return base;
  const accounts: any[] = (acc.data as any)?.accounts ?? [];
  if (!accounts.length) return { ...base, connected: true, note: "no ad accounts" };
  const a = accounts[0];
  const actId = String(a.id ?? "").startsWith("act_") ? String(a.id) : `act_${a.id}`;
  const ins = await hfxCall("meta_business_ad_insights", { object_id: actId, object_type: "account", date_preset: "last_30d", include_actions: false }, creds);
  const spend = ins.ok ? sum(hfxRows(ins.data).filter(hfxRowHasMetrics), "spend") : null;
  return { ...base, connected: true, account: a.name ?? a.id, spend, currency: a.currency ?? "USD" };
}

async function google(creds: HfxCreds): Promise<PlatformStatus> {
  const base = { id: "google", label: "Google", connected: false, account: null as string | null, spend: null as number | null, currency: "USD" };
  const acc = await hfxCall("google_ads_list_accounts", {}, creds);
  if (!acc.ok) return base;
  const accounts: any[] = ((acc.data as any)?.accounts ?? []).filter((x: any) => !x.error && !x.manager);
  if (!accounts.length) return { ...base, connected: true, note: "no accounts" };
  const a = accounts[0];
  const perf = await hfxCall("google_ads_get_campaign_performance", { customer_id: String(a.customer_id ?? a.id), date_range: "LAST_30_DAYS" }, creds);
  const rows: any[] = perf.ok && Array.isArray(perf.data) ? (perf.data as any[]).filter((r) => !r.error) : [];
  const spend = rows.length ? rows.reduce((s, r) => s + (Number(r.cost_micros) || 0) / 1_000_000, 0) : null;
  return { ...base, connected: true, account: a.descriptive_name ?? a.name ?? a.id, spend };
}

// Generic list-accounts probe for platforms whose report shapes we can't rely on
// yet — reports connection + account name; spend best-effort from any obvious field.
async function probe(creds: HfxCreds, id: string, label: string, listTool: string, accountsKey: string): Promise<PlatformStatus> {
  const base = { id, label, connected: false, account: null as string | null, spend: null as number | null, currency: "USD" };
  const r = await hfxCall(listTool, {}, creds);
  if (!r.ok) return base;
  const rows: any[] = Array.isArray(r.data) ? r.data : ((r.data as any)?.[accountsKey] ?? (r.data as any)?.data ?? (r.data as any)?.accounts ?? []);
  if (!rows.length) return { ...base, connected: true, note: "no accounts" };
  const a = rows[0];
  return { ...base, connected: true, account: a.name ?? a.advertiser_name ?? a.id ?? null };
}

export async function GET(req: NextRequest) {
  const creds = await getHfxCreds(req.nextUrl.searchParams.get("ws"));
  if (!hfxConfigured(creds)) return NextResponse.json({ configured: false, platforms: [] }, { status: 400 });

  const platforms = await Promise.all([
    meta(creds),
    google(creds),
    probe(creds, "tiktok", "TikTok", "tiktok_marketing_list_ad_accounts", "ad_accounts"),
    probe(creds, "snapchat", "Snapchat", "snapchat_list_ad_accounts", "ad_accounts"),
    probe(creds, "linkedin", "LinkedIn", "linkedin_ads_list_ad_accounts", "ad_accounts"),
  ]);

  return NextResponse.json({ configured: true, platforms });
}
