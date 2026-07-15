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
  // Helena — paid media + social growth: every ads platform, social publishing, analytics.
  helena: [
    "meta_business_", "search_facebook_", "scrape_facebook", "cmo_", "google_ads_", "tiktok_", "linkedin_",
    "instagram_", "google_analytics_", "snapchat_", "reddit_ads_", "amazon_ads_", "x_", "shopify_",
  ],
  // Sam — SEO + content: search data, site analytics, content/docs, tracking setup.
  sam: ["hyperseo_", "cmo_", "google_ads_", "google_search_console_", "google_analytics_", "wordpress_", "notion_", "google_docs_", "gtm_"],
  // Kai — reputation + community: reviews, comments, mentions across social.
  kai: ["outscraper_", "scrape_reddit", "cmo_", "instagram_", "x_", "tiktok_", "linkedin_"],
  // Angela — front desk: CRM, email, calendars, scheduling links, spreadsheets,
  // and billing lookups (Stripe is read-only here — payments stay a future rail).
  angela: ["outscraper_", "cmo_", "hubspot_", "calendly_", "google_calendar_", "gmail_", "outlook_", "teams_", "google_sheets_", "google_docs_", "stripe_"],
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

// Per-agent write whitelists. The system note requires an explicit user
// confirmation in chat before ANY of these fire. Deletes stay UI-only
// everywhere — no agent can delete anything.
const AGENT_WRITE_TOOLS: Record<string, Set<string>> = {
  // Helena runs Meta ads end-to-end and can publish organic social posts.
  helena: new Set([
    "meta_business_create_campaign",
    "meta_business_update_campaign",
    "meta_business_activate_campaign",
    "meta_business_create_ad_set",
    "meta_business_update_ad_set",
    "meta_business_create_ad",
    "meta_business_update_ad",
    "meta_business_create_ad_creative",
    "meta_business_upload_ad_image",
    "meta_business_preview_blueprint",
    "meta_business_create_from_blueprint",
    "x_post_tweet",
    "linkedin_create_post",
    "linkedin_create_image_post",
    "linkedin_share_url",
  ]),
  // Sam drafts and publishes content documents.
  sam: new Set([
    "notion_create_page",
    "notion_update_page",
    "notion_append_block_children",
    "google_docs_create_document",
    "google_docs_insert_text",
    "google_docs_append_text",
    "google_docs_replace_text",
    "google_docs_batch_update",
  ]),
  // Kai replies to comments/mentions (reputation care).
  kai: new Set([
    "instagram_reply_to_comment",
    "x_reply_to_tweet",
    "linkedin_comment_on_post",
  ]),
  // Angela handles email, calendars, scheduling links, CRM records, sheets.
  angela: new Set([
    "gmail_send_email",
    "gmail_reply_to_email",
    "gmail_create_draft",
    "gmail_send_draft",
    "outlook_send_email",
    "outlook_reply_to_email",
    "outlook_create_draft",
    "google_calendar_create_event",
    "google_calendar_update_event",
    "outlook_calendar_create_event",
    "outlook_calendar_update_event",
    "calendly_create_single_use_link",
    "hubspot_create_contact",
    "hubspot_update_contact",
    "hubspot_create_company",
    "hubspot_create_deal",
    "hubspot_update_deal",
    "hubspot_create_note",
    "hubspot_create_task",
    "hubspot_associate_objects",
    "google_sheets_create_spreadsheet",
    "google_sheets_add_sheet",
    "google_sheets_append_values",
    "google_sheets_update_values",
  ]),
};

// Hyperfx's NATIVE tools are always-on (no external account) — but the agents
// can't reach them unless we allow them past the platform-lane gate. We expose
// only the safe, on-purpose ones. Deliberately NOT exposed to chat agents:
// shell / python / javascript / sandbox_* / browser_execute_code (arbitrary
// code + remote control) and any delete/file-write — too broad and off-task.
const NATIVE_READ_TOOLS = new Set([
  "web_search",      // live web/competitor/trend research (date/domain/category filters)
  "web_fetch_page",  // read any URL's full text
  "transcribe_video", // meeting/call recording → text
]);
// Image + creative generation — the creative-capable agent (Helena) only.
const NATIVE_IMAGE_TOOLS = new Set([
  "generate_image",
  "nano_banana_image_generation",
  "nano_banana_image_edit",
  "nano_banana_multi_turn",
  "openai_image_generation",
  "openai_image_edit",
  "seedream_image_generation",
  "create_product_photoshoot",
  "create_marketplace_cards",
]);

// Which always-on native tools this agent may use, regardless of platform lanes.
function nativeAllowed(agent: string, tool: string): boolean {
  if (NATIVE_READ_TOOLS.has(tool)) return true;              // research for everyone
  if (NATIVE_IMAGE_TOOLS.has(tool)) return agent === "helena"; // creatives = Helena
  return false;
}

function agentMayRun(agent: string, tool: string): boolean {
  if (nativeAllowed(agent, tool)) return true;
  if (hfxToolIsSafe(tool)) return true;
  return AGENT_WRITE_TOOLS[agent]?.has(tool) ?? false;
}

function inLaneOrNative(agent: string, tool: string, prefixes: string[]): boolean {
  return nativeAllowed(agent, tool) || prefixes.some((p) => tool.startsWith(p));
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
      .filter((t) => inLaneOrNative(agent, t.name, lanes) && agentMayRun(agent, t.name))
      .filter((t) => !q || `${t.name} ${t.description ?? ""}`.toLowerCase().includes(q))
      .slice(0, 60);
    const enabledNames = new Set(enabled.map((t) => t.name));
    const pending: string[] = [];
    if (cat.ok && Array.isArray(cat.data)) {
      for (const tk of cat.data as any[]) {
        if (!tk?.authenticated && tk?.requires_auth) continue; // not connected yet
        for (const tn of tk?.tools ?? []) {
          const toolName = String(tn);
          if (enabledNames.has(toolName) || !inLaneOrNative(agent, toolName, lanes) || !agentMayRun(agent, toolName)) continue;
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
  if (!inLaneOrNative(agent, tool, lanes)) return `"${tool}" is outside your area — pick one from hyperfx_list_tools.`;
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
      "live ads data on EVERY connected platform — Meta, Google, TikTok, LinkedIn, Snapchat, Reddit, Amazon (accounts, campaigns, ad sets/groups/squads, ads, creatives, reports) — Instagram account/post insights, X/Twitter, Google Analytics reports, Shopify store data, Meta Ads-Library competitor research, CMO brand reports. You can RUN Meta ads (create/update campaigns, ad sets, ads, creatives, upload images) and publish X/LinkedIn posts",
    sam: "HyperSEO keyword/SERP research, AI-search visibility, competitor SEO analysis, Google Search Console data (queries, clicks, positions, indexing), Google Analytics reports, WordPress content, Notion and Google Docs drafting, Google Tag Manager setup, and Google Ads keyword insights",
    kai: "Google-review and Reddit scraping for reputation monitoring, Instagram/X/TikTok/LinkedIn comments, mentions and post insights, plus CMO brand reports — you can reply to comments after user confirmation",
    angela: "Google Maps lead scraping (find local audiences), HubSpot CRM (contacts, companies, deals, notes, tasks), clinic email via Gmail/Outlook, Google & Outlook Calendar plus Calendly scheduling, Google Sheets exports, and CMO brand reports — you can send emails, create events and CRM records after user confirmation",
  };
  const nativeNote =
    agent === "helena"
      ? "ALWAYS-ON engine tools (no connection needed, use freely): web_search (live web research — competitors, prices, trends; supports date/domain/category filters), web_fetch_page (read any URL's full text), and image generation — generate_image / create_product_photoshoot / create_marketplace_cards for on-brand ad creatives (describe the creative and the engine renders it; this is how you make ad images). Use web_search whenever the user asks about current/competitor/market info and cite what you find."
      : "ALWAYS-ON engine tools (no connection needed, use freely): web_search (live web research — competitors, prices, trends; supports date/domain/category filters) and web_fetch_page (read any URL's full text). Use them whenever the user asks about current or competitor information, and cite what you find.";
  return `${nativeNote}
You also have Hyperfx marketing tools for ${what[agent] ?? "marketing research"}: call hyperfx_list_tools to discover them (optionally with a keyword), then hyperfx_run_tool to run one with JSON args.
RESEARCH LIKE A MEDIA BUYER — drill down the hierarchy instead of guessing, and answer from REAL fetched data, never from assumption:
• Meta: meta_business_list_ad_accounts → meta_business_search_campaigns(account_id) → meta_business_get_ad_sets(campaign_id) → meta_business_get_ads(ad_set_id) → meta_business_get_ad_details / meta_business_get_ad_creative / meta_business_get_ad_previews. Performance for ANY level in ONE call: meta_business_ad_insights(object_id, object_type: account|campaign|adset|ad, date_preset or time_range{since,until}, include_actions:true). Deeper detail: meta_business_get_campaign_details / get_adset_details. Targeting research: meta_business_targeting_search. Account alerts: meta_business_get_health_check (run_health_check first if empty). Audiences: list_custom_audiences / list_lookalike_audiences. Assets: list_ad_images / list_ad_videos / list_ad_creatives.
• Google Ads: google_ads_list_accounts → list_campaigns → list_ad_groups → list_ads / list_keywords; metrics via google_ads_get_campaign_performance / get_ad_group_performance / get_keyword_performance / get_search_terms_report, or google_ads_query (GAQL) for anything custom; keyword research via google_ads_keyword_ideas.
• Google Analytics: google_analytics_list_accounts → list_properties → run_report / run_realtime_report / run_funnel_report.
• Search Console: google_search_console_list_sites → query_search_analytics (clicks, impressions, CTR, position) / inspect_url.
• Instagram: instagram_get_user_profile / get_account_insights → list_media → get_media_insights; comments via list_comments.
• WordPress: wordpress_list_posts / list_pages / list_media, create/update for content.
• Every other platform follows the same list → get → details pattern: TikTok/Snapchat/Reddit/Amazon/LinkedIn ads (list_ad_accounts → list_campaigns → list_ad_groups|ad_squads → list_ads, performance via *_report/*_stats/*_metrics tools), HubSpot (list/search contacts, companies, deals, pipelines, engagements), Gmail/Outlook (list/search emails → get → thread), Google Calendar & Outlook Calendar & Calendly (list events, free/busy, availability), Notion (search → query_database → get_block_children), Google Docs/Sheets (list → get document/values), Shopify (products, orders, customers, inventory), GitHub, Microsoft Teams, X/Twitter (search_tweets, timelines, DMs), TikTok organic (list_videos → get_video_insights).
When a tool answers with an envelope (summary_metrics + detailed_insights), read detailed_insights for per-row data and summary_metrics for totals.
RULES FOR WRITE ACTIONS: only the write tools allowed for YOUR role are callable (they appear in hyperfx_list_tools; everything else is read-only for you). Before ANY write that reaches the outside world — ads, emails, calendar events, CRM records, social posts or replies, documents — state exactly what you will do (recipient/audience, full content, budget if any) and wait for the user's explicit confirmation ("yes", "send", "launch", "go ahead") in this chat. Meta ads: create campaigns with status PAUSED unless the user explicitly says go live; budget values are in CENTS (e.g. $20 = 2000). Never delete anything — deletes are UI-only. If Hyperfx says it isn't configured, tell the user to add their Hyperfx credentials in Settings → Connections (or connect the platform on hyperfx.ai).`;
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
    // "maximum" as an explicit ~35-month range — the engine ignores that preset.
    let range: Record<string, unknown> = { date_preset: preset };
    if (preset === "maximum") {
      const now = new Date();
      const start = new Date(now);
      start.setMonth(start.getMonth() - 35);
      const iso = (d: Date) => d.toISOString().slice(0, 10);
      range = { time_range: { since: iso(start), until: iso(now) } };
    }
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
      { object_id: actId, object_type: "account", level: "campaign", include_actions: false, include_video_metrics: false, ...range },
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
            hfxCall("meta_business_ad_insights", { object_id: String(c.id), object_type: "campaign", include_actions: false, include_video_metrics: false, ...range }, creds).then((r) => ({ c, r }))
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
