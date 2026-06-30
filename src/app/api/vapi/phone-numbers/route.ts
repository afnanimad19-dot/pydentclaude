import { NextRequest, NextResponse } from "next/server";

// Registers a phone number on Vapi and attaches a specific assistant, so inbound
// calls to that number are answered by that agent. The clinic NEVER has to open
// Vapi — our app does it via the Vapi API (VAPI_API_KEY). Supports Twilio (BYOT)
// and BYO SIP trunks (Custom SIP / Ziwo / Maqsam / Go Auto Dial / Vocalcom).
//
// POST  — first-time register + attach assistant (returns the new Vapi number id).
// PATCH — re-route an already-registered number to a different agent (by Vapi id,
//         or by looking the number up); falls back to POST-style create if it was
//         never registered.

const VAPI_BASE = "https://api.vapi.ai";
export const runtime = "nodejs";

/* eslint-disable @typescript-eslint/no-explicit-any */
function headers() {
  return { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, "Content-Type": "application/json" };
}

const digits = (s: string) => String(s ?? "").replace(/\D/g, "");

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

// Create the number on Vapi. Returns the new Vapi phone-number id.
async function createNumber(opts: { provider: string; number: string; nickname?: string; assistantId: string; config?: any }) {
  const built = await buildCreatePayload(opts);
  if (built.error) return { ok: false as const, error: built.error, status: built.status ?? 400 };
  const res = await fetch(`${VAPI_BASE}/phone-number`, { method: "POST", headers: headers(), body: JSON.stringify(built.payload) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false as const, error: data?.message ?? `Vapi error ${res.status}`, status: 502 };
  return { ok: true as const, vapiPhoneNumberId: data?.id as string | undefined };
}

// Look up an existing Vapi number by E.164 (last 9 digits).
async function findVapiNumberId(number: string): Promise<string | null> {
  try {
    const res = await fetch(`${VAPI_BASE}/phone-number`, { headers: headers() });
    const data = await res.json().catch(() => []);
    const match = (Array.isArray(data) ? data : []).find((p: any) => digits(p?.number).endsWith(digits(number).slice(-9)));
    return match?.id ?? null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  if (!process.env.VAPI_API_KEY) {
    return NextResponse.json({ ok: false, error: "VAPI_API_KEY is not configured." }, { status: 503 });
  }
  const body = await req.json().catch(() => ({}));
  const { provider, number, nickname, assistantId, config } = body as { provider: string; number: string; nickname?: string; assistantId?: string | null; config?: any };
  if (!number) return NextResponse.json({ ok: false, error: "Missing number." }, { status: 400 });
  if (!assistantId) {
    return NextResponse.json({ ok: false, error: "Assign a voice agent first — the agent must be saved (synced to Vapi) so the number can route to it." }, { status: 400 });
  }
  try {
    const r = await createNumber({ provider, number, nickname, assistantId, config });
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true, vapiPhoneNumberId: r.vapiPhoneNumberId, message: "Number connected to Vapi and routed to the agent." });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Failed to connect the number." }, { status: 502 });
  }
}

// Re-route an existing number to a different agent. Prefers the stored Vapi id;
// otherwise finds the number on Vapi; if it was never registered, creates it.
export async function PATCH(req: NextRequest) {
  if (!process.env.VAPI_API_KEY) {
    return NextResponse.json({ ok: false, error: "VAPI_API_KEY is not configured." }, { status: 503 });
  }
  const body = await req.json().catch(() => ({}));
  const { vapiPhoneNumberId, provider, number, nickname, assistantId, config } = body as { vapiPhoneNumberId?: string | null; provider: string; number: string; nickname?: string; assistantId?: string | null; config?: any };
  if (!number) return NextResponse.json({ ok: false, error: "Missing number." }, { status: 400 });
  if (!assistantId) {
    return NextResponse.json({ ok: false, error: "Assign a voice agent that's been saved (synced to Vapi) so the number can route to it." }, { status: 400 });
  }
  try {
    const id = vapiPhoneNumberId || (await findVapiNumberId(number));
    if (id) {
      const res = await fetch(`${VAPI_BASE}/phone-number/${id}`, { method: "PATCH", headers: headers(), body: JSON.stringify({ assistantId }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return NextResponse.json({ ok: false, error: data?.message ?? `Vapi error ${res.status}` }, { status: 502 });
      return NextResponse.json({ ok: true, vapiPhoneNumberId: data?.id ?? id, message: "Inbound calls now route to this agent." });
    }
    // Never registered — create it now.
    const r = await createNumber({ provider, number, nickname, assistantId, config });
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true, vapiPhoneNumberId: r.vapiPhoneNumberId, message: "Number registered on Vapi and routed to the agent." });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Failed to update the number." }, { status: 502 });
  }
}
