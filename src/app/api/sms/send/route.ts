import { NextRequest, NextResponse } from "next/server";
import { sendSms } from "@/lib/sms-send";

// Send an SMS from the dashboard composer. Body: { to, body }.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let payload: { to?: string; body?: string; ws?: string };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Bad request." }, { status: 400 });
  }
  const to = (payload.to || "").trim();
  if (!to) return NextResponse.json({ ok: false, message: "Enter a recipient number." }, { status: 400 });
  const result = await sendSms({ to, body: (payload.body || "").trim(), ws: payload.ws });
  const ok = result.startsWith("SMS sent");
  return NextResponse.json({ ok, message: result }, { status: ok ? 200 : 502 });
}
