import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { createXaiClientSecret, buildXaiInstructions, xaiAgentTools, resolveXaiVoice, XAI_REALTIME_URL } from "@/lib/xai-voice";

// Starts an in-browser Grok voice session for an agent: loads the agent's full
// config, builds the realtime session payload (instructions, voice, tools), and
// mints a short-lived xAI client secret so the browser can open the WebSocket
// itself — the API key never leaves the server.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { agentId } = await req.json().catch(() => ({}));
  if (!agentId) return NextResponse.json({ error: "agentId is required." }, { status: 400 });

  const { data: agent } = await supabase.from("agents").select("*").eq("id", agentId).maybeSingle();
  if (!agent) return NextResponse.json({ error: "Agent not found." }, { status: 404 });

  const secret = await createXaiClientSecret();
  if (!secret.ok || !secret.token) return NextResponse.json({ error: secret.error }, { status: 503 });

  const vs = (agent.voice_settings ?? {}) as Record<string, unknown>;
  return NextResponse.json({
    ok: true,
    token: secret.token,
    url: XAI_REALTIME_URL,
    model: /^grok-voice/.test(String(agent.model ?? "")) ? agent.model : "grok-voice-latest",
    voice: resolveXaiVoice(agent.voice),
    instructions: buildXaiInstructions(agent),
    tools: xaiAgentTools(agent),
    firstMessage: agent.first_message || `Hi, this is ${agent.name} from the dental office. How can I help?`,
    greetFirst: (agent.first_message_mode ?? "assistant_first") !== "user_first",
    agentName: agent.name,
    // Surface a couple of tuning knobs the browser session applies.
    maxSilenceSec: Number(vs.maxSilenceDuration ?? 30) || 30,
  });
}
