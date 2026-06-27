import { NextRequest, NextResponse } from "next/server";
import { sendEmail } from "@/lib/email-send";

// Send an email from the dashboard composer. Sends via the clinic's connected
// Gmail (Google OAuth) or Brevo if configured. Body: { workspaceId, to, subject, html }.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: { workspaceId?: string; to?: string; subject?: string; html?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Bad request." }, { status: 400 });
  }
  const to = (body.to || "").trim();
  if (!to || !/.+@.+\..+/.test(to)) return NextResponse.json({ ok: false, message: "Enter a valid recipient email." }, { status: 400 });

  const result = await sendEmail({
    to,
    subject: (body.subject || "(no subject)").trim(),
    html: body.html || "",
    ws: body.workspaceId,
  });
  const ok = result.startsWith("Email sent");
  return NextResponse.json({ ok, message: result }, { status: ok ? 200 : 502 });
}
