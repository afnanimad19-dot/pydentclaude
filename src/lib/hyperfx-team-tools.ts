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
        "Run one Hyperfx tool by exact name (from hyperfx_list_tools) with JSON arguments matching its schema. Read-style tools only — creating or editing live ads is not allowed from here.",
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
    const r = await hfxListTools(creds);
    if (!r.ok) return `Hyperfx isn't reachable: ${r.error}`;
    const q = String(args?.query ?? "").toLowerCase();
    const mine = (r.tools ?? [])
      .filter((t) => inLane(t.name, lanes) && hfxToolIsSafe(t.name))
      .filter((t) => !q || `${t.name} ${t.description ?? ""}`.toLowerCase().includes(q))
      .slice(0, 60);
    if (mine.length === 0) {
      return q
        ? `No Hyperfx tools in your area match "${q}". Try hyperfx_list_tools without a query.`
        : "No Hyperfx tools are live for this clinic yet — the clinic needs to connect the platform (e.g. Meta, Google Ads) on hyperfx.ai, or save its Hyperfx credentials in Settings → Connections.";
    }
    return mine
      .map((t) => `- ${t.name} (${schemaBrief(t.inputSchema)}): ${(t.description ?? "").replace(/\s+/g, " ").trim().slice(0, 180)}`)
      .join("\n");
  }

  // hyperfx_run_tool
  const tool = String(args?.tool ?? "").trim();
  if (!tool) return "Provide the tool name (from hyperfx_list_tools).";
  if (!inLane(tool, lanes)) return `"${tool}" is outside your area — pick one from hyperfx_list_tools.`;
  if (!hfxToolIsSafe(tool)) return `"${tool}" is a write action (creates/edits live ads) — not allowed from chat. Suggest the change to the user instead.`;
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
      "live Meta/Google/TikTok/LinkedIn ads data (accounts, campaigns, insights), Meta Ads-Library competitor research, and CMO brand reports",
    sam: "HyperSEO keyword/SERP research, AI-search visibility, competitor SEO analysis, and Google Ads keyword insights",
    kai: "Google-review and Reddit scraping for reputation monitoring, plus CMO brand reports",
    angela: "Google Maps lead scraping (find local audiences) and CMO brand reports",
  };
  return `You also have Hyperfx marketing tools for ${what[agent] ?? "marketing research"}: call hyperfx_list_tools to discover them (optionally with a keyword), then hyperfx_run_tool to run one with JSON args. They are read-only — for anything that would create or change live ads, draft the plan and ask the user to run it from the Meta Ads page. If Hyperfx says it isn't configured, tell the user to add their Hyperfx credentials in Settings → Connections (or connect the platform on hyperfx.ai).`;
}
