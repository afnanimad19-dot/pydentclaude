import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getHfxCreds, hfxCall, hfxListTools } from "@/lib/hyperfx";

// Staged diagnosis of the marketing-engine chain for one workspace — answers
// "why isn't the agent fetching data?" precisely: which credentials are used,
// is the engine reachable, is Meta authenticated, are its tools enabled, and
// does a REAL data call work. Open /api/hyperfx/diag?ws=<workspace> in a browser.
export const runtime = "nodejs";
export const maxDuration = 60;

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function GET(req: NextRequest) {
  const ws = req.nextUrl.searchParams.get("ws");
  const out: Record<string, unknown> = {};

  // 1 — which credentials will be used (per-clinic row vs env), without leaking keys.
  let rowUrl = "";
  if (ws) {
    try {
      const { data } = await supabaseAdmin.from("hyperfx_config").select("mcp_url, enabled").eq("workspace_id", ws).maybeSingle();
      rowUrl = data?.enabled !== false ? String(data?.mcp_url ?? "") : "";
    } catch { /* table may not exist */ }
  }
  const creds = await getHfxCreds(ws);
  out.credsSource = rowUrl && creds.url === rowUrl.replace(/\/$/, "") ? "per-clinic (Settings → Connections)" : creds.url ? "app env (HYPERFX_MCP_URL)" : "NONE — not configured";
  out.mcpHost = creds.url ? new URL(creds.url).host : null;
  out.hasApiKey = !!creds.key;
  if (!creds.url) return NextResponse.json({ ...out, verdict: "Not configured — set HYPERFX_MCP_URL + HYPERFX_API_KEY in Netlify (or save per-clinic credentials)." });

  // 2 — reachability + which tools this session sees.
  const tools = await hfxListTools(creds);
  out.engineReachable = tools.ok;
  if (!tools.ok) return NextResponse.json({ ...out, engineError: tools.error, verdict: "Engine unreachable with these credentials — check the MCP URL/key." });
  out.toolCount = tools.tools?.length ?? 0;
  out.metaToolsEnabled = (tools.tools ?? []).some((t) => t.name.startsWith("meta_business_"));

  // 3 — what the catalog says is CONNECTED (authenticated).
  const cat = await hfxCall("discover_toolkits", { query: "" }, creds);
  if (cat.ok && Array.isArray(cat.data)) {
    out.connectedApps = (cat.data as any[]).filter((t) => t?.requires_auth && t?.authenticated).map((t) => t.id);
  } else {
    out.catalogError = cat.error;
  }

  // 4 — the REAL test: fetch ad accounts (auto-enables the toolkit if needed).
  const live = await hfxCall("meta_business_list_ad_accounts", { detail: "core" }, creds);
  out.metaLiveCall = live.ok ? "OK" : "FAILED";
  const accounts: any[] = live.ok ? ((live.data as any)?.accounts ?? []) : [];
  if (live.ok) {
    out.metaAdAccounts = accounts.map((a: any) => a.name ?? a.id);
    out.verdict = "Everything works — agents and the Ads tabs can fetch Meta data with these credentials.";
  } else {
    out.metaLiveError = live.error;
    out.verdict = "Engine reachable but the Meta data call failed — see metaLiveError for the exact reason.";
  }

  // 5 — DEEP mode (?deep=1): show exactly what Meta returns for insights and
  // recommendations on EVERY ad account, so "no data showing" stops being a
  // mystery — either Meta returns zeros (real) or the shape/params are off.
  if (req.nextUrl.searchParams.get("deep") && accounts.length) {
    const { hfxRows, hfxFlatRow, hfxMetric, hfxRowHasMetrics } = await import("@/lib/hyperfx");
    const deep: Record<string, unknown> = {};
    for (const acct of accounts.slice(0, 3)) {
      const id = String(acct.id ?? "");
      const actId = id.startsWith("act_") ? id : `act_${id}`;
      const entry: Record<string, unknown> = {};

      const camp = await hfxCall("meta_business_search_campaigns", { account_id: id, detail: "full", limit: 15 }, creds);
      const camps: any[] = camp.ok ? ((camp.data as any)?.campaigns ?? []) : [];
      entry.campaigns = camp.ok ? camps.length : `ERROR: ${camp.error}`;
      entry.campaignsWithIssues = camps.filter((c) => Array.isArray(c.issues_info) && c.issues_info.length).length;
      entry.campaignsWithRecommendations = camps.filter((c) => Array.isArray(c.recommendations) && c.recommendations.length).length;
      if (camps[0]) entry.sampleCampaignFields = Object.keys(camps[0]).slice(0, 30);

      // Direct per-campaign insights — the fallback path the app now uses when
      // the account-level rollup is empty. Compares the two sources head-on.
      if (camps[0]) {
        const direct = await hfxCall("meta_business_ad_insights", { object_id: String(camps[0].id), object_type: "campaign", include_actions: true, date_preset: "last_30d" }, creds);
        if (direct.ok) {
          const rr = hfxRows(direct.data).filter(hfxRowHasMetrics);
          entry.firstCampaignDirect = {
            campaign: camps[0].name ?? camps[0].id,
            rows: rr.length,
            spend: rr.reduce((s: number, r: any) => s + hfxMetric(r, "spend"), 0),
            impressions: rr.reduce((s: number, r: any) => s + hfxMetric(r, "impressions"), 0),
            firstRowKeys: rr[0] ? Object.keys(hfxFlatRow(rr[0])).slice(0, 25) : null,
          };
        } else {
          entry.firstCampaignDirect = `ERROR: ${direct.error}`;
        }
      }

      // Account-level insights WITHOUT level:"campaign" — isolates whether the
      // rollup parameter itself is what returns nothing.
      const noLevel = await hfxCall("meta_business_ad_insights", { object_id: actId, object_type: "account", include_actions: false, date_preset: "last_30d" }, creds);
      if (noLevel.ok) {
        const rr = hfxRows(noLevel.data).filter(hfxRowHasMetrics);
        const env = noLevel.data as any;
        entry.accountNoLevel = {
          rows: rr.length,
          spend: rr.reduce((s: number, r: any) => s + hfxMetric(r, "spend"), 0),
          summaryMetricsKeys: env?.summary_metrics && typeof env.summary_metrics === "object" ? Object.keys(env.summary_metrics).slice(0, 20) : null,
          detailedInsightsCount: Array.isArray(env?.detailed_insights) ? env.detailed_insights.length : null,
        };
      } else {
        entry.accountNoLevel = `ERROR: ${noLevel.error}`;
      }

      for (const preset of ["last_30d", "last_90d"]) {
        const ins = await hfxCall("meta_business_ad_insights", { object_id: actId, object_type: "account", level: "campaign", include_actions: true, date_preset: preset }, creds);
        if (!ins.ok) {
          entry[preset] = `ERROR: ${ins.error}`;
          continue;
        }
        const rows = hfxRows(ins.data).filter(hfxRowHasMetrics);
        const sample = rows[0] ? hfxFlatRow(rows[0]) : null;
        entry[preset] = {
          rows: rows.length,
          totalSpend: rows.reduce((s: number, r: any) => s + hfxMetric(r, "spend"), 0),
          totalImpressions: rows.reduce((s: number, r: any) => s + hfxMetric(r, "impressions"), 0),
          sampleRow: sample
            ? { campaign: sample.campaign_name ?? sample.campaign_id, spend: sample.spend ?? sample.total_spend, impressions: sample.impressions ?? sample.total_impressions, clicks: sample.clicks ?? sample.total_clicks, actionTypes: (sample.actions ?? []).map((a: any) => a.action_type).slice(0, 8) }
            : null,
          rawShape: Array.isArray(ins.data) ? "array" : Object.keys((ins.data as any) ?? {}).slice(0, 8),
        };
      }
      deep[acct.name ?? id] = entry;
    }
    // Which engine tools could surface Meta's alerts/recommendations — tells us
    // where creative-fatigue alerts should come from if search_campaigns
    // detail:"full" doesn't carry them.
    deep.alertToolCandidates = (tools.tools ?? [])
      .filter((t) => t.name.startsWith("meta_business_") && /health|recommend|issue|diagnos|alert/i.test(t.name))
      .map((t) => t.name);
    out.deep = deep;
  }

  return NextResponse.json(out);
}
