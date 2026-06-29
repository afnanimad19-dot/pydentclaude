// Server-side Vapi outbound-call helpers, shared by the campaign dialer endpoint
// and the workflow runner so an automation can place a real call.

const VAPI_BASE = "https://api.vapi.ai";

function headers() {
  return { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, "Content-Type": "application/json" };
}
const digits = (s: string) => String(s ?? "").replace(/\D/g, "");

// Resolve the Vapi phone-number id: prefer the stored id, else match by E.164.
export async function resolveVapiPhoneNumberId(opts: { vapiPhoneNumberId?: string | null; fromNumber?: string | null }): Promise<string | null> {
  if (opts.vapiPhoneNumberId) return opts.vapiPhoneNumberId;
  if (!opts.fromNumber || !process.env.VAPI_API_KEY) return null;
  try {
    const res = await fetch(`${VAPI_BASE}/phone-number`, { headers: headers() });
    const data = await res.json().catch(() => []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const match = (Array.isArray(data) ? data : []).find((p: any) => digits(p?.number).endsWith(digits(opts.fromNumber as string).slice(-9)));
    return match?.id ?? null;
  } catch {
    return null;
  }
}

// Place a single outbound call: `assistantId` answers, dialing `toNumber` from `phoneNumberId`.
export async function placeOutboundCall(opts: { assistantId: string; phoneNumberId: string; toNumber: string }): Promise<{ ok: boolean; error?: string }> {
  if (!process.env.VAPI_API_KEY) return { ok: false, error: "VAPI_API_KEY is not configured." };
  try {
    const res = await fetch(`${VAPI_BASE}/call`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ assistantId: opts.assistantId, phoneNumberId: opts.phoneNumberId, customer: { number: opts.toNumber } }),
    });
    if (res.ok) return { ok: true };
    const d = await res.json().catch(() => ({}));
    return { ok: false, error: d?.message ?? `Vapi error ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Call failed." };
  }
}
