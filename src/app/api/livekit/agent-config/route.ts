import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { livekitAgentConfig, workerTokenOk, requestOrigin } from "@/lib/livekit";

// Called by the deployed LiveKit worker at the start of every call: given the
// dispatch metadata { pydentAgentId, ws } it returns the agent's LIVE config
// (instructions incl. knowledge base, greeting, STT/LLM/TTS + voice, tool
// flags, timeouts). Because the worker reads this per call, editing an agent in
// Pydent takes effect on the very next call — no sync step.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { token, pydentAgentId, ws } = await req.json().catch(() => ({}));
  const auth = workerTokenOk(token);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });

  let q = supabase.from("agents").select("*").eq("kind", "voice");
  if (pydentAgentId) q = q.eq("id", String(pydentAgentId));
  else if (ws) q = q.eq("workspace_id", String(ws)).order("created_at", { ascending: true }).limit(1);
  else return NextResponse.json({ error: "pydentAgentId or ws is required." }, { status: 400 });

  const { data: rows } = await q;
  const agent = Array.isArray(rows) ? rows[0] : rows;
  if (!agent) return NextResponse.json({ error: "No voice agent found for this call." }, { status: 404 });
  if (ws && agent.workspace_id && String(agent.workspace_id) !== String(ws)) {
    return NextResponse.json({ error: "Agent does not belong to this workspace." }, { status: 403 });
  }
  return NextResponse.json({ ok: true, config: livekitAgentConfig(agent, String(agent.workspace_id ?? ws ?? ""), requestOrigin(req)) });
}
