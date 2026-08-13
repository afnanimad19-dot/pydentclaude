import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { createXaiClientSecret, buildXaiInstructions, xaiAgentTools, resolveXaiVoice, xaiLanguageHint, XAI_REALTIME_URL } from "@/lib/xai-voice";

// Called by the on-prem Pydent ARI connector at the start of every inbound
// landline call. Given the dialed number, it resolves WHICH agent answers and
// WHICH engine (xAI Grok / Vapi) the workspace has selected, and returns
// everything the connector needs to bridge the call:
//   • engine "xai"  → a fresh ephemeral client secret + realtime session config
//                     so the connector opens the xAI WebSocket itself.
//   • engine "vapi" → the agent's Vapi assistant id, so the connector hands the
//                     call to Vapi (SIP) instead of bridging audio itself.
// The connector authenticates with a shared token (PYDENT_CONNECTOR_TOKEN) so a
// leaked box can't be used to mint xAI secrets at will.
export const runtime = "nodejs";

function digits(s: string): string {
  return String(s ?? "").replace(/\D/g, "");
}

export async function POST(req: NextRequest) {
  const { token, ws, dialedNumber, agentId: forcedAgentId } = await req.json().catch(() => ({}));

  const expected = process.env.PYDENT_CONNECTOR_TOKEN || "";
  if (!expected) return NextResponse.json({ error: "Connector auth not configured on the server (set PYDENT_CONNECTOR_TOKEN)." }, { status: 503 });
  if (token !== expected) return NextResponse.json({ error: "Unauthorized connector." }, { status: 401 });
  if (!ws) return NextResponse.json({ error: "ws is required." }, { status: 400 });

  // Find the landline profile for the dialed number (match on trailing digits so
  // formatting differences don't matter), then the agent assigned to it.
  let agentId: string | null = forcedAgentId ?? null;
  if (!agentId) {
    const { data: nums } = await supabase.from("voice_numbers").select("number, agent_id, provider").eq("workspace_id", ws).eq("provider", "landline");
    const want = digits(dialedNumber).slice(-7);
    const hit = (nums ?? []).find((n) => want && digits(n.number).endsWith(want)) ?? (nums ?? [])[0];
    agentId = hit?.agent_id ?? null;
  }
  if (!agentId) return NextResponse.json({ error: "No voice agent is assigned to this landline yet." }, { status: 404 });

  const { data: agent } = await supabase.from("agents").select("*").eq("id", agentId).maybeSingle();
  if (!agent) return NextResponse.json({ error: "Assigned agent not found." }, { status: 404 });

  // Which engine does this workspace drive its voice agents with?
  const { data: pref } = await supabase.from("connections").select("account_label").eq("workspace_id", ws).eq("provider", "voice_engine").limit(1).maybeSingle();
  const engine = pref?.account_label === "vapi" ? "vapi" : "xai";

  if (engine === "vapi") {
    if (!agent.vapi_assistant_id) {
      return NextResponse.json({ error: `Voice engine is Vapi but "${agent.name}" isn't synced to Vapi yet — open the agent and Save it once.` }, { status: 409 });
    }
    return NextResponse.json({ ok: true, engine: "vapi", agentId, agentName: agent.name, vapiAssistantId: agent.vapi_assistant_id });
  }

  // xAI: mint a short-lived client secret and hand back the realtime config,
  // mirroring what the in-browser session route returns.
  const secret = await createXaiClientSecret();
  if (!secret.ok || !secret.token) return NextResponse.json({ error: secret.error ?? "Could not start an xAI session." }, { status: 503 });

  const vs = (agent.voice_settings ?? {}) as Record<string, unknown>;
  return NextResponse.json({
    ok: true,
    engine: "xai",
    agentId,
    agentName: agent.name,
    token: secret.token,
    url: XAI_REALTIME_URL,
    model: /^grok-voice/.test(String(agent.model ?? "")) ? agent.model : "grok-voice-latest",
    voice: resolveXaiVoice(agent.voice),
    instructions: buildXaiInstructions(agent),
    tools: xaiAgentTools(agent),
    firstMessage: agent.first_message || `Hi, this is ${agent.name} from the dental office. How can I help?`,
    greetFirst: (agent.first_message_mode ?? "assistant_first") !== "user_first",
    languageHint: xaiLanguageHint(agent.language),
    maxSilenceSec: Number(vs.maxSilenceDuration ?? 30) || 30,
  });
}
