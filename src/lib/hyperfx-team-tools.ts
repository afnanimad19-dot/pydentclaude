// Hyperfx bridge for the AI Team (Helena, Sam, Kai, Angela). Gives each agent
// two meta-tools — discover Hyperfx tools in its own lane, then run one — so
// the agents self-serve the whole Hyperfx catalog (SEO, ads insights, ads-library
// research, review/lead scraping, CMO brand reports) without hardcoding every
// tool's schema here. Only READ-style tools pass (hfxToolIsSafe): nothing can
// create or spend on live ads through this bridge.
//
// Uses the clinic's OWN Hyperfx account when saved (Settings → Connections),
// else the app-level env credentials — Option 1 of the multi-clinic model.

import { getHfxCreds, hfxCall, hfxFlatRow, hfxListTools, hfxMetric, hfxRowHasMetrics, hfxRows, hfxToolIsSafe } from "@/lib/hyperfx";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Which slice of the Hyperfx catalog each team member may touch.
export const HFX_LANES: Record<string, string[]> = {
  helena: ["meta_business_", "search_facebook_", "scrape_facebook", "cmo_", "google_ads_", "tiktok_", "linkedin_ads_"],
  sam: ["hyperseo_", "cmo_", "google_ads_"],
  kai: ["outscraper_", "scrape_reddit", "cmo_"],
  angela: ["outscraper_", "cmo_"],
};

// OpenAI function-calling tool definitions to append to a team agent's TOOLS.
export const HFX_TEAM_TOOLS = [
  {
    type: "function",
    function: {
      name: "hyperfx_list_tools",
      description:
        "List the Hyperfx marketing tools available to you (live ads data, SEO research, AI-search visibility, ads-library scraping, review/lead scraping, CMO brand reports). Returns each tool's name, what it does, and its arguments. Call this FIRST to find the right tool, then call hyperfx_run_tool.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Optional keyword to filter tools (e.g. 'keyword', 'campaign', 'insights', 'reviews')." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "hyperfx_run_tool",
      description:
        "Run one Hyperfx tool by exact name (from hyperfx_list_tools) with JSON arguments matching its schema. Write actions are allowed only where your instructions permit them, and ALWAYS require the user's explicit confirmation in chat first.",
      parameters: {
        type: "object",
        properties: {
          tool: { type: "string", description: "Exact tool name from hyperfx_list_tools." },
          args: { type: "string", description: "JSON object string of the tool's arguments, e.g. '{\"account_id\":\"act_123\"}'. Use '{}' when none." },
        },
        required: ["tool"],
      },
    },
  },
];

// Helena may RUN ads end-to-end (create/update campaigns, ad sets, ads,
// creatives, upload images) — the system note requires an explicit user
// confirmation in chat before any of these fire. Deletes stay UI-only.
const HELENA_WRITE_TOOLS = new Set([
  "meta_business_create_campaign",
  "meta_business_update_campaign",
  "meta_business_activate_campaign",
  "meta_business_create_ad_set",
  "meta_business_update_ad_set",
  "meta_business_create_ad",
  "meta_business_create_ad_creative",
  "meta_business_upload_ad_image",
  "meta_business_preview_blueprint",
  "meta_business_create_from_blueprint",
]);

function agentMayRun(agent: string, tool: string): boolean {
  if (hfxToolIsSafe(tool)) return true;
  return agent === "helena" && HELENA_WRITE_TOOLS.has(tool);
}

function inLane(tool: string, prefixes: string[]): boolean {
  return prefixes.some((p) => tool.startsWith(p));
}

function schemaBrief(schema: any): string {
  const props = schema?.properties;
  if (!props || typeof props !== "object") return "no args";
  const req = new Set<string>(Array.isArray(schema?.required) ? schema.required : []);
  return Object.entries(props)
    .map(([k, v]: [string, any]) => `${k}${req.has(k) ? "*" : ""}:${v?.type ?? "any"}${v?.enum ? `(${v.enum.join("|")})` : ""}`)
    .join(", ");
}

// Handle the two bridge tools for one agent. Returns null when `name` isn't a
// Hyperfx bridge tool, so the caller can fall through to its own tools.
export async function execHyperfxTool(
  workspaceId: string,
  agent: keyof typeof HFX_LANES,
  name: string,
  args: any
): Promise<string | null> {
  if (name !== "hyperfx_list_tools" && name !== "hyperfx_run_tool") return null;
  const lanes = HFX_LANES[agent] ?? [];
  const creds = await getHfxCreds(workspaceId);

  if (name === "hyperfx_list_tools") {
    // Enabled tools carry descriptions + schemas; the catalog additionally
    // reveals CONNECTED apps whose tools aren't enabled yet — those auto-enable
    // the first time hyperfx_run_tool calls them, so list them too.
    const [r, cat] = await Promise.all([hfxListTools(creds), hfxCall("discover_toolkits", { query: "" }, creds)]);
    if (!r.ok && !cat.ok) return `Hyperfx isn't reachable: ${r.error ?? cat.error}`;
    const q = String(args?.query ?? "").toLowerCase();
    const enabled = (r.tools ?? [])
      .filter((t) => inLane(t.name, lanes) && agentMayRun(agent, t.name))
      .filter((t) => !q || `${t.name} ${t.description ?? ""}`.toLowerCase().includes(q))
      .slice(0, 60);
    const enabledNames = new Set(enabled.map((t) => t.name));
    const pending: string[] = [];
    if (cat.ok && Array.isArray(cat.data)) {
      for (const tk of cat.data as any[]) {
        if (!tk?.authenticated && tk?.requires_auth) continue; // not connected yet
        for (const tn of tk?.tools ?? []) {
          const toolName = String(tn);
          if (enabledNames.has(toolName) || !inLane(toolName, lanes) || !agentMayRun(agent, toolName)) continue;
          if (q && !toolName.toLowerCase().includes(q)) continue;
          pending.push(toolName);
        }
      }
    }
    if (enabled.length === 0 && pending.length === 0) {
      return q
        ? `No Hyperfx tools in your area match "${q}". Try hyperfx_list_tools without a query.`
        : "No Hyperfx tools are live for this clinic yet — the clinic needs to connect the platform (e.g. Meta, Google Ads) in Settings → Connections → Apps.";
    }
    const lines = enabled.map((t) => `- ${t.name} (${schemaBrief(t.inputSchema)}): ${(t.description ?? "").replace(/\s+/g, " ").trim().slice(0, 180)}`);
    for (const tn of pending.slice(0, 40)) lines.push(`- ${tn} (connected — callable now; args self-explanatory from the name)`);
    return lines.join("\n");
  }

  // hyperfx_run_tool
  const tool = String(args?.tool ?? "").trim();
  if (!tool) return "Provide the tool name (from hyperfx_list_tools).";
  if (!inLane(tool, lanes)) return `"${tool}" is outside your area — pick one from hyperfx_list_tools.`;
  if (!agentMayRun(agent, tool)) return `"${tool}" is a write action you can't run — draft the plan and point the user to the Ads page instead.`;
  let toolArgs: Record<string, unknown> = {};
  if (args?.args) {
    try {
      toolArgs = typeof args.args === "string" ? JSON.parse(args.args) : args.args;
    } catch {
      return "args must be a valid JSON object string.";
    }
  }
  const r = await hfxCall(tool, toolArgs, creds);
  if (!r.ok) return `Hyperfx ${tool} failed: ${r.error}`;
  const out = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
  return out.length > 7000 ? `${out.slice(0, 7000)}… (truncated)` : out;
}

// One line for each agent's system prompt.
export function hyperfxSystemNote(agent: keyof typeof HFX_LANES): string {
  const what: Record<string, string> = {
    helena:
      "live Meta/Google/TikTok/LinkedIn ads data (accounts, campaigns, insights), Meta Ads-Library competitor research, CMO brand reports — and you can RUN Meta ads: create/update campaigns, ad sets, ads and creatives, and upload ad images",
    sam: "HyperSEO keyword/SERP research, AI-search visibility, competitor SEO analysis, and Google Ads keyword insights",
    kai: "Google-review and Reddit scraping for reputation monitoring, plus CMO brand reports",
    angela: "Google Maps lead scraping (find local audiences) and CMO brand reports",
  };
  return `You also have Hyperfx marketing tools for ${what[agent] ?? "marketing research"}: call hyperfx_list_tools to discover them (optionally with a keyword), then hyperfx_run_tool to run one with JSON args. RULES FOR WRITE ACTIONS (Helena only): before ANY create/update call that touches live ads, present the complete plan — objective, daily budget, audience, placement, creative/copy — and wait for the user's explicit confirmation ("yes", "launch", "go ahead") in this chat. Create campaigns with status PAUSED unless the user explicitly says go live. Never delete anything. Budget values are in CENTS on Meta tools (e.g. $20 = 2000). Other agents are read-only: draft the plan and point the user to the Ads page. If Hyperfx says it isn't configured, tell the user to add their Hyperfx credentials in Settings → Connections (or connect the platform on hyperfx.ai).`;
}

/* ------------------------------------------------------------------ */
// Engine-first ads performance for the agents' NAMED tools. Helena's legacy
// get_meta_ads_performance / get_google_ads_performance used Pydent's own
// Meta/Google OAuth (usually NOT connected) — the reason chat said "Meta isn't
// connected" while the Ads tab (which reads the engine) worked. These helpers
// answer from the engine first; callers fall back to the legacy OAuth path
// only when the engine has nothing.

const META_PRESETS = new Set(["today", "yesterday", "last_7d", "last_14d", "last_28d", "last_30d", "last_90d", "maximum"]);

export async function hfxMetaPerformance(workspaceId: string, preset = "last_30d"): Promise<string | null> {
  try {
    if (/^(lifetime|all[_ ]?time|max)/i.test(preset)) preset = "maximum";
    if (!META_PRESETS.has(preset)) preset = "last_30d";
    const creds = await getHfxCreds(workspaceId);
    const accountsRes = await hfxCall("meta_business_list_ad_accounts", { detail: "core" }, creds);
    if (!accountsRes.ok) return null;
    const accounts: any[] = (accountsRes.data as any)?.accounts ?? [];
    if (accounts.length === 0) return "The Meta connection works, but no ad accounts are visible on it.";
    // With several ad accounts, report on the one that actually has campaigns
    // (prefer active) — not blindly the first, which may be empty.
    let acct = accounts[0];
    if (accounts.length > 1) {
      const probes = await Promise.all(
        accounts.slice(0, 5).map((a: any) =>
          hfxCall("meta_business_search_campaigns", { account_id: String(a.id), detail: "summary", limit: 25 }, creds).then((r) => ({
            a,
            camps: (r.ok ? ((r.data as any)?.campaigns ?? []) : []) as any[],
          }))
        )
      );
      const withActive = probes.find((p) => p.camps.some((c: any) => /ACTIVE/i.test(String(c.effective_status ?? c.status ?? ""))));
      const withAny = probes.find((p) => p.camps.length > 0);
      acct = (withActive ?? withAny)?.a ?? accounts[0];
    }
    const actId = String(acct.id ?? "").startsWith("act_") ? String(acct.id) : `act_${acct.id}`;
    const ins = await hfxCall(
      "meta_business_ad_insights",
      { object_id: actId, object_type: "account", level: "campaign", date_preset: preset, include_actions: false, include_video_metrics: false },
      creds
    );
    if (!ins.ok) return `Meta ad account "${acct.name ?? acct.id}" is connected, but insights failed: ${ins.error}`;
    let rows: any[] = hfxRows(ins.data).filter(hfxRowHasMetrics).map(hfxFlatRow);

    // FALLBACK: some accounts answer the account-level campaign rollup with
    // nothing while direct per-campaign insights return real numbers. When the
    // rollup is empty/zero but campaigns exist, query each campaign directly.
    const rollupEmpty = rows.length === 0 || rows.every((r) => !hfxMetric(r, "spend") && !hfxMetric(r, "impressions"));
    if (rollupEmpty) {
      const camp = await hfxCall("meta_business_search_campaigns", { account_id: String(acct.id), detail: "summary", limit: 15 }, creds);
      const camps: any[] = camp.ok ? ((camp.data as any)?.campaigns ?? []) : [];
      if (camps.length > 0) {
        const per = await Promise.all(
          camps.slice(0, 12).map((c: any) =>
            hfxCall("meta_business_ad_insights", { object_id: String(c.id), object_type: "campaign", date_preset: preset, include_actions: false, include_video_metrics: false }, creds).then((r) => ({ c, r }))
          )
        );
        const rebuilt: any[] = [];
        for (const { c, r } of per) {
          if (!r.ok) continue;
          for (const raw of hfxRows(r.data).filter(hfxRowHasMetrics)) {
            const row = hfxFlatRow(raw);
            rebuilt.push({ ...row, campaign_id: row.campaign_id ?? c.id, campaign_name: row.campaign_name ?? c.name });
          }
        }
        if (rebuilt.some((r) => hfxMetric(r, "spend") > 0 || hfxMetric(r, "impressions") > 0)) rows = rebuilt;
      }
    }
    const cur = acct.currency && acct.currency !== "USD" ? `${acct.currency} ` : "$";
    if (rows.length === 0) return `Meta ad account "${acct.name ?? acct.id}" (${preset.replaceAll("_", " ")}): no delivery in this period — ${cur}0 spend.`;
    let spend = 0, impressions = 0, clicks = 0;
    const perCampaign: string[] = [];
    for (const r of rows) {
      const s = hfxMetric(r, "spend"), i = hfxMetric(r, "impressions"), c = hfxMetric(r, "clicks");
      spend += s; impressions += i; clicks += c;
      perCampaign.push(`- ${r.campaign_name ?? r.campaign_id}: ${cur}${s.toFixed(2)} spend, ${i} impressions, ${c} clicks${i > 0 ? ` (CTR ${((c / i) * 100).toFixed(2)}%)` : ""}`);
    }
    return [
      `Meta Ads performance — account "${acct.name ?? acct.id}", ${preset.replaceAll("_", " ")}:`,
      `TOTAL: ${cur}${spend.toFixed(2)} spend · ${impressions} impressions · ${clicks} clicks${impressions > 0 ? ` · CTR ${((clicks / impressions) * 100).toFixed(2)}%` : ""}${clicks > 0 ? ` · CPC ${cur}${(spend / clicks).toFixed(2)}` : ""}`,
      "By campaign:",
      ...perCampaign.slice(0, 25),
    ].join("\n");
  } catch {
    return null;
  }
}

export async function hfxGoogleAdsPerformance(workspaceId: string): Promise<string | null> {
  try {
    const creds = await getHfxCreds(workspaceId);
    const accountsRes = await hfxCall("google_ads_list_accounts", {}, creds);
    if (!accountsRes.ok) return null;
    const accounts: any[] = ((accountsRes.data as any)?.accounts ?? []).filter((a: any) => !a.error && !a.manager);
    if (accounts.length === 0) return "The Google Ads connection works, but no (non-manager) accounts are accessible.";
    const acct = accounts[0];
    const perf = await hfxCall("google_ads_get_campaign_performance", { customer_id: String(acct.customer_id ?? acct.id), date_range: "LAST_30_DAYS" }, creds);
    if (!perf.ok) return `Google Ads account "${acct.descriptive_name ?? acct.name}" is connected, but performance failed: ${perf.error}`;
    const rows: any[] = (Array.isArray(perf.data) ? (perf.data as any[]) : []).filter((r) => !r.error);
    if (rows.length === 0) return `Google Ads account "${acct.descriptive_name ?? acct.name}" (last 30 days): no campaign delivery.`;
    let cost = 0, impressions = 0, clicks = 0;
    const per: string[] = [];
    for (const r of rows) {
      const c = (Number(r.cost_micros) || 0) / 1_000_000;
      cost += c; impressions += Number(r.impressions) || 0; clicks += Number(r.clicks) || 0;
      per.push(`- ${r.campaign_name}: $${c.toFixed(2)} cost, ${r.impressions} impressions, ${r.clicks} clicks, ${r.conversions} conversions`);
    }
    return [
      `Google Ads performance — account "${acct.descriptive_name ?? acct.name}", last 30 days:`,
      `TOTAL: $${cost.toFixed(2)} cost · ${impressions} impressions · ${clicks} clicks`,
      "By campaign:",
      ...per.slice(0, 25),
    ].join("\n");
  } catch {
    return null;
  }
}
