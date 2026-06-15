import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendWhatsAppText } from "@/lib/wa-send";

// Sends an agent/human reply from the inbox into a live WhatsApp conversation.
export async function POST(req: NextRequest) {
  const { conversationId, phone, text, author } = (await req.json()) as {
    conversationId?: string;
    phone?: string;
    text?: string;
    author?: string;
  };
  if (!conversationId || !phone || !text?.trim()) {
    return NextResponse.json({ error: "conversationId, phone and text are required." }, { status: 400 });
  }

  const sent = await sendWhatsAppText(phone, text.trim());
  if (!sent.ok) return NextResponse.json({ error: sent.error }, { status: 502 });

  await supabase.from("wa_messages").insert({
    conversation_id: conversationId,
    direction: "outbound",
    author: author || "You",
    body: text.trim(),
    wa_message_id: sent.id ?? null,
  });
  await supabase.from("wa_conversations").update({ last_message: text.trim(), last_time: new Date().toISOString() }).eq("id", conversationId);

  return NextResponse.json({ ok: true });
}
