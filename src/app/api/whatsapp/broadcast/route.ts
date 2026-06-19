import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { langCode } from "@/lib/wa-templates-server";
import { runBroadcast, broadcastAudience } from "@/lib/broadcast-runner";

export async function POST(req: NextRequest) {
  const { name, folderId, folderName, templateName, language, sendNow, scheduledFor, workspaceId } = (await req.json()) as {
    name?: string;
    folderId?: string;
    folderName?: string;
    templateName?: string;
    language?: string;
    sendNow?: boolean;
    scheduledFor?: string;
    workspaceId?: string;
  };

  if (!name?.trim() || !templateName) {
    return NextResponse.json({ error: "Campaign name and template are required." }, { status: 400 });
  }
  const ws = workspaceId ?? null;

  const { data: tpl } = await supabase.from("wa_templates").select("language").eq("name", templateName).maybeSingle();
  const code = langCode(language || tpl?.language || "English");

  // Scheduled: store as Scheduled with the audience size; the cron sends it later.
  if (!sendNow) {
    const audience = await broadcastAudience(folderId ?? null, ws);
    const { data: bc, error } = await supabase
      .from("wa_broadcasts")
      .insert({ workspace_id: ws, name: name.trim(), folder_id: folderId ?? null, folder_name: folderName ?? "", template_name: templateName, language: code, status: "Scheduled", scheduled_for: scheduledFor ?? null, recipients: audience.length })
      .select("id")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, id: bc?.id, scheduled: true, recipients: audience.length });
  }

  // Send now.
  const { data: bc, error: bcErr } = await supabase
    .from("wa_broadcasts")
    .insert({ workspace_id: ws, name: name.trim(), folder_id: folderId ?? null, folder_name: folderName ?? "", template_name: templateName, language: code, status: "Sending" })
    .select("id")
    .single();
  if (bcErr) return NextResponse.json({ error: bcErr.message }, { status: 500 });

  const res = await runBroadcast(bc!.id);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 502 });
  return NextResponse.json({ ok: true, id: bc!.id, sent: res.sent, failed: res.failed, recipients: res.recipients });
}
