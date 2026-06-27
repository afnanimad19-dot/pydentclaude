import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

// Twilio inbound SMS webhook. Set this URL as the Twilio number's "A message
// comes in" webhook (POST). Lands the text in the Omnichannel Inbox as an `sms`
// conversation. Twilio sends application/x-www-form-urlencoded.
export const runtime = "nodejs";

const TWIML_OK = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

async function firstWorkspace(): Promise<string | null> {
  const { data } = await supabase.from("workspaces").select("id").order("created_at").limit(1).maybeSingle();
  return data?.id ?? null;
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const from = String(form.get("From") ?? "");
    const body = String(form.get("Body") ?? "");
    const mid = String(form.get("MessageSid") ?? "");
    if (!from) return new NextResponse(TWIML_OK, { headers: { "Content-Type": "text/xml" } });

    const ws = await firstWorkspace();
    // Find or create the SMS conversation for this number.
    const { data: convo } = await supabase.from("wa_conversations").select("id, unread").eq("workspace_id", ws).eq("contact_phone", from).eq("channel", "sms").maybeSingle();
    let conversationId = convo?.id as string | undefined;
    if (conversationId) {
      await supabase.from("wa_conversations").update({ last_message: body, last_time: new Date().toISOString(), unread: (convo?.unread ?? 0) + 1 }).eq("id", conversationId);
    } else {
      // Capture the SMS lead as a contact too.
      let patientId: string | null = null;
      const { data: created } = await supabase.from("patients").insert({ workspace_id: ws, name: from, phone: from, status: "New", source_channel: "sms", source_agent: "SMS inbox" }).select("id").single();
      patientId = created?.id ?? null;
      const { data: c } = await supabase.from("wa_conversations").insert({ workspace_id: ws, contact_phone: from, channel: "sms", contact_name: from, last_message: body, last_time: new Date().toISOString(), unread: 1, patient_id: patientId }).select("id").single();
      conversationId = c?.id;
    }
    if (conversationId) {
      await supabase.from("wa_messages").insert({ conversation_id: conversationId, direction: "inbound", author: from, body, wa_message_id: mid });
    }
  } catch {
    /* always 200 so Twilio doesn't retry forever */
  }
  return new NextResponse(TWIML_OK, { headers: { "Content-Type": "text/xml" } });
}
