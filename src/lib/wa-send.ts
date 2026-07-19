import { supabaseAdmin as supabase } from "@/lib/supabase-admin";

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
    const { data } = await supabase.from("whatsapp_config").select("phone_number_id, access_token, waba_id").not("phone_number_id","is",null).limit(1).maybeSingle();
    if (!data?.phone_number_id || !data?.access_token) return null;
    return { phoneNumberId: data.phone_number_id, accessToken: data.access_token, wabaId: data.waba_id ?? "" };
  } catch {
    return null;
  }
}

// Resolve the WhatsApp credentials for the number that received a message — this
// guarantees we reply from the right clinic's account (multi-tenant safe).
export async function getWaCredsByPhoneId(phoneNumberId: string): Promise<{ phoneNumberId: string; accessToken: string; workspace: string | null } | null> {
  try {
    const { data } = await supabase.from("whatsapp_config").select("phone_number_id, access_token, workspace").eq("phone_number_id", phoneNumberId).limit(1).maybeSingle();
    if (!data?.access_token) return null;
    return { phoneNumberId: data.phone_number_id, accessToken: data.access_token, workspace: data.workspace ?? null };
  } catch {
    return null;
  }
}

export async function getPageCredsByPageId(pageId: string): Promise<{ pageToken: string; workspace: string | null } | null> {
  try {
    const { data } = await supabase.from("whatsapp_config").select("page_access_token, workspace").eq("page_id", pageId).not("page_access_token", "is", null).limit(1).maybeSingle();
    if (!data?.page_access_token) return null;
    return { pageToken: data.page_access_token, workspace: data.workspace ?? null };
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
    const { data } = await supabase.from("whatsapp_config").select("page_access_token, page_id, ig_id").not("page_access_token","is",null).limit(1).maybeSingle();
    if (!data?.page_access_token) return null;
    return { pageToken: data.page_access_token, pageId: data.page_id ?? "", igId: data.ig_id ?? "" };
  } catch {
    return null;
  }
}

// Send a text via the Messenger Platform Send API (works for both Facebook
// Messenger and Instagram DMs once the Page is linked to the IG account).
export async function sendMessengerText(recipientId: string, text: string, pageToken?: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const token = pageToken ?? (await getPageCreds())?.pageToken;
  if (!token) return { ok: false, error: "Facebook/Instagram not connected (missing Page access token)." };
  try {
    const res = await fetch(graphUrl(`me/messages?access_token=${encodeURIComponent(token)}`), {
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
// Optional explicit creds reply from the exact account that received the message.
export async function sendByChannel(
  channel: string,
  contactId: string,
  text: string,
  creds?: { wa?: { phoneNumberId: string; accessToken: string }; pageToken?: string }
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (channel === "messenger" || channel === "instagram") return sendMessengerText(contactId, text, creds?.pageToken);
  return sendWhatsAppText(contactId, text, creds?.wa);
}

export async function sendWhatsAppText(to: string, body: string, override?: { phoneNumberId: string; accessToken: string }): Promise<{ ok: boolean; id?: string; error?: string }> {
  const creds = override ?? (await getWaCredentials());
  if (!creds) return { ok: false, error: "WhatsApp is not connected (missing Phone Number ID / Access Token)." };

  try {
    const res = await fetch(graphUrl(`${creds.phoneNumberId}/messages`), {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
    });
    const data = await res.json();
    if (!res.ok) {
      const err = data?.error ?? {};
      // Include Meta's numeric code + details — the webhook uses these to tell
      // the clinic exactly why a reply to a NEW number was rejected (e.g. the
      // number isn't on a test app's allowed-recipients list, or the app is
      // still in Development mode).
      const code = err.code ?? err.error_subcode;
      const detail = err.error_data?.details;
      const parts = [err.message, code != null ? `#${code}` : "", detail].filter(Boolean);
      return { ok: false, error: parts.length ? parts.join(" ") : `Graph error ${res.status}` };
    }
    return { ok: true, id: data?.messages?.[0]?.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "send failed" };
  }
}

// Upload audio (or any media) to the clinic's WhatsApp account; returns a media id.
export async function uploadWhatsAppMedia(
  creds: { phoneNumberId: string; accessToken: string },
  bytes: Buffer,
  mime: string,
  filename = "voice.mp3"
): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const fd = new FormData();
    fd.append("messaging_product", "whatsapp");
    fd.append("type", mime);
    fd.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    const res = await fetch(graphUrl(`${creds.phoneNumberId}/media`), {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.accessToken}` },
      body: fd,
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data?.error?.message ?? `Graph error ${res.status}` };
    return { ok: true, id: data?.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "media upload failed" };
  }
}

// Send a previously-uploaded audio media id as a WhatsApp audio message (voice note).
export async function sendWhatsAppAudio(
  to: string,
  mediaId: string,
  creds: { phoneNumberId: string; accessToken: string }
): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const res = await fetch(graphUrl(`${creds.phoneNumberId}/messages`), {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "audio", audio: { id: mediaId } }),
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
