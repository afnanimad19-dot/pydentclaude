import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { supabase } from "@/lib/supabase";
import { generateAgentReply } from "@/lib/agent-reply";
import { sendWhatsAppText } from "@/lib/wa-send";

// Meta calls this endpoint:
//  1. GET  — verification handshake when you save the webhook (echo hub.challenge).
//  2. POST — inbound messages / status updates. We store messages, surface them
//     in the Omnichannel Inbox, and (if an agent is set for WhatsApp in the Agent
//     Hub or on the conversation) auto-reply from the agent's knowledge base.

async function expectedVerifyToken(): Promise<string | null> {
  if (process.env.WHATSAPP_VERIFY_TOKEN) return process.env.WHATSAPP_VERIFY_TOKEN;
  try {
    const { data } = await supabase.from("whatsapp_config").select("verify_token").eq("workspace", "default").maybeSingle();
    return data?.verify_token || null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const mode = p.get("hub.mode");
  const token = p.get("hub.verify_token");
  const challenge = p.get("hub.challenge");
  const expected = await expectedVerifyToken();
  if (mode === "subscribe" && token && expected && token === expected) {
    await logEvent("✅ Webhook verified by Meta (verify token matched).");
    return new NextResponse(challenge ?? "", { status: 200 });
  }
  await logEvent("⚠️ Verification attempt failed — verify token did not match.");
  return new NextResponse("Verification failed", { status: 403 });
}

function signatureValid(raw: string, header: string | null): boolean {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return true; // not configured — allow (dev). Set it in production.
  if (!header) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
  } catch {
    return false;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function logEvent(summary: string) {
  try {
    await supabase.from("wa_webhook_events").insert({ summary: summary.slice(0, 300) });
  } catch {
    /* table may not exist yet */
  }
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const sigOk = signatureValid(raw, req.headers.get("x-hub-signature-256"));
  const strict = process.env.WHATSAPP_STRICT_SIGNATURE === "true";

  if (!sigOk) {
    if (strict) {
      await logEvent("⚠️ Rejected POST — invalid X-Hub-Signature-256 (strict mode). Set META_APP_SECRET to your App Secret.");
      return NextResponse.json({ received: true });
    }
    // Lenient (default): process anyway so testing isn't blocked, but warn loudly.
    await logEvent("⚠️ Signature mismatch — processing anyway. Set META_APP_SECRET to your Meta App Secret (App Settings → Basic) for verified delivery.");
  }

  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    await logEvent("Received POST with an unparseable body.");
    return NextResponse.json({ received: true });
  }

  try {
    let handled = 0;
    let statuses = 0;
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        if (value.messaging_product !== "whatsapp") continue;
        const contacts: any[] = value.contacts ?? [];
        for (const m of value.messages ?? []) {
          await handleInbound(m, contacts);
          handled++;
        }
        statuses += (value.statuses ?? []).length;
      }
    }
    if (handled > 0) await logEvent(`✅ Stored ${handled} inbound message(s).`);
    else if (statuses > 0) await logEvent(`Delivery status update (${statuses}) — outbound only, nothing to show in the inbox.`);
    else await logEvent("Webhook called, but no inbound messages in the payload.");
  } catch (e) {
    console.error("wa webhook error", e);
    await logEvent(`Error while processing: ${e instanceof Error ? e.message : "unknown"}`);
  }

  return NextResponse.json({ received: true });
}

// Find an existing patient by phone (digit match) or create a new "New" lead
// sourced from WhatsApp, so inbound contacts populate the CRM automatically.
async function resolvePatient(phone: string, name: string): Promise<string | null> {
  const digits = phone.replace(/\D/g, "");
  try {
    const { data: pts } = await supabase.from("patients").select("id, phone");
    const match = (pts ?? []).find((p: any) => {
      const d = String(p.phone ?? "").replace(/\D/g, "");
      return d.length >= 7 && (d === digits || d.endsWith(digits.slice(-9)) || digits.endsWith(d.slice(-9)));
    });
    if (match) return match.id;
    const { data: created, error } = await supabase
      .from("patients")
      .insert({ name: name || `+${phone}`, phone: `+${phone}`, status: "New", source_channel: "whatsapp", source_agent: "WhatsApp inbox" })
      .select("id")
      .single();
    if (error) return null;
    return created?.id ?? null;
  } catch {
    return null;
  }
}

async function handleInbound(m: any, contacts: any[]) {
  const phone: string = m.from;
  if (!phone) return;
  const name = contacts.find((c) => c.wa_id === phone)?.profile?.name || phone;
  const body: string = m.text?.body ?? `[${m.type ?? "message"}]`;

  // Dedupe by Meta message id.
  if (m.id) {
    const { data: existing } = await supabase.from("wa_messages").select("id").eq("wa_message_id", m.id).maybeSingle();
    if (existing) return;
  }

  // Upsert conversation by phone.
  const { data: convo } = await supabase.from("wa_conversations").select("*").eq("contact_phone", phone).maybeSingle();
  let conversationId: string;
  if (convo) {
    conversationId = convo.id;
    await supabase
      .from("wa_conversations")
      .update({ contact_name: name, last_message: body, last_time: new Date().toISOString(), unread: (convo.unread ?? 0) + 1 })
      .eq("id", conversationId);
  } else {
    // New conversation → auto-capture the lead into the CRM (Patients).
    const patientId = await resolvePatient(phone, name);
    const { data: created } = await supabase
      .from("wa_conversations")
      .insert({ contact_phone: phone, contact_name: name, last_message: body, last_time: new Date().toISOString(), unread: 1, patient_id: patientId })
      .select("id")
      .single();
    conversationId = created!.id;
  }

  await supabase.from("wa_messages").insert({ conversation_id: conversationId, direction: "inbound", author: name, body, wa_message_id: m.id ?? null });

  // A human has taken over this conversation ("Assign to me") — never auto-reply.
  if (convo?.status === "human") return;

  // Decide which agent (if any) answers: conversation override, else WhatsApp Agent-Hub default.
  let agentId: string | null = convo?.assigned_agent_id ?? null;
  if (!agentId) {
    const { data: def } = await supabase.from("channel_defaults").select("agent_id, enabled").eq("channel", "whatsapp").maybeSingle();
    if (def?.enabled && def.agent_id) agentId = def.agent_id;
  }
  if (!agentId) return; // no agent → leave for a human

  const { data: agent } = await supabase.from("agents").select("*").eq("id", agentId).maybeSingle();
  if (!agent || agent.status === "Paused") return;

  // Recent thread for context.
  const { data: history } = await supabase
    .from("wa_messages")
    .select("direction, body")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(12);

  const result = await generateAgentReply({
    model: agent.model ?? "openai/gpt-4o-mini",
    agentName: agent.name,
    instructions: agent.instructions ?? "",
    knowledgeBase: agent.knowledge_base ?? "",
    capabilities: { canBook: agent.can_book, canReschedule: agent.can_reschedule, canCancel: agent.can_cancel },
    messages: (history ?? []).map((h: any) => ({ role: h.direction === "inbound" ? ("user" as const) : ("assistant" as const), content: h.body })),
  });
  if (!result.reply) return;

  const sent = await sendWhatsAppText(phone, result.reply);
  await supabase.from("wa_messages").insert({
    conversation_id: conversationId,
    direction: "outbound",
    author: `${agent.name} (AI)`,
    by_bot: true,
    body: result.reply,
    wa_message_id: sent.id ?? null,
  });
  await supabase.from("wa_conversations").update({ last_message: result.reply, last_time: new Date().toISOString() }).eq("id", conversationId);
}
