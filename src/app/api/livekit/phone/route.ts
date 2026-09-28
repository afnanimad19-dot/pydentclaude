import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { getLivekitCreds, lkConfigured, lkSipDomain, sipClient, agentRoomConfig, builderMetadata, boundLivekitAgent, requestOrigin } from "@/lib/livekit";
import { authorizeRequest } from "@/lib/server-auth-deps";
import { sameNumber } from "@/lib/number-routing";

// Connect a NEW phone number to a LiveKit agent. LiveKit receives calls over
// SIP, so a carrier (Twilio / Telnyx / Ziwo / the clinic PBX) forwards the
// number to the project's SIP domain; here we create the matching INBOUND TRUNK
// (which numbers + who may send) and a DISPATCH RULE that drops each caller into
// its own room and auto-dispatches the Pydent worker with { pydentAgentId, ws }
// — so the number rings straight into the chosen agent. DELETE removes both.
//
// Security: admin only; the workspace comes from the bearer token (a `ws` in
// the body is ignored); workspace LiveKit credentials only (no env fallback);
// numbers whose routing is linked/protected (migration 0064) can never be
// recreated or deleted here — reassigning their agent is an in-place rule
// update via /api/voice-numbers/[id]/assign. DELETE only accepts trunk/rule ids
// this workspace itself created and stored.
export const runtime = "nodejs";

/* eslint-disable @typescript-eslint/no-explicit-any */
function isManagedRouting(row: any): boolean {
  return !!row && (row.routing_protected === true || (row.routing_provider && row.routing_provider !== "none") || !!row.livekit_dispatch_rule_id || !!row.livekit_trunk_id);
}

export async function POST(req: NextRequest) {
  const auth = await authorizeRequest(req, { requireAdmin: true });
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const ws = auth.workspaceId;
  const { number, agentId, authUsername, authPassword, allowedAddresses, nickname } = await req.json().catch(() => ({}));
  if (!number) return NextResponse.json({ error: "number is required." }, { status: 400 });
  const creds = await getLivekitCreds(ws);
  if (!lkConfigured(creds) || creds.source !== "workspace") {
    return NextResponse.json({ error: "LiveKit isn't configured for this workspace — add the URL, API key and secret in Settings → Connections → LiveKit." }, { status: 503 });
  }

  const num = String(number).trim();
  // Never build a second trunk/rule for a number whose routing is linked or protected.
  const { data: rows } = await supabase.from("voice_numbers").select("*").eq("workspace_id", ws);
  if ((rows ?? []).some((r: any) => sameNumber(r.number, num) && isManagedRouting(r))) {
    return NextResponse.json({ error: "This number already has linked production routing — change its agent from Voice Agent Settings; trunks and rules are never recreated." }, { status: 409 });
  }
  // A clinic landline is delivered by the on-prem PBX route (its own trunk);
  // a second Pydent-created trunk for the same number could overlap it.
  if ((rows ?? []).some((r: any) => sameNumber(r.number, num) && r.provider === "landline")) {
    return NextResponse.json({ error: "This is the clinic landline — it is routed by the on-prem PBX trunk. Link that existing route in Voice Agent Settings instead of creating a new one." }, { status: 409 });
  }

  let agentName = "";
  let agentRow: Record<string, unknown> | null = null;
  if (agentId) {
    const { data: a } = await supabase.from("agents").select("*").eq("id", String(agentId)).eq("workspace_id", ws).maybeSingle();
    if (!a) return NextResponse.json({ error: "Agent not found in this workspace." }, { status: 404 });
    agentName = a.name;
    agentRow = a;
  }
  // The number dispatches the agent's bound LiveKit agent (console-built or the
  // Pydent worker) with the agent's LIVE instructions/greeting as metadata.
  const bound = agentRow ? boundLivekitAgent(agentRow, creds) : { name: creds.agentName, external: false };

  const sip = sipClient(creds);
  const wsShort = ws.slice(0, 8);
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
        ...(agentRow ? { roomConfig: agentRoomConfig(creds, builderMetadata(agentRow, ws, requestOrigin(req), { source: "phone", number: num }), bound.name) } : {}),
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
  const auth = await authorizeRequest(req, { requireAdmin: true });
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const ws = auth.workspaceId;
  const { trunkId, ruleId } = await req.json().catch(() => ({}));
  const tId = trunkId ? String(trunkId) : "";
  const rId = ruleId ? String(ruleId) : "";
  if (!tId && !rId) return NextResponse.json({ ok: false, error: "trunkId or ruleId is required." }, { status: 400 });

  // Ids must belong to a Pydent-created LiveKit number in THIS workspace…
  const { data: rows } = await supabase.from("voice_numbers").select("*").eq("workspace_id", ws).eq("provider", "livekit");
  const owner = (rows ?? []).find((r: any) => {
    const c = r.config ?? {};
    return (!tId || c.livekitTrunkId === tId) && (!rId || c.livekitRuleId === rId);
  });
  if (!owner) return NextResponse.json({ ok: false, error: "Those LiveKit ids are not owned by a number in this workspace." }, { status: 404 });
  if (isManagedRouting(owner)) return NextResponse.json({ ok: false, error: "This number's routing is linked/protected and cannot be deleted." }, { status: 409 });
  // …and must not be linked production routing on ANY number row (migration 0064).
  for (const [col, val] of [["livekit_dispatch_rule_id", rId], ["livekit_trunk_id", tId]] as const) {
    if (!val) continue;
    const { data: linked, error } = await supabase.from("voice_numbers").select("id").eq(col, val).limit(1);
    if (!error && (linked ?? []).length) return NextResponse.json({ ok: false, error: "Those LiveKit ids back linked production routing and cannot be deleted." }, { status: 409 });
  }

  const creds = await getLivekitCreds(ws);
  if (!lkConfigured(creds) || creds.source !== "workspace") return NextResponse.json({ ok: false, error: "LiveKit is not configured for this workspace." }, { status: 503 });
  const sip = sipClient(creds);
  const errors: string[] = [];
  const gone = (e: unknown) => /not.?found|does not exist/i.test(e instanceof Error ? e.message : String(e));
  try { if (rId) await sip.deleteSipDispatchRule(rId); } catch (e) { if (!gone(e)) errors.push(`rule: ${e instanceof Error ? e.message : "delete failed"}`); }
  try { if (tId) await sip.deleteSipTrunk(tId); } catch (e) { if (!gone(e)) errors.push(`trunk: ${e instanceof Error ? e.message : "delete failed"}`); }
  if (errors.length) return NextResponse.json({ ok: false, error: errors.join("; ") }, { status: 502 });
  return NextResponse.json({ ok: true });
}
