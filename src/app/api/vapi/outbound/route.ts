import { NextRequest, NextResponse } from "next/server";

// Place outbound calls for a campaign: a chosen voice agent calls a list of
// contacts from a chosen number. Body: { assistantId, fromNumber, numbers[] }.
// Looks up the Vapi phone-number id by the E.164 number, then dials each contact.
const VAPI_BASE = "https://api.vapi.ai";
export const runtime = "nodejs";
export const maxDuration = 300;

function headers() {
  return { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, "Content-Type": "application/json" };
}

export async function POST(req: NextRequest) {
  if (!process.env.VAPI_API_KEY) return NextResponse.json({ ok: false, error: "VAPI_API_KEY is not configured." }, { status: 503 });
  const { assistantId, fromNumber, vapiPhoneNumberId, numbers } = await req.json().catch(() => ({}));
  if (!assistantId) return NextResponse.json({ ok: false, error: "The campaign's agent isn't synced to Vapi yet — open it and Save once." }, { status: 400 });
  if (!fromNumber && !vapiPhoneNumberId) return NextResponse.json({ ok: false, error: "The campaign has no phone number to call from." }, { status: 400 });
  const list: string[] = Array.isArray(numbers) ? numbers.map((n) => String(n).trim()).filter(Boolean) : [];
  if (list.length === 0) return NextResponse.json({ ok: false, error: "No contact numbers to call (add contacts to the campaign's list)." }, { status: 400 });

  // Prefer the stored Vapi phone-number id (exact); else match by the from-number.
  let phoneNumberId = typeof vapiPhoneNumberId === "string" ? vapiPhoneNumberId : "";
  if (!phoneNumberId) {
    try {
      const res = await fetch(`${VAPI_BASE}/phone-number`, { headers: headers() });
      const data = await res.json().catch(() => []);
      const digits = (s: string) => String(s).replace(/\D/g, "");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const match = (Array.isArray(data) ? data : []).find((p: any) => digits(p?.number ?? "").endsWith(digits(fromNumber).slice(-9)));
      phoneNumberId = match?.id ?? "";
    } catch { /* handled below */ }
  }
  if (!phoneNumberId) {
    return NextResponse.json({ ok: false, error: `That number isn't registered on Vapi yet. Add it in Phone Numbers (assign the agent) first.` }, { status: 400 });
  }

  // Dial each contact (cap the batch so we don't hammer the API).
  const MAX = 50;
  const targets = list.slice(0, MAX);
  let started = 0;
  const errors: string[] = [];
  for (const number of targets) {
    try {
      const res = await fetch(`${VAPI_BASE}/call`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ assistantId, phoneNumberId, customer: { number } }),
      });
      if (res.ok) started++;
      else { const d = await res.json().catch(() => ({})); errors.push(`${number}: ${d?.message ?? res.status}`); }
    } catch (e) {
      errors.push(`${number}: ${e instanceof Error ? e.message : "failed"}`);
    }
  }
  return NextResponse.json({
    ok: started > 0,
    started,
    total: list.length,
    capped: list.length > MAX,
    message: `Started ${started} of ${targets.length} call${targets.length === 1 ? "" : "s"}.${list.length > MAX ? ` (Capped at ${MAX} per run.)` : ""}`,
    errors: errors.slice(0, 5),
  });
}
