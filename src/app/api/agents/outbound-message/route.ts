import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { sendWhatsAppText } from "@/lib/wa-send";

// Phoenix outbound messaging: send an opening WhatsApp message to a list of
// contacts and ASSIGN each conversation to the outbound agent, so when the
// contact replies the normal inbound webhook lets that agent carry the chat.
// Body: { ws, agentId, numbers[], message }.
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
  const { ws, agentId, numbers, message } = await req.json().catch(() => ({}));
  if (!ws || !agentId) return NextResponse.json({ ok: false, error: "ws and agentId are required." }, { status: 400 });
  const text = String(message ?? "").trim();
  if (!text) return NextResponse.json({ ok: false, error: "Write the opening message." }, { status: 400 });
  const list: string[] = Array.isArray(numbers) ? numbers.map((n) => digits(String(n))).filter((n) => n.length >= 7) : [];
  if (!list.length) return NextResponse.json({ ok: false, error: "Add at least one valid phone number." }, { status: 400 });

  const { data: agent } = await supabase.from("agents").select("id, name").eq("id", agentId).maybeSingle();
  const agentName = agent?.name ?? "Phoenix";
  const creds = await waCredsForWorkspace(String(ws));

  const MAX = 50;
  const targets = list.slice(0, MAX);
  let sent = 0;
  const errors: string[] = [];

  for (const number of targets) {
    const res = await sendWhatsAppText(number, text, creds);
    if (!res.ok) { errors.push(`${number}: ${res.error}`); continue; }
    sent++;
    // Upsert the conversation, assigned to this agent so replies are auto-handled.
    try {
      const { data: convo } = await supabase.from("wa_conversations").select("id").eq("workspace_id", ws).eq("contact_phone", number).eq("channel", "whatsapp").maybeSingle();
      let conversationId = convo?.id as string | undefined;
      if (conversationId) {
        await supabase.from("wa_conversations").update({ assigned_agent_id: agentId, last_message: text, last_time: new Date().toISOString(), status: "open" }).eq("id", conversationId);
      } else {
        const { data: created } = await supabase.from("wa_conversations").insert({ workspace_id: ws, contact_phone: number, channel: "whatsapp", contact_name: number, last_message: text, last_time: new Date().toISOString(), unread: 0, assigned_agent_id: agentId }).select("id").single();
        conversationId = created?.id;
      }
      if (conversationId) {
        await supabase.from("wa_messages").insert({ workspace_id: ws, conversation_id: conversationId, direction: "outbound", author: `${agentName} (AI)`, by_bot: true, body: text, wa_message_id: res.id ?? null });
      }
    } catch { /* message sent; conversation bookkeeping best-effort */ }
  }

  return NextResponse.json({
    ok: sent > 0,
    sent,
    total: list.length,
    capped: list.length > MAX,
    message: sent > 0
      ? `Phoenix messaged ${sent} of ${targets.length} contact${targets.length === 1 ? "" : "s"}. Replies will be handled automatically.${list.length > MAX ? ` (Capped at ${MAX} per run.)` : ""}`
      : "No messages went out.",
    // WhatsApp only delivers free-form text inside a 24h window; cold outreach needs an approved template.
    hint: errors.length ? "WhatsApp blocks free-form messages to contacts who haven't messaged you in the last 24h — use an approved template for cold outreach, or reach them by SMS." : undefined,
    errors: errors.slice(0, 5),
  });
}
