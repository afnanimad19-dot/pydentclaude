import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getWaCredentialsFull, sendWhatsAppTemplate } from "@/lib/wa-send";
import { langCode } from "@/lib/wa-templates-server";

/* eslint-disable @typescript-eslint/no-explicit-any */
function paramCount(body: string): number {
  const m = body.match(/\{\{\s*\d+\s*\}\}/g);
  return m ? m.length : 0;
}

export async function POST(req: NextRequest) {
  const { name, folderId, folderName, templateName, language, sendNow, scheduledFor } = (await req.json()) as {
    name?: string;
    folderId?: string;
    folderName?: string;
    templateName?: string;
    language?: string;
    sendNow?: boolean;
    scheduledFor?: string;
  };

  if (!name?.trim() || !templateName) {
    return NextResponse.json({ error: "Campaign name and template are required." }, { status: 400 });
  }

  // Resolve the audience (patients in the chosen folder, or all if no folder).
  let q = supabase.from("patients").select("id, name, phone");
  if (folderId) q = q.eq("folder_id", folderId);
  const { data: rawPatients } = await q;
  const audience = (rawPatients ?? []).filter((p: any) => p.phone && String(p.phone).replace(/\D/g, "").length >= 7);

  // Template body → how many {{n}} parameters to fill.
  const { data: tpl } = await supabase.from("wa_templates").select("body, language").eq("name", templateName).maybeSingle();
  const nParams = tpl ? paramCount(tpl.body ?? "") : 0;
  const code = langCode(language || tpl?.language || "English");

  // Scheduled (no cron yet): store as Scheduled, don't send.
  if (!sendNow) {
    const { data: bc, error } = await supabase
      .from("wa_broadcasts")
      .insert({ name: name.trim(), folder_id: folderId ?? null, folder_name: folderName ?? "", template_name: templateName, language: code, status: "Scheduled", scheduled_for: scheduledFor ?? null, recipients: audience.length })
      .select("id")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, id: bc?.id, scheduled: true, recipients: audience.length });
  }

  const creds = await getWaCredentialsFull();
  if (!creds) return NextResponse.json({ error: "WhatsApp is not connected." }, { status: 400 });

  const { data: bc, error: bcErr } = await supabase
    .from("wa_broadcasts")
    .insert({ name: name.trim(), folder_id: folderId ?? null, folder_name: folderName ?? "", template_name: templateName, language: code, status: "Sending", recipients: audience.length })
    .select("id")
    .single();
  if (bcErr) return NextResponse.json({ error: bcErr.message }, { status: 500 });
  const broadcastId = bc!.id;

  let sent = 0;
  let failed = 0;
  for (const p of audience) {
    const phone = String(p.phone).replace(/\D/g, "");
    const first = String(p.name ?? "").split(" ")[0] || "there";
    const params = Array.from({ length: nParams }, () => first);
    const r = await sendWhatsAppTemplate(creds, phone, templateName, code, params);
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
    .update({ status: failed === audience.length && audience.length > 0 ? "Failed" : "Sent", sent, failed, sent_at: new Date().toISOString() })
    .eq("id", broadcastId);

  return NextResponse.json({ ok: true, id: broadcastId, sent, failed, recipients: audience.length });
}
