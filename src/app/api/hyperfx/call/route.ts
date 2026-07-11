import { NextRequest, NextResponse } from "next/server";
import { hfxCall, hfxConfigured, hfxToolIsSafe } from "@/lib/hyperfx";

// Generic gateway: run a Hyperfx tool from the Pydent UI or an AI agent.
// Restricted to read-style tools (list/get/search/insights/SEO/scraping) —
// write actions that create or change live ads are deliberately blocked here
// until there's a per-action confirmation UI, so nothing can spend money
// through this endpoint by accident.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hfxConfigured()) {
    return NextResponse.json({ error: "Hyperfx is not configured — set HYPERFX_MCP_URL and HYPERFX_API_KEY in Netlify." }, { status: 400 });
  }
  let body: { tool?: string; args?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const tool = String(body.tool ?? "").trim();
  if (!tool) return NextResponse.json({ error: "tool is required." }, { status: 400 });
  if (!hfxToolIsSafe(tool)) {
    return NextResponse.json({ error: `"${tool}" is a write action — only read-style Hyperfx tools can run through this endpoint.` }, { status: 403 });
  }
  const r = await hfxCall(tool, body.args ?? {});
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
  return NextResponse.json({ ok: true, data: r.data });
}
