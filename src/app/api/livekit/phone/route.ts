import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { getLivekitCreds, lkConfigured, lkSipDomain, sipClient, agentRoomConfig, dispatchMetadata } from "@/lib/livekit";

// Connect a phone number to a LiveKit agent. LiveKit receives calls over SIP,
// so a carrier (Twilio / Telnyx / Ziwo / the clinic PBX) forwards the number to
// the project's SIP domain; here we create the matching INBOUND TRUNK (which
// numbers + who may send) and a DISPATCH RULE that drops each caller into its
// own room and auto-dispatches the Pydent worker with { pydentAgentId, ws } —
// so the number rings straight into the chosen agent. DELETE removes both.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { ws, number, agentId, authUsername, authPassword, allowedAddresses, nickname } = await req.json().catch(() => ({}));
  if (!ws || !number) return NextResponse.json({ error: "ws and number are required." }, { status: 400 });
  const creds = await getLivekitCreds(String(ws));
  if (!lkConfigured(creds)) return NextResponse.json({ error: "LiveKit isn't configured — add the URL, API key and secret in Settings → Connections → LiveKit." }, { status: 503 });

  let agentName = "";
  if (agentId) {
    const { data: a } = await supabase.from("agents").select("id, name, workspace_id").eq("id", String(agentId)).maybeSingle();
    if (!a || String(a.workspace_id) !== String(ws)) return NextResponse.json({ error: "Agent not found in this workspace." }, { status: 404 });
    agentName = a.name;
  }

  const sip = sipClient(creds);
  const num = String(number).trim();
  const wsShort = String(ws).slice(0, 8);
  try {
    const trunk = await sip.createSipInboundTrunk(`pydent-${wsShort}-${num}`, [num], {
      ...(authUsername ? { authUsername: String(authUsername), authPassword: String(authPassword ?? "") } : {}),
      ...(Array.isArray(allowedAddresses) && allowedAddresses.length ? { allowedAddresses: allowedAddresses.map(String) } : {}),
      krispEnabled: true,
      metadata: JSON.stringify({ ws, nickname: nickname ?? "" }),
    });
    const rule = await sip.createSipDispatchRule(
      { type: "individual", roomPrefix: `p_${ws}_call_` },
      {
        name: `pydent-${wsShort}-${num}`,
        trunkIds: [trunk.sipTrunkId],
        metadata: JSON.stringify({ ws, agentId: agentId ?? null }),
        ...(agentId ? { roomConfig: agentRoomConfig(creds, dispatchMetadata(String(agentId), String(ws), { source: "phone", number: num })) } : {}),
      }
    );
    return NextResponse.json({
      ok: true,
      trunkId: trunk.sipTrunkId,
      ruleId: rule.sipDispatchRuleId,
      sipDomain: lkSipDomain(creds.url),
      sipUri: `sip:${num.replace(/^\+/, "")}@${lkSipDomain(creds.url)}`,
      message: agentId
        ? `${num} is connected on LiveKit — calls ring straight into ${agentName}. Point your carrier at the SIP address shown.`
        : `${num} is on LiveKit, but no agent is assigned yet — assign one so calls are answered.`,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "LiveKit SIP setup failed" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const { ws, trunkId, ruleId } = await req.json().catch(() => ({}));
  const creds = await getLivekitCreds(ws ? String(ws) : null);
  if (!lkConfigured(creds)) return NextResponse.json({ ok: false, error: "LiveKit not configured" });
  const sip = sipClient(creds);
  try { if (ruleId) await sip.deleteSipDispatchRule(String(ruleId)); } catch { /* may already be gone */ }
  try { if (trunkId) await sip.deleteSipTrunk(String(trunkId)); } catch { /* may already be gone */ }
  return NextResponse.json({ ok: true });
}
