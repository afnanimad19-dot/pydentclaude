import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { runMessageBroadcast } from "@/lib/message-broadcast-runner";

// Create a native Email/SMS broadcast to a contact folder and either send it now
// or schedule it. Body: { ws, name, channel, folderId, folderName, subject, body, sendNow, scheduledFor }.
export const runtime = "nodejs";
export const maxDuration = 300;

function admin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://mzqynjywncbvqfikbzgm.supabase.co";
  return key ? createClient(url, key) : null;
}

export async function POST(req: NextRequest) {
  const db = admin();
  if (!db) return NextResponse.json({ ok: false, error: "Server not configured (SUPABASE_SERVICE_ROLE_KEY)." }, { status: 503 });

  const b = await req.json().catch(() => ({}));
  const ws = b.ws;
  const channel = b.channel === "sms" ? "sms" : "email";
  if (!ws) return NextResponse.json({ ok: false, error: "Missing workspace." }, { status: 400 });
  if (!b.name?.trim()) return NextResponse.json({ ok: false, error: "Name your broadcast." }, { status: 400 });
  if (channel === "email" && !b.subject?.trim()) return NextResponse.json({ ok: false, error: "Add a subject line." }, { status: 400 });
  if (!b.body?.trim()) return NextResponse.json({ ok: false, error: "Write the message." }, { status: 400 });

  const row = {
    workspace_id: ws,
    name: String(b.name).trim(),
    channel,
    folder_id: b.folderId || null,
    folder_name: b.folderName || "",
    subject: b.subject || "",
    body: b.body,
    status: b.sendNow ? "Sending" : "Scheduled",
    scheduled_for: !b.sendNow ? (b.scheduledFor || null) : null,
  };

  const { data: created, error } = await db.from("message_broadcasts").insert(row).select("id").single();
  if (error || !created) return NextResponse.json({ ok: false, error: error?.message ?? "Could not create the broadcast." }, { status: 500 });

  if (b.sendNow) {
    const res = await runMessageBroadcast(created.id);
    if (!res.ok) return NextResponse.json({ ok: false, id: created.id, error: res.error ?? "Send failed." }, { status: 502 });
    return NextResponse.json({ ok: true, id: created.id, sent: res.sent, failed: res.failed, recipients: res.recipients });
  }
  return NextResponse.json({ ok: true, id: created.id, scheduled: true });
}
