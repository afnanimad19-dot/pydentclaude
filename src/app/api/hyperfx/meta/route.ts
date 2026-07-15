import { NextRequest, NextResponse } from "next/server";
import { getHfxCreds, hfxCall, hfxConfigured, hfxListTools, hfxRows } from "@/lib/hyperfx";
import { supabaseAdmin } from "@/lib/supabase-admin";

// The Meta Ads tab's data: ad accounts, campaigns (with Meta's issues +
// recommendations), and REAL performance for a Meta-style date range — spend,
// impressions, clicks, RESULTS (leads / messages / purchases / link clicks,
// picked by each campaign's objective) and cost per result.
export const runtime = "nodejs";
export const maxDuration = 60;

/* eslint-disable @typescript-eslint/no-explicit-any */

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const VALID_PRESETS = new Set(["today", "yesterday", "last_7d", "last_14d", "last_28d", "last_30d", "last_90d", "maximum"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function rangeArgs(req: NextRequest): Record<string, unknown> {
  const since = req.nextUrl.searchParams.get("since") ?? "";
  const until = req.nextUrl.searchParams.get("until") ?? "";
  if (DATE_RE.test(since) && DATE_RE.test(until)) return { time_range: { since, until } };
  const preset = req.nextUrl.searchParams.get("preset") ?? "";
  return { date_preset: VALID_PRESETS.has(preset) ? preset : "last_30d" };
}

// Which insights "action" counts as the RESULT for each objective (priority order).
const RESULT_PRIORITY: Record<string, string[]> = {
  OUTCOME_LEADS: ["lead", "onsite_conversion.lead_grouped", "leadgen_grouped", "onsite_conversion.messaging_conversation_started_7d", "link_click"],
  OUTCOME_ENGAGEMENT: ["onsite_conversion.messaging_conversation_started_7d", "post_engagement", "page_engagement", "video_view", "link_click"],
  OUTCOME_TRAFFIC: ["link_click", "landing_page_view"],
  OUTCOME_SALES: ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase", "onsite_conversion.purchase", "lead", "link_click"],
  OUTCOME_APP_PROMOTION: ["mobile_app_install", "app_install", "omni_app_install", "link_click"],
  OUTCOME_AWARENESS: [],
};
const RESULT_LABEL: Record<string, string> = {
  lead: "Leads",
  "onsite_conversion.lead_grouped": "Leads",
  leadgen_grouped: "Leads",
  "onsite_conversion.messaging_conversation_started_7d": "Messages",
  post_engagement: "Engagements",
  page_engagement: "Engagements",
  video_view: "Video views",
  link_click: "Link clicks",
  landing_page_view: "Page views",
  purchase: "Purchases",
  omni_purchase: "Purchases",
  "offsite_conversion.fb_pixel_purchase": "Purchases",
  "onsite_conversion.purchase": "Purchases",
  mobile_app_install: "Installs",
  app_install: "Installs",
  omni_app_install: "Installs",
};

function pickResult(objective: string, actions: any[], reach: number, impressions: number): { results: number; label: string } {
  if (objective === "OUTCOME_AWARENESS") return { results: reach || impressions, label: "Reach" };
  const priorities = RESULT_PRIORITY[objective] ?? ["link_click"];
  const byType = new Map<string, number>();
  for (const a of Array.isArray(actions) ? actions : []) byType.set(String(a?.action_type ?? ""), num(a?.value));
  for (const p of priorities) {
    const v = byType.get(p);
    if (v !== undefined && v > 0) return { results: v, label: RESULT_LABEL[p] ?? "Results" };
  }
  const first = priorities.find((p) => RESULT_LABEL[p]);
  return { results: 0, label: first ? RESULT_LABEL[first] : "Results" };
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
  }));
  if (accounts.length === 0) {
    return NextResponse.json({ configured: true, connected: true, accounts: [], campaigns: [], insights: null });
  }

  const requested = req.nextUrl.searchParams.get("account");
  let account = accounts.find((a: any) => a.id === requested) ?? null;

  // No explicit choice: don't blindly take the first ad account — with several
  // accounts (e.g. an old/empty one first) that shows a blank page while the
  // real campaigns live on another. Probe each and pick the one with campaigns,
  // preferring one that has an ACTIVE campaign.
  if (!account) {
    if (accounts.length === 1) {
      account = accounts[0];
    } else {
      const probes = await Promise.all(
        accounts.slice(0, 5).map((a: any) =>
          hfxCall("meta_business_search_campaigns", { account_id: a.id, detail: "summary", limit: 25 }, creds).then((r) => ({
            a,
            camps: (r.ok ? ((r.data as any)?.campaigns ?? []) : []) as any[],
          }))
        )
      );
      const withActive = probes.find((p) => p.camps.some((c: any) => /ACTIVE/i.test(String(c.effective_status ?? c.status ?? ""))));
      const withAny = probes.find((p) => p.camps.length > 0);
      account = (withActive ?? withAny)?.a ?? accounts[0];
    }
  }
  const actId = account.id.startsWith("act_") ? account.id : `act_${account.id}`;

  // "full" detail so campaigns carry Meta's issues_info + recommendations;
  // include_actions so results (leads/messages/purchases) come back.
  const [campaignsRes, insightsRes, adLevelRes] = await Promise.all([
    hfxCall("meta_business_search_campaigns", { account_id: account.id, detail: "full", limit: 50 }, creds),
    hfxCall("meta_business_ad_insights", { object_id: actId, object_type: "account", level: "campaign", include_actions: true, include_video_metrics: false, ...rangeArgs(req) }, creds),
    // ad-level breakdown: counts how many ads actually delivered in the range
    hfxCall("meta_business_ad_insights", { object_id: actId, object_type: "account", level: "ad", include_actions: false, include_video_metrics: false, ...rangeArgs(req) }, creds),
  ]);

  const perf = new Map<string, { spend: number; impressions: number; clicks: number; reach: number; actions: any[] }>();
  let totals: { spend: number; impressions: number; clicks: number } | null = null;
  let insightsNote: string | null = null;
  let adsCount: number | null = null;
  if (adLevelRes.ok) {
    const adIds = new Set(hfxRows(adLevelRes.data).map((r: any) => String(r?.ad_id ?? "")).filter(Boolean));
    if (adIds.size > 0) adsCount = adIds.size;
  }

  const addRow = (cid: string, r: any) => {
    const row = { spend: num(r.spend), impressions: num(r.impressions), clicks: num(r.clicks), reach: num(r.reach), actions: r.actions ?? [] };
    const prev = perf.get(cid);
    if (prev) {
      prev.spend += row.spend; prev.impressions += row.impressions; prev.clicks += row.clicks; prev.reach += row.reach;
      prev.actions = [...prev.actions, ...row.actions];
    } else if (cid) {
      perf.set(cid, row);
    }
    return row;
  };

  if (insightsRes.ok) {
    const rows: any[] = hfxRows(insightsRes.data).filter((r: any) => r && (r.spend !== undefined || r.impressions !== undefined));
    totals = { spend: 0, impressions: 0, clicks: 0 };
    for (const r of rows) {
      const row = addRow(String(r.campaign_id ?? ""), r);
      totals.spend += row.spend;
      totals.impressions += row.impressions;
      totals.clicks += row.clicks;
    }
  }

  // FALLBACK: some accounts return nothing for the account-level campaign
  // breakdown while direct per-campaign insights work fine (the drawer's path).
  // If the rollup came back empty but campaigns exist, query each campaign
  // directly and rebuild the totals from those.
  const campaignRowsRaw: any[] = campaignsRes.ok ? ((campaignsRes.data as any)?.campaigns ?? []) : [];
  if ((!totals || (totals.spend === 0 && totals.impressions === 0)) && campaignRowsRaw.length > 0) {
    const ids = campaignRowsRaw.map((c: any) => String(c.id ?? "")).filter(Boolean).slice(0, 12);
    // Two variants per campaign, in one parallel batch: ad-level rows (also
    // yield the delivering-ads count) with a plain no-level query as safety net.
    const per = await Promise.all(
      ids.flatMap((cid) => [
        hfxCall("meta_business_ad_insights", { object_id: cid, object_type: "campaign", level: "ad", include_actions: true, include_video_metrics: false, ...rangeArgs(req) }, creds).then((r) => ({ cid, r, mode: "ad" as const })),
        hfxCall("meta_business_ad_insights", { object_id: cid, object_type: "campaign", include_actions: true, include_video_metrics: false, ...rangeArgs(req) }, creds).then((r) => ({ cid, r, mode: "plain" as const })),
      ])
    );
    const byCid = new Map<string, { ad?: any[]; plain?: any[] }>();
    for (const { cid, r, mode } of per) {
      if (!r.ok) continue;
      const rows = hfxRows(r.data).filter((x: any) => x && (x.spend !== undefined || x.impressions !== undefined));
      const e = byCid.get(cid) ?? {};
      e[mode] = rows;
      byCid.set(cid, e);
    }
    let any = false;
    const t = { spend: 0, impressions: 0, clicks: 0 };
    const adIds = new Set<string>();
    for (const [cid, e] of byCid) {
      const rows = (e.ad?.length ? e.ad : e.plain) ?? [];
      for (const r of e.ad ?? []) {
        const aid = String(r?.ad_id ?? "");
        if (aid) adIds.add(aid);
      }
      for (const row of rows) {
        const added = addRow(cid, row);
        t.spend += added.spend; t.impressions += added.impressions; t.clicks += added.clicks;
        any = true;
      }
    }
    if (any) {
      totals = t;
      if (adsCount == null && adIds.size > 0) adsCount = adIds.size;
      insightsNote = "per-campaign fallback used (account-level rollup returned no rows)";
    }
  }

  const havePerf = insightsRes.ok || insightsNote !== null;
  const campaigns = campaignsRes.ok
    ? ((campaignsRes.data as any)?.campaigns ?? []).map((c: any) => {
        const p = perf.get(String(c.id ?? ""));
        const objective = c.objective ?? "—";
        const picked = p ? pickResult(objective, p.actions, p.reach, p.impressions) : pickResult(objective, [], 0, 0);
        const spend = havePerf ? (p?.spend ?? 0) : null;
        return {
          id: String(c.id ?? ""),
          name: c.name ?? c.id ?? "Campaign",
          status: c.effective_status ?? c.status ?? "—",
          objective,
          dailyBudget: c.daily_budget != null ? num(c.daily_budget) / 100 : null,
          lifetimeBudget: c.lifetime_budget != null ? num(c.lifetime_budget) / 100 : null,
          startTime: c.start_time ?? null,
          spend,
          clicks: havePerf ? (p?.clicks ?? 0) : null,
          impressions: havePerf ? (p?.impressions ?? 0) : null,
          results: havePerf ? picked.results : null,
          resultLabel: picked.label,
          costPerResult: havePerf && picked.results > 0 && spend != null ? spend / picked.results : null,
          issues: (Array.isArray(c.issues_info) ? c.issues_info : Array.isArray(c.issues) ? c.issues : []).map((i: any) => String(i?.error_summary ?? i?.error_message ?? i?.message ?? i ?? "Issue")).slice(0, 5),
          recommendations: (Array.isArray(c.recommendations) ? c.recommendations : Array.isArray(c.recommendation_data) ? c.recommendation_data : []).map((r: any) => String(r?.title ?? r?.message ?? r?.recommendation ?? r?.code ?? r ?? "Recommendation")).slice(0, 5),
        };
      })
    : [];

  // When campaign details carry NO issues/recommendations at all (some engine
  // versions strip them), hunt for a dedicated health/recommendations tool and
  // surface whatever it returns as account-level alerts. Fully tolerant: any
  // failure here just means no banner.
  let accountAlerts: string[] = [];
  const noInlineAlerts = campaigns.length > 0 && campaigns.every((c: any) => c.issues.length === 0 && c.recommendations.length === 0);
  if (noInlineAlerts) {
    try {
      const tl = await hfxListTools(creds);
      const candidates = (tl.tools ?? [])
        .filter((t) => t.name.startsWith("meta_business_") && /health|recommend|alert|diagnos|issue/i.test(t.name))
        .slice(0, 2);
      for (const cand of candidates) {
        const r = await hfxCall(cand.name, { account_id: account.id }, creds);
        if (!r.ok) continue;
        const items = hfxRows(r.data)
          .map((row: any) => {
            if (typeof row === "string") return row;
            const what = row?.title ?? row?.message ?? row?.recommendation ?? row?.error_summary ?? row?.summary ?? row?.description ?? null;
            const who = row?.campaign_name ?? row?.ad_name ?? row?.adset_name ?? row?.name ?? null;
            return what ? (who ? `${who}: ${what}` : String(what)) : null;
          })
          .filter(Boolean) as string[];
        if (items.length > 0) {
          accountAlerts = items.slice(0, 10);
          break;
        }
      }
    } catch { /* alerts stay empty */ }
  }

  let autoRecommendations = false;
  const wsParam = req.nextUrl.searchParams.get("ws");
  if (wsParam) {
    try {
      const { data: cfg } = await supabaseAdmin.from("hyperfx_config").select("auto_recommendations").eq("workspace_id", wsParam).maybeSingle();
      autoRecommendations = !!cfg?.auto_recommendations;
    } catch { /* column may not exist yet */ }
  }

  return NextResponse.json({
    configured: true,
    connected: true,
    accounts,
    account: account.id,
    autoRecommendations,
    campaigns,
    adsCount,
    accountAlerts,
    insights: totals
      ? { ...totals, ctr: totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0, cpc: totals.clicks > 0 ? totals.spend / totals.clicks : 0 }
      : null,
    campaignsError: campaignsRes.ok ? null : campaignsRes.error,
    insightsError: havePerf ? null : insightsRes.error ?? null,
    insightsNote,
  });
}
