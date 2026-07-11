// SERVER-ONLY client for the Hyperfx.ai MCP server. Pydent is the frontend;
// Hyperfx runs the tool intelligence at the backend: ads (Meta/Google/TikTok/…),
// Google Calendar, SEO + AI-search visibility, social scraping, and more.
//
// Accounts are connected ONCE on hyperfx.ai (their Connections page does the
// OAuth); after that, every tool of every connected platform is callable from
// here with the workspace's Hyperfx API key. Speaks MCP over Streamable HTTP
// (JSON-RPC 2.0), no SDK dependency.
//
// Env (set in Netlify):
//   HYPERFX_MCP_URL  — the MCP endpoint from hyperfx.ai (required)
//   HYPERFX_API_KEY  — the API key from hyperfx.ai (sent as Bearer)

const MCP_URL = process.env.HYPERFX_MCP_URL ?? "";
const API_KEY = process.env.HYPERFX_API_KEY ?? "";

let sessionId: string | null = null;
let initialized = false;

export function hfxConfigured(): boolean {
  return !!MCP_URL;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (API_KEY) h.Authorization = `Bearer ${API_KEY}`;
  if (sessionId) h["mcp-session-id"] = sessionId;
  return h;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

// One JSON-RPC exchange. Streamable HTTP servers may answer as plain JSON or as
// an SSE stream — parse both. `id === undefined` marks a notification (no reply).
async function rpc(method: string, params: unknown, id?: number): Promise<any> {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
  if (id !== undefined) body.id = id;
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
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

async function initialize(): Promise<void> {
  await rpc(
    "initialize",
    { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pydent", version: "1.0.0" } },
    0
  );
  await rpc("notifications/initialized", {});
  initialized = true;
}

function resetSession() {
  sessionId = null;
  initialized = false;
}

// MCP tool results arrive as content blocks; unwrap to plain data. Prefer
// structuredContent when present; otherwise JSON-parse the text block.
function unwrap(result: any): unknown {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const block = Array.isArray(result?.content) ? result.content.find((c: any) => c?.type === "text") : null;
  const text = block?.text ?? "";
  try { return JSON.parse(text); } catch { return text; }
}

export async function hfxCall(tool: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  if (!MCP_URL) return { ok: false, error: "Hyperfx is not configured — set HYPERFX_MCP_URL and HYPERFX_API_KEY in Netlify." };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!initialized) await initialize();
      const result = await rpc("tools/call", { name: tool, arguments: args }, Math.floor(Math.random() * 1e9) + 1);
      if (result?.isError) {
        const block = Array.isArray(result?.content) ? result.content.find((c: any) => c?.type === "text") : null;
        return { ok: false, error: String(block?.text ?? "Tool call failed").slice(0, 500) };
      }
      return { ok: true, data: unwrap(result) };
    } catch (e) {
      resetSession(); // stale session → re-initialize once, then give up
      if (attempt === 1) return { ok: false, error: e instanceof Error ? e.message : "Hyperfx call failed" };
    }
  }
  return { ok: false, error: "Hyperfx call failed" };
}

export async function hfxListTools(): Promise<{ ok: boolean; tools?: { name: string; description?: string }[]; error?: string }> {
  if (!MCP_URL) return { ok: false, error: "Hyperfx is not configured — set HYPERFX_MCP_URL and HYPERFX_API_KEY in Netlify." };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!initialized) await initialize();
      const tools: { name: string; description?: string }[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const r = await rpc("tools/list", cursor ? { cursor } : {}, Math.floor(Math.random() * 1e9) + 1);
        for (const t of r?.tools ?? []) tools.push({ name: t.name, description: t.description });
        cursor = r?.nextCursor;
        if (!cursor) break;
      }
      return { ok: true, tools };
    } catch (e) {
      resetSession();
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
