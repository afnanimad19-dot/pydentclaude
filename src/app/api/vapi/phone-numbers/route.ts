import { NextRequest, NextResponse } from "next/server";

// Registers a phone number on Vapi and attaches a specific assistant, so inbound
// calls to that number are answered by that agent. The clinic NEVER has to open
// Vapi — our app does it via the Vapi API (VAPI_API_KEY). Supports Twilio (BYOT)
// and BYO SIP trunks (Custom SIP / Ziwo / Maqsam / Go Auto Dial / Vocalcom).

const VAPI_BASE = "https://api.vapi.ai";
export const runtime = "nodejs";

/* eslint-disable @typescript-eslint/no-explicit-any */
function headers() {
  return { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, "Content-Type": "application/json" };
}

export async function POST(req: NextRequest) {
  if (!process.env.VAPI_API_KEY) {
    return NextResponse.json({ ok: false, error: "VAPI_API_KEY is not configured." }, { status: 503 });
  }
  const body = await req.json().catch(() => ({}));
  const { provider, number, nickname, assistantId, config } = body as {
    provider: string; number: string; nickname?: string; assistantId?: string | null; config?: any;
  };
  if (!number) return NextResponse.json({ ok: false, error: "Missing number." }, { status: 400 });
  if (!assistantId) {
    return NextResponse.json({ ok: false, error: "Assign a voice agent first — the agent must be saved (synced to Vapi) so the number can route to it." }, { status: 400 });
  }

  try {
    let payload: Record<string, any>;

    if (provider === "twilio") {
      const sid = config?.twilioAccountSid, token = config?.twilioAuthToken;
      if (!sid || !token) return NextResponse.json({ ok: false, error: "Twilio Account SID + Auth Token are required." }, { status: 400 });
      payload = { provider: "twilio", number, twilioAccountSid: sid, twilioAuthToken: token, assistantId, name: nickname || number };
    } else {
      // BYO SIP trunk (sip / ziwo / maqsam / goautodial / vocalcom). First make a
      // SIP-trunk credential from the saved config, then create the number on it.
      const gateways: { ip: string }[] = [];
      if (Array.isArray(config?.categories)) {
        for (const c of config.categories) if (c?.ipOrDomain) gateways.push({ ip: String(c.ipOrDomain) });
      }
      const host = config?.terminationUri || config?.endpoint || config?.serverUrl || config?.subdomain;
      if (gateways.length === 0 && host) gateways.push({ ip: String(host).replace(/^https?:\/\//, "").replace(/\/.*$/, "") });
      if (gateways.length === 0) {
        return NextResponse.json({ ok: false, error: "This provider needs a SIP gateway/host (termination URI or a gateway IP/domain) to connect on Vapi." }, { status: 400 });
      }
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
      if (!credRes.ok || !credData?.id) {
        return NextResponse.json({ ok: false, error: `Could not create the SIP trunk on Vapi: ${credData?.message ?? credRes.status}` }, { status: 502 });
      }
      payload = { provider: "byo-phone-number", number, credentialId: credData.id, assistantId, name: nickname || number, numberE164CheckEnabled: false };
    }

    const res = await fetch(`${VAPI_BASE}/phone-number`, { method: "POST", headers: headers(), body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: data?.message ?? `Vapi error ${res.status}` }, { status: 502 });
    }
    return NextResponse.json({ ok: true, vapiPhoneNumberId: data?.id, message: "Number connected to Vapi and routed to the agent." });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Failed to connect the number." }, { status: 502 });
  }
}
