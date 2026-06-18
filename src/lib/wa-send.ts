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

// Messenger / Instagram credentials (a Facebook Page access token + ids).
export async function getPageCreds(): Promise<{ pageToken: string; pageId: string; igId: string } | null> {
  try {
    const { data } = await supabase.from("whatsapp_config").select("page_access_token, page_id, ig_id").eq("workspace", "default").maybeSingle();
    if (!data?.page_access_token) return null;
    return { pageToken: data.page_access_token, pageId: data.page_id ?? "", igId: data.ig_id ?? "" };
  } catch {
    return null;
  }
}

// Send a text via the Messenger Platform Send API (works for both Facebook
// Messenger and Instagram DMs once the Page is linked to the IG account).
export async function sendMessengerText(recipientId: string, text: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const creds = await getPageCreds();
  if (!creds) return { ok: false, error: "Facebook/Instagram not connected (missing Page access token)." };
  try {
    const res = await fetch(graphUrl(`me/messages?access_token=${encodeURIComponent(creds.pageToken)}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: recipientId }, messaging_type: "RESPONSE", message: { text } }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data?.error?.message ?? `Graph error ${res.status}` };
    return { ok: true, id: data?.message_id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "send failed" };
  }
}

// Best-effort display name for a Messenger/Instagram sender.
export async function fetchMetaUserName(userId: string): Promise<string | null> {
  const creds = await getPageCreds();
  if (!creds) return null;
  try {
    const res = await fetch(graphUrl(`${userId}?fields=name,username&access_token=${encodeURIComponent(creds.pageToken)}`));
    if (!res.ok) return null;
    const data = await res.json();
    return data?.name ?? data?.username ?? null;
  } catch {
    return null;
  }
}

// Routes an outbound message to the right API based on the conversation channel.
export async function sendByChannel(channel: string, contactId: string, text: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (channel === "messenger" || channel === "instagram") return sendMessengerText(contactId, text);
  return sendWhatsAppText(contactId, text);
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
