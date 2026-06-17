import { supabase } from "@/lib/supabase";

// Sends a plain-text WhatsApp message via the Meta Cloud API, using the
// credentials the clinic saved on Settings → WhatsApp config.

const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v21.0";

export interface WaCreds {
  phoneNumberId: string;
  accessToken: string;
  wabaId: string;
}

export async function getWaCredentials(): Promise<{ phoneNumberId: string; accessToken: string } | null> {
  const full = await getWaCredentialsFull();
  if (!full) return null;
  return { phoneNumberId: full.phoneNumberId, accessToken: full.accessToken };
}

export async function getWaCredentialsFull(): Promise<WaCreds | null> {
  try {
    const { data } = await supabase.from("whatsapp_config").select("phone_number_id, access_token, waba_id").eq("workspace", "default").maybeSingle();
    if (!data?.phone_number_id || !data?.access_token) return null;
    return { phoneNumberId: data.phone_number_id, accessToken: data.access_token, wabaId: data.waba_id ?? "" };
  } catch {
    return null;
  }
}

export function graphUrl(path: string) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${path}`;
}

export async function sendWhatsAppText(to: string, body: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const creds = await getWaCredentials();
  if (!creds) return { ok: false, error: "WhatsApp is not connected (missing Phone Number ID / Access Token)." };

  try {
    const res = await fetch(graphUrl(`${creds.phoneNumberId}/messages`), {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data?.error?.message ?? `Graph error ${res.status}` };
    return { ok: true, id: data?.messages?.[0]?.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "send failed" };
  }
}

// Sends an approved template message. `bodyParams` fills the {{1}},{{2}}… body
// variables in order. Uses the provided credentials to avoid refetching per send.
export async function sendWhatsAppTemplate(
  creds: { phoneNumberId: string; accessToken: string },
  to: string,
  templateName: string,
  languageCode: string,
  bodyParams: string[]
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const components = bodyParams.length
    ? [{ type: "body", parameters: bodyParams.map((p) => ({ type: "text", text: p })) }]
    : [];
  try {
    const res = await fetch(graphUrl(`${creds.phoneNumberId}/messages`), {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: { name: templateName, language: { code: languageCode }, ...(components.length ? { components } : {}) },
      }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data?.error?.message ?? `Graph error ${res.status}` };
    return { ok: true, id: data?.messages?.[0]?.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "send failed" };
  }
}
