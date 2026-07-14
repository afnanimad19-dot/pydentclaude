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
  if (live.ok) {
    const accounts = (live.data as any)?.accounts ?? [];
    out.metaAdAccounts = accounts.map((a: any) => a.name ?? a.id);
    out.verdict = "Everything works — agents and the Ads tabs can fetch Meta data with these credentials.";
  } else {
    out.metaLiveError = live.error;
    out.verdict = "Engine reachable but the Meta data call failed — see metaLiveError for the exact reason.";
  }

  return NextResponse.json(out);
}
