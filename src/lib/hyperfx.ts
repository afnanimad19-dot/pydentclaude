// SERVER-ONLY client for the Hyperfx.ai MCP server. Pydent is the frontend;
// Hyperfx runs the tool intelligence at the backend: ads (Meta/Google/TikTok/…),
// Google Calendar, SEO + AI-search visibility, social scraping, and more.
//
// MULTI-CLINIC: each workspace can carry its OWN Hyperfx account/sub-account
// credentials (hyperfx_config table, saved in Settings → Connections), so each
// clinic's connected platforms stay isolated. When a workspace has none, the
// global HYPERFX_MCP_URL / HYPERFX_API_KEY env vars are used (single-account
// mode — fine for testing, or when every clinic shares one Hyperfx account).
//
// Accounts are connected ONCE on hyperfx.ai (their Connections page does the
// OAuth); after that, every tool of every connected platform is callable from
// here. Speaks MCP over Streamable HTTP (JSON-RPC 2.0), no SDK dependency.

import { supabaseAdmin } from "@/lib/supabase-admin";

export interface HfxCreds {
  url: string;
  key: string;
}

const ENV_CREDS: HfxCreds = {
  url: process.env.HYPERFX_MCP_URL ?? "",
  key: process.env.HYPERFX_API_KEY ?? "",
};

// The workspace's own Hyperfx credentials, else the env-level ones.
export async function getHfxCreds(workspaceId: string | null): Promise<HfxCreds> {
  if (workspaceId) {
    try {
      const { data } = await supabaseAdmin
        .from("hyperfx_config")
        .select("mcp_url, api_key, enabled")
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      if (data?.mcp_url && data.enabled !== false) {
        return { url: String(data.mcp_url), key: data.api_key ?? "" };
      }
    } catch {
      /* table may not exist yet — fall back to env */
    }
  }
  return ENV_CREDS;
}

export function hfxConfigured(creds?: HfxCreds): boolean {
  return !!(creds ?? ENV_CREDS).url;
}

// One MCP session per credential set (different clinics = different sessions).
const sessions = new Map<string, { sessionId: string | null; initialized: boolean }>();

function session(creds: HfxCreds) {
  const k = `${creds.url}|${creds.key}`;
  let s = sessions.get(k);
  if (!s) {
    s = { sessionId: null, initialized: false };
    sessions.set(k, s);
  }
  return s;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

// One JSON-RPC exchange. Streamable HTTP servers may answer as plain JSON or as
// an SSE stream — parse both. `id === undefined` marks a notification (no reply).
async function rpc(creds: HfxCreds, method: string, params: unknown, id?: number): Promise<any> {
  const s = session(creds);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (creds.key) headers.Authorization = `Bearer ${creds.key}`;
  if (s.sessionId) headers["mcp-session-id"] = s.sessionId;

  const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
  if (id !== undefined) body.id = id;
  const res = await fetch(creds.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) s.sessionId = sid;
  if (id === undefined) return null;

  const text = await res.text();
  if (!res.ok) throw new Error(`Hyperfx HTTP ${res.status}: ${text.slice(0, 300)}`);

  let msg: any = null;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      const l = line.trim();
      if (!l.startsWith("data:")) continue;
      try {
        const j = JSON.parse(l.slice(5).trim());
        if (j.id === id || msg === null) msg = j;
      } catch { /* keep scanning */ }
    }
  } else {
    msg = JSON.parse(text);
  }
  if (!msg) throw new Error("Hyperfx returned no payload.");
  if (msg.error) throw new Error(msg.error.message ?? "Hyperfx error");
  return msg.result;
}

async function initialize(creds: HfxCreds): Promise<void> {
  await rpc(
    creds,
    "initialize",
    { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pydent", version: "1.0.0" } },
    0
  );
  await rpc(creds, "notifications/initialized", {});
  session(creds).initialized = true;
}

function resetSession(creds: HfxCreds) {
  sessions.delete(`${creds.url}|${creds.key}`);
}

// MCP tool results arrive as content blocks; unwrap to plain data. Prefer
// structuredContent when present; otherwise JSON-parse the text block.
function unwrap(result: any): unknown {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const block = Array.isArray(result?.content) ? result.content.find((c: any) => c?.type === "text") : null;
  const text = block?.text ?? "";
  try { return JSON.parse(text); } catch { return text; }
}

const NOT_CONFIGURED = "Hyperfx is not configured — save this clinic's Hyperfx MCP URL + API key in Settings → Connections, or set HYPERFX_MCP_URL / HYPERFX_API_KEY in Netlify.";

// Hyperfx separates "authenticated" (the account is CONNECTED on their portal)
// from "enabled" (the toolkit's tools are exposed to an MCP session). A freshly
// connected app therefore answers "unknown tool" until enable_toolkit runs. Map
// each tool prefix to its toolkit so hfxCall can self-enable and retry.
const TOOLKIT_BY_PREFIX: [string, string][] = [
  ["meta_business_", "meta_business"],
  ["google_ads_", "google_ads"],
  ["google_calendar_", "google_calendar"],
  ["google_sheets_", "google_sheets"],
  ["google_analytics_", "google_analytics_toolkit"],
  ["hyperseo_", "hyperseo"],
  ["tiktok_", "tiktok_marketing"],
  ["linkedin_ads_", "linkedin_ads_toolkit"],
  ["search_facebook_", "meta_ads_library"],
  ["scrape_facebook", "meta_ads_library"],
  ["get_facebook_ad", "meta_ads_library"],
  ["outscraper_", "outscraper_toolkit"],
  ["scrape_reddit", "reddit_scraper"],
  ["cmo_", "cmo"],
  ["instagram_scraper", "instagram_scraper"],
];

function toolkitForTool(tool: string): string | null {
  for (const [prefix, toolkit] of TOOLKIT_BY_PREFIX) if (tool.startsWith(prefix)) return toolkit;
  return null;
}

function looksLikeUnknownTool(msg: string): boolean {
  return /unknown tool|not (found|available|enabled)|no such tool|does not exist|invalid tool/i.test(msg);
}

// Enable a toolkit on the MCP connection (works when the account is already
// authenticated on the portal). Returns true when the server confirms; the
// session must then be re-initialized before the new tools are callable.
async function tryEnableToolkit(creds: HfxCreds, toolkitId: string): Promise<boolean> {
  try {
    const result = await rpc(
      creds,
      "tools/call",
      { name: "enable_toolkit", arguments: { toolkit_ids: [toolkitId], reason: "Pydent is reading this connected app's data for the clinic." } },
      Math.floor(Math.random() * 1e9) + 1
    );
    const data = unwrap(result);
    const txt = typeof data === "string" ? data : JSON.stringify(data ?? "");
    return /"status"\s*:\s*"enabled"|already enabled|status.{0,4}enabled/i.test(txt);
  } catch {
    return false;
  }
}

export async function hfxCall(
  tool: string,
  args: Record<string, unknown> = {},
  creds: HfxCreds = ENV_CREDS
): Promise<{ ok: boolean; data?: unknown; content?: unknown[]; error?: string }> {
  if (!creds.url) return { ok: false, error: NOT_CONFIGURED };
  let enableTried = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!session(creds).initialized) await initialize(creds);
      const result = await rpc(creds, "tools/call", { name: tool, arguments: args }, Math.floor(Math.random() * 1e9) + 1);
      if (result?.isError) {
        const block = Array.isArray(result?.content) ? result.content.find((c: any) => c?.type === "text") : null;
        const errText = String(block?.text ?? "Tool call failed");
        const toolkit = toolkitForTool(tool);
        if (!enableTried && toolkit && looksLikeUnknownTool(errText)) {
          enableTried = true;
          if (await tryEnableToolkit(creds, toolkit)) {
            resetSession(creds); // enable_toolkit requires a fresh MCP session
            continue;
          }
        }
        return { ok: false, error: errText.slice(0, 500) };
      }
      return { ok: true, data: unwrap(result), content: Array.isArray(result?.content) ? result.content : [] };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Hyperfx call failed";
      const toolkit = toolkitForTool(tool);
      if (!enableTried && toolkit && looksLikeUnknownTool(msg)) {
        enableTried = true;
        if (await tryEnableToolkit(creds, toolkit)) {
          resetSession(creds);
          continue;
        }
      }
      resetSession(creds); // stale session → re-initialize, then give up
      if (attempt >= 2) return { ok: false, error: msg };
    }
  }
  return { ok: false, error: "Hyperfx call failed" };
}

export interface HfxTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export async function hfxListTools(
  creds: HfxCreds = ENV_CREDS
): Promise<{ ok: boolean; tools?: HfxTool[]; error?: string }> {
  if (!creds.url) return { ok: false, error: NOT_CONFIGURED };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!session(creds).initialized) await initialize(creds);
      const tools: HfxTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const r = await rpc(creds, "tools/list", cursor ? { cursor } : {}, Math.floor(Math.random() * 1e9) + 1);
        for (const t of r?.tools ?? []) tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
        cursor = r?.nextCursor;
        if (!cursor) break;
      }
      return { ok: true, tools };
    } catch (e) {
      resetSession(creds);
      if (attempt === 1) return { ok: false, error: e instanceof Error ? e.message : "Hyperfx unreachable" };
    }
  }
  return { ok: false, error: "Hyperfx unreachable" };
}

// Only read-style tools may be invoked through the generic /api/hyperfx/call
// endpoint — creating/updating ads (i.e. spending money) stays off until a
// proper per-action confirmation UI exists.
const SAFE_TOOL = /(_(list|get|search|query|insights?|report|preview|overview|results?|volume|ideas|difficulty|competitors?|history|intent|intersection|pagespeed|mentions|traffic|rank|benchmarks?|details)($|_))|^(hyperseo_|search_facebook_|scrape_|outscraper_search|outscraper_get)/;

// Tool results wrap tabular rows differently across toolkits — accept every
// shape we've seen: bare array, {data|insights|results|rows: [...]}, the
// insights envelope {summary_metrics, detailed_insights: [...], ...}, or a
// single row object. Prefer a NON-EMPTY row array; when only summary totals
// came back, surface those as one row so totals still compute.
const ROW_KEYS = ["data", "insights", "detailed_insights", "results", "rows"];
export function hfxRows(data: unknown): any[] {
  if (Array.isArray(data)) return data;
  const d = data as any;
  if (d && typeof d === "object") {
    for (const k of ROW_KEYS) {
      if (Array.isArray(d[k]) && d[k].length > 0) return d[k];
    }
    if (d.summary_metrics && typeof d.summary_metrics === "object" && !Array.isArray(d.summary_metrics)) {
      return [d.summary_metrics];
    }
    for (const k of ROW_KEYS) {
      if (Array.isArray(d[k])) return d[k];
    }
    return [d];
  }
  return [];
}

// One insights row, whatever this engine version calls things: flattens a
// nested `metrics` object and lets callers read spend/impressions/… without
// caring whether the field is `spend`, `total_spend`, or inside `metrics`.
export function hfxFlatRow(r: any): any {
  if (r && typeof r === "object" && r.metrics && typeof r.metrics === "object" && !Array.isArray(r.metrics)) {
    return { ...r, ...r.metrics };
  }
  return r ?? {};
}

// True when a (flattened) row carries delivery metrics under any known name.
export function hfxRowHasMetrics(r: any): boolean {
  const f = hfxFlatRow(r);
  return f.spend !== undefined || f.impressions !== undefined || f.total_spend !== undefined || f.total_impressions !== undefined;
}

// Numeric metric off a flattened row, tolerating the total_ prefix.
export function hfxMetric(r: any, key: string): number {
  const f = hfxFlatRow(r);
  const n = Number(f[key] ?? f[`total_${key}`]);
  return Number.isFinite(n) ? n : 0;
}

export function hfxToolIsSafe(tool: string): boolean {
  return SAFE_TOOL.test(tool);
}

// Pull human-readable alert/recommendation lines out of a health-check or
// recommendations payload whose exact shape we don't control. Walks the object
// a few levels deep, keeps entries that look like findings, skips passes.
const ALERT_TEXT_KEYS = ["title", "message", "recommendation", "error_summary", "summary", "description", "issue", "details", "text"];
const ALERT_NAME_KEYS = ["campaign_name", "ad_name", "adset_name", "ad_set_name", "entity_name", "name", "check", "check_name", "category"];
export function collectAlertStrings(data: unknown, cap = 10): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    const t = s.trim();
    if (t.length > 8 && !/^(ok|pass|passed|healthy|no issues?( found)?)\.?$/i.test(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t.length > 220 ? `${t.slice(0, 220)}…` : t);
    }
  };
  const walk = (v: any, depth: number, keyHint: string) => {
    if (out.length >= cap || v == null || depth > 4) return;
    if (typeof v === "string") {
      if (/issue|recommend|alert|warning|error|fatigue|improve/i.test(keyHint)) push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1, keyHint);
      return;
    }
    if (typeof v === "object") {
      const status = String(v.status ?? v.result ?? "");
      const isPass = /^(ok|pass|passed|healthy|good)$/i.test(status);
      const text = ALERT_TEXT_KEYS.map((k) => v[k]).find((x) => typeof x === "string" && x.trim());
      if (text && !isPass) {
        const name = ALERT_NAME_KEYS.map((k) => v[k]).find((x) => typeof x === "string" && x.trim() && x !== text);
        push(name ? `${name}: ${text}` : String(text));
      }
      for (const [k, child] of Object.entries(v)) {
        if (ALERT_TEXT_KEYS.includes(k)) continue;
        walk(child, depth + 1, k);
      }
    }
  };
  walk(data, 0, "");
  return out.slice(0, cap);
}
