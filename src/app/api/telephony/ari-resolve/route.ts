import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { findDeviceByToken } from "@/lib/telephony";
import { getLivekitCreds, lkConfigured, lkSipDomain } from "@/lib/livekit";

// Called by the on-prem Pydent ARI connector at the start of every inbound
// landline call. Given the box's device token it resolves WHICH agent answers
// and WHICH engine (LiveKit / Vapi) the workspace selected, and returns the SIP
// address the box should hand the call to:
//   • engine "livekit" → sip:<number>@<project>.sip.livekit.cloud (the number's
//                        inbound trunk + dispatch rule route it to the agent)
//   • engine "vapi"    → the agent's Vapi assistant id (dialed via Vapi SIP)
// Both engines take the call over SIP, so the box never bridges audio itself.
export const runtime = "nodejs";

function digits(s: string): string {
  return String(s ?? "").replace(/\D/g, "");
}

export async function POST(req: NextRequest) {
  const { deviceToken, token, ws: bodyWs, dialedNumber, agentId: forcedAgentId } = await req.json().catch(() => ({}));

  let ws = bodyWs as string | undefined;
  let agentId: string | null = forcedAgentId ?? null;
  let landlineNumber = "";
  if (deviceToken) {
    const device = await findDeviceByToken(String(deviceToken));
    if (!device) return NextResponse.json({ error: "Unknown device token — re-pair the box in Pydent." }, { status: 401 });
    ws = device.workspace_id;
    agentId = agentId ?? device.agent_id;
    landlineNumber = device.number;
  } else {
    // Legacy fallback: shared connector token + explicit workspace id.
    const expected = process.env.PYDENT_CONNECTOR_TOKEN || "";
    if (!expected || token !== expected) return NextResponse.json({ error: "Unauthorized connector." }, { status: 401 });
    if (!ws) return NextResponse.json({ error: "ws is required." }, { status: 400 });
  }
  if (!ws) return NextResponse.json({ error: "Could not resolve the workspace for this box." }, { status: 400 });

  if (!agentId) {
    const { data: nums } = await supabase.from("voice_numbers").select("number, agent_id, provider").eq("workspace_id", ws).eq("provider", "landline");
    const want = digits(dialedNumber).slice(-7);
    const hit = (nums ?? []).find((n) => want && digits(n.number).endsWith(want)) ?? (nums ?? [])[0];
    agentId = hit?.agent_id ?? null;
    landlineNumber = landlineNumber || hit?.number || "";
  }
  if (!agentId) return NextResponse.json({ error: "No voice agent is assigned to this landline yet." }, { status: 404 });

  const { data: agent } = await supabase.from("agents").select("*").eq("id", agentId).maybeSingle();
  if (!agent) return NextResponse.json({ error: "Assigned agent not found." }, { status: 404 });

  const { data: pref } = await supabase.from("connections").select("account_label").eq("workspace_id", ws).eq("provider", "voice_engine").limit(1).maybeSingle();
  const engine = pref?.account_label === "vapi" ? "vapi" : "livekit";

  if (engine === "vapi") {
    if (!agent.vapi_assistant_id) {
      return NextResponse.json({ error: `Voice engine is Vapi but "${agent.name}" isn't synced to Vapi yet — open the agent and Save it once.` }, { status: 409 });
    }
    return NextResponse.json({ ok: true, engine: "vapi", agentId, agentName: agent.name, vapiAssistantId: agent.vapi_assistant_id, sipUri: `sip:${agent.vapi_assistant_id}@sip.vapi.ai` });
  }

  const creds = await getLivekitCreds(ws);
  if (!lkConfigured(creds)) return NextResponse.json({ error: "Voice engine is LiveKit but LiveKit isn't configured — add it in Settings → Connections → LiveKit." }, { status: 503 });
  const number = digits(landlineNumber || dialedNumber);
  return NextResponse.json({
    ok: true,
    engine: "livekit",
    agentId,
    agentName: agent.name,
    sipDomain: lkSipDomain(creds.url),
    sipUri: `sip:${number || "pydent"}@${lkSipDomain(creds.url)}`,
    note: "Make sure this number has a LiveKit inbound trunk + dispatch rule (Phone Numbers → Add → LiveKit (SIP)) so the call is routed to the agent.",
  });
}
