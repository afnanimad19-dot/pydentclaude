import { supabase } from "@/lib/supabase";

// Sends a plain-text WhatsApp message via the Meta Cloud API, using the
// credentials the clinic saved on Settings → WhatsApp config.

const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v21.0";

export async function getWaCredentials(): Promise<{ phoneNumberId: string; accessToken: string } | null> {
  try {
    const { data } = await supabase.from("whatsapp_config").select("phone_number_id, access_token").eq("workspace", "default").maybeSingle();
    if (!data?.phone_number_id || !data?.access_token) return null;
    return { phoneNumberId: data.phone_number_id, accessToken: data.access_token };
  } catch {
    return null;
  }
}

export async function sendWhatsAppText(to: string, body: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const creds = await getWaCredentials();
  if (!creds) return { ok: false, error: "WhatsApp is not connected (missing Phone Number ID / Access Token)." };

  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${creds.phoneNumberId}/messages`, {
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
