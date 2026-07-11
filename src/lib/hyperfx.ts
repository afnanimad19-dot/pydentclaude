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

export async function hfxCall(
  tool: string,
  args: Record<string, unknown> = {},
  creds: HfxCreds = ENV_CREDS
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  if (!creds.url) return { ok: false, error: NOT_CONFIGURED };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!session(creds).initialized) await initialize(creds);
      const result = await rpc(creds, "tools/call", { name: tool, arguments: args }, Math.floor(Math.random() * 1e9) + 1);
      if (result?.isError) {
        const block = Array.isArray(result?.content) ? result.content.find((c: any) => c?.type === "text") : null;
        return { ok: false, error: String(block?.text ?? "Tool call failed").slice(0, 500) };
      }
      return { ok: true, data: unwrap(result) };
    } catch (e) {
      resetSession(creds); // stale session → re-initialize once, then give up
      if (attempt === 1) return { ok: false, error: e instanceof Error ? e.message : "Hyperfx call failed" };
    }
  }
  return { ok: false, error: "Hyperfx call failed" };
}

export async function hfxListTools(
  creds: HfxCreds = ENV_CREDS
): Promise<{ ok: boolean; tools?: { name: string; description?: string }[]; error?: string }> {
  if (!creds.url) return { ok: false, error: NOT_CONFIGURED };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!session(creds).initialized) await initialize(creds);
      const tools: { name: string; description?: string }[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const r = await rpc(creds, "tools/list", cursor ? { cursor } : {}, Math.floor(Math.random() * 1e9) + 1);
        for (const t of r?.tools ?? []) tools.push({ name: t.name, description: t.description });
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

export function hfxToolIsSafe(tool: string): boolean {
  return SAFE_TOOL.test(tool);
}
