import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { livekitAgentConfig, resolveWorkerToken, requestOrigin } from "@/lib/livekit";
import { clinicTimezone } from "@/lib/booking-server";

// Called by the deployed LiveKit worker at the start of every call: given the
// dispatch metadata { pydentAgentId, ws } it returns the agent's LIVE config
// (instructions incl. knowledge base, greeting, STT/LLM/TTS + voice, tool
// flags, timeouts). Because the worker reads this per call, editing an agent in
// Pydent takes effect on the very next call — no sync step.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { token, pydentAgentId, ws: bodyWs } = await req.json().catch(() => ({}));
  const auth = await resolveWorkerToken(token);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  // A per-workspace token pins the worker to its own clinic.
  const ws = auth.ws ?? (bodyWs ? String(bodyWs) : "");

  let q = supabase.from("agents").select("*").eq("kind", "voice");
  if (pydentAgentId) q = q.eq("id", String(pydentAgentId));
  else if (ws) q = q.eq("workspace_id", ws).order("created_at", { ascending: true }).limit(1);
  else return NextResponse.json({ error: "pydentAgentId or ws is required." }, { status: 400 });

  const { data: rows } = await q;
  const agent = Array.isArray(rows) ? rows[0] : rows;
  if (!agent) return NextResponse.json({ error: "No voice agent found for this call." }, { status: 404 });
  if (ws && agent.workspace_id && String(agent.workspace_id) !== ws) {
    return NextResponse.json({ error: "Agent does not belong to this workspace." }, { status: 403 });
  }
  // Compile the prompt against the CLINIC's timezone, not the server's UTC,
  // and resolve the clinic's display name for the default closing message
  // ("Thank you for calling <clinic>...") — never hardcoded to one clinic.
  const agentWs = String(agent.workspace_id ?? ws ?? "");
  const tz = await clinicTimezone(agentWs || null);
  let clinicName = "";
  if (agentWs) {
    try {
      const { data: cs } = await supabase.from("clinic_settings").select("clinic_display_name").eq("workspace_id", agentWs).maybeSingle();
      clinicName = String(cs?.clinic_display_name ?? "").trim();
      if (!clinicName) {
        const { data: w } = await supabase.from("workspaces").select("name").eq("id", agentWs).maybeSingle();
        clinicName = String(w?.name ?? "").trim();
      }
    } catch { /* default goodbye falls back to the generic wording */ }
  }
  return NextResponse.json({ ok: true, config: livekitAgentConfig(agent, agentWs, requestOrigin(req), tz, clinicName) });
}
