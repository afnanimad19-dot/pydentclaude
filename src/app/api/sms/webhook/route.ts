import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { generateAgentReply, generateAgentReplyWithTools } from "@/lib/agent-reply";
import { getSlots, bookAppointment, rescheduleAppt, cancelAppt, type BookingCtx } from "@/lib/booking-server";
import { sendSms } from "@/lib/sms-send";

// Twilio inbound SMS webhook. Set this URL as the Twilio number's "A message comes
// in" webhook (POST). Lands the text in the Omnichannel Inbox as an `sms`
// conversation AND auto-replies with the clinic's SMS agent (bookings included),
// just like WhatsApp. Twilio sends application/x-www-form-urlencoded.
export const runtime = "nodejs";

/* eslint-disable @typescript-eslint/no-explicit-any */
const TWIML_OK = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

async function firstWorkspace(): Promise<string | null> {
  const { data } = await supabase.from("workspaces").select("id").order("created_at").limit(1).maybeSingle();
  return data?.id ?? null;
}

// Generate + send the SMS agent's reply for one inbound message.
async function autoReply(ws: string, conversationId: string, from: string, name: string, patientId: string | null) {
  // Which agent answers SMS: the conversation's assigned agent, else the SMS channel default.
  const { data: convo } = await supabase.from("wa_conversations").select("assigned_agent_id").eq("id", conversationId).maybeSingle();
  let agentId: string | null = convo?.assigned_agent_id ?? null;
  if (!agentId) {
    const { data: def } = await supabase.from("channel_defaults").select("agent_id, enabled").eq("workspace_id", ws).eq("channel", "sms").maybeSingle();
    if (def?.enabled && def.agent_id) agentId = def.agent_id;
  }
  if (!agentId) return; // no SMS agent turned on — leave it for the front desk

  const { data: agent } = await supabase.from("agents").select("*").eq("id", agentId).maybeSingle();
  if (!agent || agent.status === "Paused") return;

  const { data: historyRows } = await supabase.from("wa_messages").select("direction, body, created_at").eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(20);
  const history = (historyRows ?? []).slice().reverse();

  let apptContext = "";
  if (patientId) {
    const { data: ap } = await supabase.from("appointments").select("date, time, procedure").eq("workspace_id", ws).eq("patient_id", patientId).gte("date", new Date().toISOString().slice(0, 10)).neq("status", "Broken").order("date").order("time").limit(1).maybeSingle();
    if (ap) apptContext = ` Existing upcoming appointment: ${ap.procedure} on ${ap.date} at ${ap.time}.`;
  }

  const replyInput = {
    model: agent.model ?? "openai/gpt-4o-mini",
    agentName: agent.name,
    agentIdentity: agent.agent_identity ?? "",
    instructions: agent.instructions ?? "",
    behavior: agent.behavior ?? "",
    knowledgeBase: agent.knowledge_base ?? "",
    capabilities: { canBook: agent.can_book, canReschedule: agent.can_reschedule, canCancel: agent.can_cancel },
    patientContext: `Contact name: ${name}. Contact phone: ${from}.${apptContext} Keep replies short — this is SMS.`,
    sessionNote: "",
    messages: history.map((h: any) => ({ role: h.direction === "inbound" ? ("user" as const) : ("assistant" as const), content: h.body })),
  };

  const bookingCtx: BookingCtx = { ws, patientId, name, phone: from, source: "sms", bookedBy: agent.name };
  const executeTool = async (toolName: string, args: any): Promise<string> => {
    if (toolName === "get_available_slots") return getSlots(ws, args);
    if (toolName === "book_appointment") return bookAppointment(bookingCtx, args);
    if (toolName === "reschedule_appointment") return rescheduleAppt(bookingCtx, args);
    if (toolName === "cancel_appointment") return cancelAppt(bookingCtx, args);
    return "Unsupported tool.";
  };

  const useTools = agent.can_book || agent.can_reschedule || agent.can_cancel;
  const result = useTools ? await generateAgentReplyWithTools(replyInput, executeTool) : await generateAgentReply(replyInput);
  if (result.error || !result.reply) return;

  const sent = await sendSms({ to: from, body: result.reply, ws });
  if (!sent.startsWith("SMS sent")) return; // don't store an undelivered reply

  await supabase.from("wa_messages").insert({ workspace_id: ws, conversation_id: conversationId, direction: "outbound", author: `${agent.name} (AI)`, body: result.reply });
  await supabase.from("wa_conversations").update({ last_message: result.reply, last_time: new Date().toISOString() }).eq("id", conversationId);
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
    const { data: convo } = await supabase.from("wa_conversations").select("id, unread, patient_id").eq("workspace_id", ws).eq("contact_phone", from).eq("channel", "sms").maybeSingle();
    let conversationId = convo?.id as string | undefined;
    let patientId: string | null = convo?.patient_id ?? null;
    if (conversationId) {
      await supabase.from("wa_conversations").update({ last_message: body, last_time: new Date().toISOString(), unread: (convo?.unread ?? 0) + 1 }).eq("id", conversationId);
    } else {
      const { data: created } = await supabase.from("patients").insert({ workspace_id: ws, name: from, phone: from, status: "New", source_channel: "sms", source_agent: "SMS inbox" }).select("id").single();
      patientId = created?.id ?? null;
      const { data: c } = await supabase.from("wa_conversations").insert({ workspace_id: ws, contact_phone: from, channel: "sms", contact_name: from, last_message: body, last_time: new Date().toISOString(), unread: 1, patient_id: patientId }).select("id").single();
      conversationId = c?.id;
    }
    if (conversationId) {
      await supabase.from("wa_messages").insert({ workspace_id: ws, conversation_id: conversationId, direction: "inbound", author: from, body, wa_message_id: mid });
      // Auto-reply with the SMS agent (best-effort — never block the 200 to Twilio).
      if (ws) { try { await autoReply(ws, conversationId, from, from, patientId); } catch { /* ignore */ } }
    }
  } catch {
    /* always 200 so Twilio doesn't retry forever */
  }
  return new NextResponse(TWIML_OK, { headers: { "Content-Type": "text/xml" } });
}
