// Hyperfx bridge for the AI Team (Helena, Sam, Kai, Angela). Gives each agent
// two meta-tools — discover Hyperfx tools in its own lane, then run one — so
// the agents self-serve the whole Hyperfx catalog (SEO, ads insights, ads-library
// research, review/lead scraping, CMO brand reports) without hardcoding every
// tool's schema here. Only READ-style tools pass (hfxToolIsSafe): nothing can
// create or spend on live ads through this bridge.
//
// Uses the clinic's OWN Hyperfx account when saved (Settings → Connections),
// else the app-level env credentials — Option 1 of the multi-clinic model.

import { getHfxCreds, hfxCall, hfxListTools, hfxToolIsSafe } from "@/lib/hyperfx";

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
