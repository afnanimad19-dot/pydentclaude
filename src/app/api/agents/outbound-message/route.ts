import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { sendWhatsAppText, sendWhatsAppTemplate } from "@/lib/wa-send";
import { sendSms } from "@/lib/sms-send";

// Outbound messaging for a chat agent: message a list of contacts and ASSIGN
// each WhatsApp conversation to the agent, so replies are handled automatically.
// Channels:
//   whatsapp          — free-form text (only reaches people in the 24h window)
//   whatsapp_template — an approved template (works for cold, first contact)
//   sms               — Twilio SMS (works for cold, no window)
// Body: { ws, agentId, numbers[], channel, message?, templateName?,
//         templateLanguage?, templateParams? }.
export const runtime = "nodejs";
export const maxDuration = 120;

const digits = (s: string) => String(s ?? "").replace(/[^\d+]/g, "").replace(/^\+/, "");

async function waCredsForWorkspace(ws: string): Promise<{ phoneNumberId: string; accessToken: string } | undefined> {
  try {
    const { data } = await supabase.from("whatsapp_config").select("phone_number_id, access_token").eq("workspace", ws).maybeSingle();
    if (data?.phone_number_id && data?.access_token) return { phoneNumberId: data.phone_number_id, accessToken: data.access_token };
  } catch { /* fall back to default creds */ }
  return undefined;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { ws, agentId, numbers } = body;
  const channel: string = ["whatsapp", "whatsapp_template", "sms"].includes(body.channel) ? body.channel : "whatsapp";
  if (!ws || !agentId) return NextResponse.json({ ok: false, error: "ws and agentId are required." }, { status: 400 });

  const text = String(body.message ?? "").trim();
  const templateName = String(body.templateName ?? "").trim();
  const templateLanguage = String(body.templateLanguage ?? "en").trim() || "en";
  const templateParams: string[] = Array.isArray(body.templateParams) ? body.templateParams.map(String) : [];
  if (channel === "whatsapp_template" ? !templateName : !text) {
    return NextResponse.json({ ok: false, error: channel === "whatsapp_template" ? "Pick an approved template." : "Write the opening message." }, { status: 400 });
  }

  const list: string[] = Array.isArray(numbers) ? numbers.map((n: unknown) => digits(String(n))).filter((n) => n.length >= 7) : [];
  if (!list.length) return NextResponse.json({ ok: false, error: "Add at least one valid phone number." }, { status: 400 });

  const { data: agent } = await supabase.from("agents").select("id, name").eq("id", agentId).maybeSingle();
  const agentName = agent?.name ?? "Agent";
  const creds = channel === "sms" ? undefined : await waCredsForWorkspace(String(ws));

  // Assign the WhatsApp conversation to this agent so replies are auto-handled.
  async function assign(number: string, preview: string, wamid: string | null) {
    try {
      const { data: convo } = await supabase.from("wa_conversations").select("id").eq("workspace_id", ws).eq("contact_phone", number).eq("channel", "whatsapp").maybeSingle();
      let id = convo?.id as string | undefined;
      if (id) await supabase.from("wa_conversations").update({ assigned_agent_id: agentId, last_message: preview, last_time: new Date().toISOString(), status: "open" }).eq("id", id);
      else id = (await supabase.from("wa_conversations").insert({ workspace_id: ws, contact_phone: number, channel: "whatsapp", contact_name: number, last_message: preview, last_time: new Date().toISOString(), unread: 0, assigned_agent_id: agentId }).select("id").single()).data?.id;
      if (id) await supabase.from("wa_messages").insert({ workspace_id: ws, conversation_id: id, direction: "outbound", author: `${agentName} (AI)`, by_bot: true, body: preview, wa_message_id: wamid });
    } catch { /* sent; bookkeeping best-effort */ }
  }

  const MAX = 50;
  const targets = list.slice(0, MAX);
  let sent = 0;
  const errors: string[] = [];

  for (const number of targets) {
    if (channel === "sms") {
      const r = await sendSms({ to: `+${number}`, body: text, ws: String(ws) });
      if (r.startsWith("SMS sent")) sent++; else errors.push(`${number}: ${r}`);
      continue;
    }
    let res: { ok: boolean; id?: string; error?: string };
    let preview = text;
    if (channel === "whatsapp_template") {
      if (!creds) { errors.push(`${number}: WhatsApp not connected`); continue; }
      res = await sendWhatsAppTemplate(creds, number, templateName, templateLanguage, templateParams);
      preview = `[template: ${templateName}]`;
    } else {
      res = await sendWhatsAppText(number, text, creds);
    }
    if (!res.ok) { errors.push(`${number}: ${res.error}`); continue; }
    sent++;
    await assign(number, preview, res.id ?? null);
  }

  const cold = channel !== "whatsapp";
  return NextResponse.json({
    ok: sent > 0,
    sent,
    total: list.length,
    capped: list.length > MAX,
    message: sent > 0
      ? `${agentName} reached ${sent} of ${targets.length} contact${targets.length === 1 ? "" : "s"} via ${channel === "sms" ? "SMS" : channel === "whatsapp_template" ? "WhatsApp template" : "WhatsApp"}.${channel !== "sms" ? " Replies will be handled automatically." : ""}${list.length > MAX ? ` (Capped at ${MAX} per run.)` : ""}`
      : "No messages went out.",
    hint: !cold && errors.length ? "WhatsApp blocks free-form messages to contacts who haven't messaged you in the last 24h — use an approved template or SMS for cold outreach." : undefined,
    errors: errors.slice(0, 5),
  });
}
