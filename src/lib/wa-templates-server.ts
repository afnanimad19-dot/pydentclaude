import { supabase } from "@/lib/supabase";
import { getWaCredentialsFull, graphUrl } from "@/lib/wa-send";

// Maps the friendly language names used in the template builder to Meta's
// language codes. Falls back to US English.
const LANG_CODES: Record<string, string> = {
  English: "en_US",
  "English + Spanish": "en_US",
  Spanish: "es",
  Arabic: "ar",
  French: "fr",
  Portuguese: "pt_BR",
  German: "de",
  Italian: "it",
  Dutch: "nl",
  Hindi: "hi",
  Urdu: "ur",
  Turkish: "tr",
  Russian: "ru",
  Indonesian: "id",
};

export function langCode(language: string): string {
  return LANG_CODES[language] ?? "en_US";
}

function paramCount(body: string): number {
  const m = body.match(/\{\{\s*\d+\s*\}\}/g);
  return m ? m.length : 0;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// Submit one template (read from the DB) to Meta for approval.
export async function submitTemplate(templateId: string): Promise<{ ok: boolean; error?: string }> {
  const creds = await getWaCredentialsFull();
  if (!creds || !creds.wabaId) return { ok: false, error: "Connect WhatsApp (with a Business Account ID) first." };

  const { data: t } = await supabase.from("wa_templates").select("*").eq("id", templateId).maybeSingle();
  if (!t) return { ok: false, error: "Template not found." };

  const components: any[] = [];
  if (t.header_type === "text" && t.header_text) components.push({ type: "HEADER", format: "TEXT", text: t.header_text });

  const body: any = { type: "BODY", text: t.body };
  const n = paramCount(t.body);
  if (n > 0) body.example = { body_text: [Array.from({ length: n }, (_, i) => `Sample ${i + 1}`)] };
  components.push(body);

  if (t.footer) components.push({ type: "FOOTER", text: t.footer });

  const buttons = (t.buttons ?? []).map((b: any) => {
    if (b.type === "url") return { type: "URL", text: b.text, url: b.value };
    if (b.type === "phone") return { type: "PHONE_NUMBER", text: b.text, phone_number: b.value };
    return { type: "QUICK_REPLY", text: b.text };
  });
  if (buttons.length) components.push({ type: "BUTTONS", buttons });

  try {
    const res = await fetch(graphUrl(`${creds.wabaId}/message_templates`), {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: t.name, language: langCode(t.language), category: t.category, components }),
    });
    const data = await res.json();
    if (!res.ok) {
      await supabase.from("wa_templates").update({ status: "Rejected" }).eq("id", templateId);
      return { ok: false, error: data?.error?.error_user_msg || data?.error?.message || `Graph error ${res.status}` };
    }
    await supabase.from("wa_templates").update({ status: "Pending approval", meta_id: data?.id ?? null }).eq("id", templateId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "submit failed" };
  }
}

// Pull current approval status for every template from Meta and update the DB.
export async function syncTemplates(): Promise<{ ok: boolean; updated: number; error?: string }> {
  const creds = await getWaCredentialsFull();
  if (!creds || !creds.wabaId) return { ok: false, updated: 0, error: "Connect WhatsApp (with a Business Account ID) first." };

  try {
    const res = await fetch(graphUrl(`${creds.wabaId}/message_templates?fields=name,status&limit=200`), {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, updated: 0, error: data?.error?.message ?? `Graph error ${res.status}` };

    const map: Record<string, string> = { APPROVED: "Approved", PENDING: "Pending approval", IN_APPEAL: "Pending approval", REJECTED: "Rejected", PAUSED: "Approved", DISABLED: "Rejected" };
    let updated = 0;
    for (const tpl of data.data ?? []) {
      const status = map[tpl.status];
      if (!status) continue;
      const { error } = await supabase.from("wa_templates").update({ status }).eq("name", tpl.name);
      if (!error) updated++;
    }
    return { ok: true, updated };
  } catch (e) {
    return { ok: false, updated: 0, error: e instanceof Error ? e.message : "sync failed" };
  }
}
