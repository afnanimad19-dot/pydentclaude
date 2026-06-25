import { createClient } from "@supabase/supabase-js";
import { broadcastAudience } from "@/lib/broadcast-runner";

// Data + actions for Angela (patient email & WhatsApp marketing): find patients
// due for recall, list approved WhatsApp templates, and schedule a broadcast into
// the existing broadcast system. Server-only.

function admin() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://mzqynjywncbvqfikbzgm.supabase.co";
  if (!serviceKey) return null;
  return createClient(supabaseUrl, serviceKey);
}

// Patients due for recall (flagged, or not seen in `months`+).
export async function getRecallPatients(ws: string, months = 6): Promise<string> {
  const db = admin();
  if (!db) return "Server not configured.";
  const { data } = await db.from("patients").select("name, phone, last_visit, recall_due, status").eq("workspace_id", ws).limit(500);
  if (!data?.length) return "No patients on file yet.";
  const cutoff = new Date(Date.now() - months * 30 * 86400000).toISOString().slice(0, 10);
  const due = data.filter((p) => p.recall_due || (p.last_visit && String(p.last_visit).slice(0, 10) < cutoff));
  if (!due.length) return `No patients are due for recall (none flagged or older than ${months} months).`;
  const list = due.slice(0, 25).map((p) => `  • ${p.name} — last visit ${p.last_visit ?? "—"}${p.phone ? ` · ${p.phone}` : ""}`).join("\n");
  return `${due.length} patient(s) due for recall:\n${list}${due.length > 25 ? `\n  …and ${due.length - 25} more` : ""}`;
}

// Approved WhatsApp templates (broadcasts must use an approved template).
export async function listTemplates(ws: string): Promise<string> {
  const db = admin();
  if (!db) return "Server not configured.";
  const { data } = await db.from("wa_templates").select("name, status, language, category").eq("workspace_id", ws);
  if (!data?.length) return "No WhatsApp templates yet. Create one in WhatsApp → Templates and submit it for approval.";
  const list = data.map((t) => `  • ${t.name} [${t.status}]${t.category ? ` · ${t.category}` : ""}${t.language ? ` · ${t.language}` : ""}`).join("\n");
  const approved = data.filter((t) => String(t.status).toUpperCase() === "APPROVED").length;
  return `Templates (${approved} approved):\n${list}\nNote: WhatsApp broadcasts can only use an APPROVED template.`;
}

// Schedule a broadcast to a folder (or everyone) using an approved template.
export async function scheduleBroadcast(
  ws: string,
  input: { name: string; templateName: string; folderId?: string; folderName?: string; scheduledFor?: string }
): Promise<string> {
  const db = admin();
  if (!db) return "Server not configured.";
  const { data: tpl } = await db.from("wa_templates").select("status, language").eq("workspace_id", ws).eq("name", input.templateName).maybeSingle();
  if (!tpl) return `Template "${input.templateName}" not found. Use list_whatsapp_templates to see options.`;
  if (String(tpl.status).toUpperCase() !== "APPROVED") return `Template "${input.templateName}" is ${tpl.status} — only APPROVED templates can be broadcast.`;
  const audience = await broadcastAudience(input.folderId ?? null, ws);
  const { data: bc, error } = await db
    .from("wa_broadcasts")
    .insert({
      workspace_id: ws,
      name: input.name,
      folder_id: input.folderId ?? null,
      folder_name: input.folderName ?? "",
      template_name: input.templateName,
      language: tpl.language ?? "en",
      status: "Scheduled",
      scheduled_for: input.scheduledFor ?? null,
      recipients: audience.length,
    })
    .select("id")
    .single();
  if (error) return `Could not schedule: ${error.message}`;
  return `Scheduled broadcast "${input.name}" using template "${input.templateName}" to ${audience.length} recipient(s). Review it in WhatsApp → Broadcasts. (id ${bc?.id})`;
}
