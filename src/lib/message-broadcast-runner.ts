import { createClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email-send";
import { sendSms } from "@/lib/sms-send";

// Sends a native Email or SMS broadcast to the contacts in a folder (or all
// contacts) — via the clinic's connected Gmail/Brevo (email) or Twilio (SMS).
// Records a per-recipient result. Used by "send now" and the scheduled cron.

/* eslint-disable @typescript-eslint/no-explicit-any */
function admin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://mzqynjywncbvqfikbzgm.supabase.co";
  return key ? createClient(url, key) : null;
}

const emailRe = /.+@.+\..+/;
const hasPhone = (s: string) => String(s).replace(/\D/g, "").length >= 7;

// Contacts in a folder (or everyone) with a usable email/phone for the channel.
async function audience(db: any, ws: string, channel: "email" | "sms", folderId: string | null): Promise<{ id: string; name: string; contact: string }[]> {
  let q = db.from("patients").select("id, name, email, phone").eq("workspace_id", ws);
  if (folderId) q = q.eq("folder_id", folderId);
  const { data } = await q;
  return (data ?? [])
    .map((p: any) => ({ id: p.id, name: p.name ?? "", contact: channel === "email" ? (p.email ?? "").trim() : (p.phone ?? "").trim() }))
    .filter((p: any) => (channel === "email" ? emailRe.test(p.contact) : hasPhone(p.contact)));
}

function render(text: string, name: string): string {
  const first = String(name || "").split(" ")[0] || "there";
  return String(text || "").replace(/\{\{\s*(first_name|name)\s*\}\}/gi, (_, k) => (k.toLowerCase() === "name" ? name || first : first));
}

export async function runMessageBroadcast(broadcastId: string): Promise<{ ok: boolean; error?: string; sent?: number; failed?: number; recipients?: number }> {
  const db = admin();
  if (!db) return { ok: false, error: "Server not configured (SUPABASE_SERVICE_ROLE_KEY)." };

  const { data: b } = await db.from("message_broadcasts").select("*").eq("id", broadcastId).maybeSingle();
  if (!b) return { ok: false, error: "Broadcast not found." };
  const ws = b.workspace_id;
  const channel: "email" | "sms" = b.channel === "sms" ? "sms" : "email";

  await db.from("message_broadcasts").update({ status: "Sending" }).eq("id", broadcastId);

  const list = await audience(db, ws, channel, b.folder_id ?? null);
  let sent = 0, failed = 0;
  for (const p of list) {
    let ok = false, error = "";
    try {
      if (channel === "email") {
        const html = `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2937">${render(b.body, p.name).replace(/\n/g, "<br>")}</div>`;
        const r = await sendEmail({ to: p.contact, subject: render(b.subject || "A message from your clinic", p.name), html, ws });
        ok = r.startsWith("Email sent"); error = ok ? "" : r;
      } else {
        const r = await sendSms({ to: p.contact, body: render(b.body, p.name), ws });
        ok = r.startsWith("SMS sent"); error = ok ? "" : r;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "send failed";
    }
    if (ok) sent++; else failed++;
    await db.from("message_broadcast_recipients").insert({ broadcast_id: broadcastId, workspace_id: ws, patient_id: p.id, contact: p.contact, name: p.name, status: ok ? "sent" : "failed", error: error.slice(0, 300) });
  }

  await db.from("message_broadcasts").update({
    status: failed === list.length && list.length > 0 ? "Failed" : "Sent",
    sent, failed, recipients: list.length, sent_at: new Date().toISOString(),
  }).eq("id", broadcastId);

  return { ok: sent > 0 || list.length === 0, sent, failed, recipients: list.length };
}

// Count the audience for a channel+folder (for the "N recipients" preview).
export async function messageAudienceCount(ws: string, channel: "email" | "sms", folderId: string | null): Promise<number> {
  const db = admin();
  if (!db) return 0;
  return (await audience(db, ws, channel, folderId)).length;
}

// Fire any scheduled broadcasts whose time has arrived (called by the cron).
export async function runDueMessageBroadcasts(): Promise<{ ran: number }> {
  const db = admin();
  if (!db) return { ran: 0 };
  const nowIso = new Date().toISOString();
  const { data: due } = await db.from("message_broadcasts").select("id").eq("status", "Scheduled").not("scheduled_for", "is", null).lte("scheduled_for", nowIso);
  let ran = 0;
  for (const b of due ?? []) {
    // Claim it so a second cron tick can't double-send.
    const { data: claimed } = await db.from("message_broadcasts").update({ status: "Sending" }).eq("id", b.id).eq("status", "Scheduled").select("id");
    if (claimed?.length) { await runMessageBroadcast(b.id); ran++; }
  }
  return { ran };
}
