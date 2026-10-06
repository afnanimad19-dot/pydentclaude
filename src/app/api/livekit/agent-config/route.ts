import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { livekitAgentConfig, resolveWorkerToken, requestOrigin, workspaceHasOwnWorkerToken } from "@/lib/livekit";
import { clinicTimezone } from "@/lib/booking-server";
import { resolveWorkerAgent, enforceWorkerWorkspacePin } from "@/lib/worker-agent-lookup";

// Called by the deployed LiveKit worker at the start of every call: given the
// dispatch metadata { pydentAgentId, ws } (both required) it returns the agent's LIVE config
// (instructions incl. knowledge base, greeting, STT/LLM/TTS + voice, tool
// flags, timeouts). Because the worker reads this per call, editing an agent in
// Pydent takes effect on the very next call — no sync step.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { token, pydentAgentId, ws: bodyWs } = await req.json().catch(() => ({}));
  const auth = await resolveWorkerToken(token);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });

  // Fail closed: the dispatch metadata must name the agent. There is no
  // "oldest agent in the workspace" fallback — a wrong agent answering a
  // production call is worse than a refused job.
  const found = await resolveWorkerAgent(
    {
      getVoiceAgent: async (id: string) => {
        const { data } = await supabase.from("agents").select("*").eq("kind", "voice").eq("id", id).maybeSingle();
        return data ?? null;
      },
    },
    { tokenWorkspace: auth.ws ?? null, bodyWorkspace: bodyWs, pydentAgentId }
  );
  if (!found.ok) return NextResponse.json({ error: found.error }, { status: found.status });
  // Workspace pinning: the global env token is a fallback only for workspaces
  // without their own worker token — it cannot read a provisioned clinic's
  // agent config (whose instructions include the knowledge base).
  const pin = await enforceWorkerWorkspacePin(
    { workspaceHasOwnToken: workspaceHasOwnWorkerToken },
    auth.ws ?? null,
    found.workspaceId
  );
  if (!pin.ok) return NextResponse.json({ error: pin.error }, { status: pin.status });
  const agent = found.agent;
  // Compile the prompt against the CLINIC's timezone, not the server's UTC,
  // and resolve the clinic's display name for the default closing message
  // ("Thank you for calling <clinic>...") — never hardcoded to one clinic.
  const agentWs = found.workspaceId;
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
