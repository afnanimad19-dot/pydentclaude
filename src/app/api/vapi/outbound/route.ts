import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { authorizeRequest } from "@/lib/server-auth-deps";
import { canonicalPhone } from "@/lib/outbound-call";

// LEGACY Vapi dialer (scheduled for removal in Vapi shutdown V3). Place
// outbound calls for a campaign: a chosen voice agent calls a list of
// contacts from a chosen number. Body: { assistantId, fromNumber, numbers[] }.
// Looks up the Vapi phone-number id by the E.164 number, then dials each contact.
//
// Hardened (T1 F-1): this route used to be COMPLETELY UNAUTHENTICATED. It is
// now admin-only and workspace-scoped like /api/livekit/outbound, and every
// target is checked against the permanent do-not-call registry (canonical
// phone form) before any dial. It still dials via Vapi cloud numbers — it can
// never touch the shared FXO line — and dies entirely once VAPI_API_KEY is
// removed (Vapi shutdown V1).
const VAPI_BASE = "https://api.vapi.ai";
export const runtime = "nodejs";
export const maxDuration = 300;

function headers() {
  return { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, "Content-Type": "application/json" };
}

export async function POST(req: NextRequest) {
  const auth = await authorizeRequest(req, { requireAdmin: true });
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const ws = auth.workspaceId;
  if (!process.env.VAPI_API_KEY) return NextResponse.json({ ok: false, error: "VAPI_API_KEY is not configured." }, { status: 503 });
  const { assistantId, fromNumber, vapiPhoneNumberId, numbers } = await req.json().catch(() => ({}));
  if (!assistantId) return NextResponse.json({ ok: false, error: "The campaign's agent isn't synced to Vapi yet — open it and Save once." }, { status: 400 });
  if (!fromNumber && !vapiPhoneNumberId) return NextResponse.json({ ok: false, error: "The campaign has no phone number to call from." }, { status: 400 });
  const raw: string[] = Array.isArray(numbers) ? numbers.map((n) => String(n).trim()).filter(Boolean) : [];
  if (raw.length === 0) return NextResponse.json({ ok: false, error: "No contact numbers to call (add contacts to the campaign's list)." }, { status: 400 });

  // Do-not-call enforcement (S2 canonical form). Fail closed: an unreadable
  // registry refuses the whole batch, and numbers that don't canonicalize are
  // dropped as undialable.
  const canonicals = raw.map((n) => canonicalPhone(n)).filter(Boolean);
  const { data: dncRows, error: dncErr } = await supabase
    .from("voice_dnc").select("phone").eq("workspace_id", ws).in("phone", canonicals.length ? canonicals : ["-"]);
  if (dncErr) return NextResponse.json({ ok: false, error: "Do-not-call registry unreadable — no calls placed (fail closed)." }, { status: 503 });
  const dnc = new Set((dncRows ?? []).map((r) => String(r.phone)));
  const list = raw.filter((n) => {
    const c = canonicalPhone(n);
    return !!c && !dnc.has(c);
  });
  const skipped = raw.length - list.length;
  if (list.length === 0) return NextResponse.json({ ok: false, error: "All numbers were skipped (do-not-call or invalid).", skipped }, { status: 400 });

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
    skipped,
    message: `Started ${started} of ${targets.length} call${targets.length === 1 ? "" : "s"}.${skipped ? ` (${skipped} skipped: do-not-call or invalid.)` : ""}${list.length > MAX ? ` (Capped at ${MAX} per run.)` : ""}`,
    errors: errors.slice(0, 5),
  });
}
