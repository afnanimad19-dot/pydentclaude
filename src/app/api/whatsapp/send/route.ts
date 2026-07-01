import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { sendByChannel } from "@/lib/wa-send";

// Sends an agent/human reply from the inbox into a live conversation, routing to
// the right API (WhatsApp Cloud API or Messenger/Instagram Send API) by channel.
export async function POST(req: NextRequest) {
  const { conversationId, text, author } = (await req.json()) as {
    conversationId?: string;
    text?: string;
    author?: string;
  };
  if (!conversationId || !text?.trim()) {
    return NextResponse.json({ error: "conversationId and text are required." }, { status: 400 });
  }

  const { data: convo } = await supabase.from("wa_conversations").select("channel, contact_phone, workspace_id").eq("id", conversationId).maybeSingle();
  if (!convo) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });

  const sent = await sendByChannel(convo.channel ?? "whatsapp", convo.contact_phone, text.trim());
  if (!sent.ok) return NextResponse.json({ error: sent.error }, { status: 502 });

  await supabase.from("wa_messages").insert({
    workspace_id: convo.workspace_id ?? null,
    conversation_id: conversationId,
    direction: "outbound",
    author: author || "You",
    body: text.trim(),
    wa_message_id: sent.id ?? null,
  });
  await supabase.from("wa_conversations").update({ last_message: text.trim(), last_time: new Date().toISOString() }).eq("id", conversationId);

  return NextResponse.json({ ok: true });
}
