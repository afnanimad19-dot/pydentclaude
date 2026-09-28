import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { authorizeRequest } from "@/lib/server-auth-deps";

// REGISTERS a workspace phone number on Vapi (first time only) and attaches the
// chosen agent's Vapi assistant. The clinic never opens Vapi — our app does it
// via the Vapi API (VAPI_API_KEY). Supports Twilio (BYOT) and BYO SIP trunks
// (Custom SIP / Ziwo / Maqsam / Go Auto Dial / Vocalcom).
//
// Security: admin only; the workspace comes from the bearer token. The browser
// sends only { numberId, agentId } — the number, its provider config and the
// assistant id are all resolved server-side from THIS workspace's rows.
//
// Never: registers a clinic landline or LiveKit number on Vapi, looks a number
// up by its digits in the (shared) Vapi account, or re-routes an existing
// number. Re-routing a registered number is the guarded reassignment in
// /api/voice-numbers/[id]/assign, which requires the stored Vapi id.

const VAPI_BASE = "https://api.vapi.ai";
export const runtime = "nodejs";

const VAPI_REGISTRABLE = new Set(["twilio", "sip", "ziwo", "maqsam", "goautodial", "vocalcom"]);

/* eslint-disable @typescript-eslint/no-explicit-any */
function headers() {
  return { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, "Content-Type": "application/json" };
}

// Build the Vapi /phone-number create payload (Twilio direct, or BYO SIP trunk).
// For SIP it first creates a trunk credential. Returns { payload } or { error }.
async function buildCreatePayload(opts: { provider: string; number: string; nickname?: string; assistantId: string; config?: any }): Promise<{ payload?: Record<string, any>; error?: string; status?: number }> {
  const { provider, number, nickname, assistantId, config } = opts;
  if (provider === "twilio") {
    const sid = config?.twilioAccountSid, token = config?.twilioAuthToken;
    if (!sid || !token) return { error: "Twilio Account SID + Auth Token are required.", status: 400 };
    return { payload: { provider: "twilio", number, twilioAccountSid: sid, twilioAuthToken: token, assistantId, name: nickname || number, smsEnabled: config?.smsEnabled !== false } };
  }
  // BYO SIP trunk (sip / ziwo / maqsam / goautodial / vocalcom).
  const gateways: { ip: string }[] = [];
  if (Array.isArray(config?.categories)) {
    for (const c of config.categories) if (c?.ipOrDomain) gateways.push({ ip: String(c.ipOrDomain) });
  }
  const host = config?.terminationUri || config?.endpoint || config?.serverUrl || config?.subdomain;
  if (gateways.length === 0 && host) gateways.push({ ip: String(host).replace(/^https?:\/\//, "").replace(/\/.*$/, "") });
  if (gateways.length === 0) return { error: "This provider needs a SIP gateway/host (termination URI or a gateway IP/domain) to connect on Vapi.", status: 400 };
  const credBody: Record<string, any> = {
    provider: "byo-sip-trunk",
    name: `${nickname || number} trunk`,
    gateways,
    outboundLeadingPlusEnabled: config?.e164LeadingPlus !== false,
  };
  if (config?.requiresRegistration && config?.username) {
    credBody.outboundAuthenticationPlan = { authUsername: config.username, authPassword: config.password ?? "" };
  }
  const credRes = await fetch(`${VAPI_BASE}/credential`, { method: "POST", headers: headers(), body: JSON.stringify(credBody) });
  const credData = await credRes.json().catch(() => ({}));
  if (!credRes.ok || !credData?.id) return { error: `Could not create the SIP trunk on Vapi: ${credData?.message ?? credRes.status}`, status: 502 };
  return { payload: { provider: "byo-phone-number", number, credentialId: credData.id, assistantId, name: nickname || number, numberE164CheckEnabled: false } };
}

export async function POST(req: NextRequest) {
  const auth = await authorizeRequest(req, { requireAdmin: true });
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  if (!process.env.VAPI_API_KEY) {
    return NextResponse.json({ ok: false, error: "VAPI_API_KEY is not configured." }, { status: 503 });
  }
  const ws = auth.workspaceId;
  const { numberId, agentId } = (await req.json().catch(() => ({}))) as { numberId?: string; agentId?: string };
  if (!numberId || !agentId) return NextResponse.json({ ok: false, error: "numberId and agentId are required." }, { status: 400 });

  const { data: row } = await supabase.from("voice_numbers").select("*").eq("workspace_id", ws).eq("id", String(numberId)).maybeSingle();
  if (!row) return NextResponse.json({ ok: false, error: "Phone number not found." }, { status: 404 });
  if (!VAPI_REGISTRABLE.has(String(row.provider))) {
    return NextResponse.json({ ok: false, error: "This number is not a Vapi-connectable number (clinic landlines and LiveKit numbers are never registered on Vapi)." }, { status: 409 });
  }
  if (row.vapi_phone_number_id) {
    return NextResponse.json({ ok: false, error: "Already registered on Vapi — change its agent from Voice Agent Settings." }, { status: 409 });
  }
  if (row.routing_provider && row.routing_provider !== "none") {
    return NextResponse.json({ ok: false, error: "This number already has provider routing." }, { status: 409 });
  }
  const { data: agent } = await supabase.from("agents").select("id, name, vapi_assistant_id").eq("workspace_id", ws).eq("id", String(agentId)).maybeSingle();
  if (!agent) return NextResponse.json({ ok: false, error: "Agent not found in this workspace." }, { status: 404 });
  if (!agent.vapi_assistant_id) {
    return NextResponse.json({ ok: false, error: "Assign a voice agent that's been saved (synced to Vapi) so the number can route to it." }, { status: 400 });
  }

  try {
    const built = await buildCreatePayload({ provider: String(row.provider), number: String(row.number), nickname: row.nickname ?? "", assistantId: agent.vapi_assistant_id, config: row.config ?? {} });
    if (built.error) return NextResponse.json({ ok: false, error: built.error }, { status: built.status ?? 400 });
    const res = await fetch(`${VAPI_BASE}/phone-number`, { method: "POST", headers: headers(), body: JSON.stringify(built.payload) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.id) return NextResponse.json({ ok: false, error: data?.message ?? `Vapi error ${res.status}` }, { status: 502 });
    const vapiPhoneNumberId = String(data.id);

    // Record the registration server-side (the browser can no longer write
    // routing fields once migration 0064 is applied).
    const withRouting = {
      vapi_phone_number_id: vapiPhoneNumberId,
      agent_id: agent.id,
      routing_provider: "vapi",
      routing_agent_id: agent.id,
      routing_status: "synced",
      routing_verified_at: new Date().toISOString(),
    };
    let { error } = await supabase.from("voice_numbers").update(withRouting).eq("workspace_id", ws).eq("id", row.id);
    if (error && /routing_|assignment_/.test(error.message)) {
      ({ error } = await supabase.from("voice_numbers").update({ vapi_phone_number_id: vapiPhoneNumberId, agent_id: agent.id }).eq("workspace_id", ws).eq("id", row.id));
    }
    if (error) {
      return NextResponse.json({ ok: false, vapiPhoneNumberId, error: `Registered on Vapi, but the link could not be saved: ${error.message}` }, { status: 500 });
    }
    return NextResponse.json({ ok: true, vapiPhoneNumberId, message: "Number connected to Vapi and routed to the agent." });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Failed to connect the number." }, { status: 502 });
  }
}
