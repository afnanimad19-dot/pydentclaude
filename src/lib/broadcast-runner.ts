import { supabase } from "@/lib/supabase";
import { getWaCredentialsFull, sendWhatsAppTemplate } from "@/lib/wa-send";

/* eslint-disable @typescript-eslint/no-explicit-any */
function paramCount(body: string): number {
  const m = body.match(/\{\{\s*\d+\s*\}\}/g);
  return m ? m.length : 0;
}

// Resolve the audience for a broadcast: patients in its folder (or all), with a
// usable phone number.
export async function broadcastAudience(folderId: string | null): Promise<any[]> {
  let q = supabase.from("patients").select("id, name, phone");
  if (folderId) q = q.eq("folder_id", folderId);
  const { data } = await q;
  return (data ?? []).filter((p: any) => p.phone && String(p.phone).replace(/\D/g, "").length >= 7);
}

// Send an existing broadcast row to its audience via the Cloud API and record
// per-recipient results. Used by both "send now" and the scheduled cron.
export async function runBroadcast(broadcastId: string): Promise<{ ok: boolean; error?: string; sent?: number; failed?: number; recipients?: number }> {
  const { data: b } = await supabase.from("wa_broadcasts").select("*").eq("id", broadcastId).maybeSingle();
  if (!b) return { ok: false, error: "Broadcast not found." };

  const creds = await getWaCredentialsFull();
  if (!creds) {
    await supabase.from("wa_broadcasts").update({ status: "Failed" }).eq("id", broadcastId);
    return { ok: false, error: "WhatsApp is not connected." };
  }

  await supabase.from("wa_broadcasts").update({ status: "Sending" }).eq("id", broadcastId);

  const audience = await broadcastAudience(b.folder_id ?? null);
  const { data: tpl } = await supabase.from("wa_templates").select("body").eq("name", b.template_name).maybeSingle();
  const nParams = tpl ? paramCount(tpl.body ?? "") : 0;

  let sent = 0;
  let failed = 0;
  for (const p of audience) {
    const phone = String(p.phone).replace(/\D/g, "");
    const first = String(p.name ?? "").split(" ")[0] || "there";
    const params = Array.from({ length: nParams }, () => first);
    const r = await sendWhatsAppTemplate(creds, phone, b.template_name, b.language, params);
    if (r.ok) sent++;
    else failed++;
    await supabase.from("wa_broadcast_recipients").insert({
      broadcast_id: broadcastId,
      patient_id: p.id,
      phone,
      name: p.name ?? "",
      status: r.ok ? "sent" : "failed",
      error: r.error ?? "",
      wa_message_id: r.id ?? null,
    });
  }

  await supabase
    .from("wa_broadcasts")
    .update({ status: failed === audience.length && audience.length > 0 ? "Failed" : "Sent", sent, failed, recipients: audience.length, sent_at: new Date().toISOString() })
    .eq("id", broadcastId);

  return { ok: true, sent, failed, recipients: audience.length };
}

// Find every Scheduled broadcast whose time has arrived and send it.
export async function runDueBroadcasts(): Promise<{ ran: number; ids: string[] }> {
  const nowIso = new Date().toISOString();
  const { data: due } = await supabase
    .from("wa_broadcasts")
    .select("id")
    .eq("status", "Scheduled")
    .not("scheduled_for", "is", null)
    .lte("scheduled_for", nowIso);

  const ids: string[] = [];
  for (const b of due ?? []) {
    // Claim it first so a second cron tick can't double-send.
    const { data: claimed } = await supabase
      .from("wa_broadcasts")
      .update({ status: "Sending" })
      .eq("id", b.id)
      .eq("status", "Scheduled")
      .select("id");
    if (claimed && claimed.length) {
      ids.push(b.id);
      await runBroadcast(b.id);
    }
  }
  return { ran: ids.length, ids };
}
