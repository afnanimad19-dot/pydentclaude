import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { supabase } from "@/lib/supabase";
import { generateAgentReply } from "@/lib/agent-reply";
import { sendByChannel, fetchMetaUserName } from "@/lib/wa-send";

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
    const obj = payload.object;

    if (obj === "whatsapp_business_account") {
      for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const value = change.value ?? {};
          if (value.messaging_product !== "whatsapp") continue;
          const contacts: any[] = value.contacts ?? [];
          for (const m of value.messages ?? []) {
            await handleWhatsApp(m, contacts);
            handled++;
          }
          for (const s of value.statuses ?? []) {
            await handleStatus(s);
            statuses++;
          }
        }
      }
    } else if (obj === "page" || obj === "instagram") {
      const channel = obj === "page" ? "messenger" : "instagram";
      for (const entry of payload.entry ?? []) {
        for (const ev of entry.messaging ?? []) {
          if (await handleMessaging(channel, ev)) handled++;
        }
      }
    }

    if (handled > 0) await logEvent(`✅ Stored ${handled} inbound ${obj === "page" ? "Messenger" : obj === "instagram" ? "Instagram" : "WhatsApp"} message(s).`);
    else if (statuses > 0) await logEvent(`Delivery status update (${statuses}) — broadcast delivered/read counts updated.`);
    else await logEvent(`Webhook called (${obj ?? "unknown"}), but no inbound messages to store.`);
  } catch (e) {
    console.error("wa webhook error", e);
    await logEvent(`Error while processing: ${e instanceof Error ? e.message : "unknown"}`);
  }

  return NextResponse.json({ received: true });
}

// Auto-capture a lead into the CRM. WhatsApp matches an existing patient by phone;
// Messenger/Instagram create a new contact (no phone to match on).
async function resolveLead(channel: string, contactId: string, name: string): Promise<string | null> {
  try {
    if (channel === "whatsapp") {
      const digits = contactId.replace(/\D/g, "");
      const { data: pts } = await supabase.from("patients").select("id, phone");
      const match = (pts ?? []).find((p: any) => {
        const d = String(p.phone ?? "").replace(/\D/g, "");
        return d.length >= 7 && (d === digits || d.endsWith(digits.slice(-9)) || digits.endsWith(d.slice(-9)));
      });
      if (match) return match.id;
      const { data: created } = await supabase
        .from("patients")
        .insert({ name: name || `+${contactId}`, phone: `+${contactId}`, status: "New", source_channel: "whatsapp", source_agent: "WhatsApp inbox" })
        .select("id")
        .single();
      return created?.id ?? null;
    }
    const { data: created } = await supabase
      .from("patients")
      .insert({ name: name || `${channel} user`, phone: "", status: "New", source_channel: channel, source_agent: `${channel} inbox` })
      .select("id")
      .single();
    return created?.id ?? null;
  } catch {
    return null;
  }
}

// Delivery status updates (sent → delivered → read, or failed) for outbound
// messages. We match by the Meta message id stored when we sent each broadcast
// recipient, advance its status, and roll the totals up onto the broadcast.
const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 1 };

async function handleStatus(s: any) {
  const msgId = s?.id;
  if (!msgId) return;
  const newStatus: string = s.status;
  if (!(newStatus in STATUS_RANK)) return;

  const { data: rec } = await supabase.from("wa_broadcast_recipients").select("id, broadcast_id, status").eq("wa_message_id", msgId).maybeSingle();
  if (!rec) return; // not a broadcast message (e.g. an inbox reply) — ignore for now

  // Only advance forward in the funnel; 'failed' always wins.
  if (newStatus === "failed" || (STATUS_RANK[newStatus] ?? 0) > (STATUS_RANK[rec.status] ?? 0)) {
    const error = newStatus === "failed" ? s.errors?.[0]?.title ?? s.errors?.[0]?.message ?? "Failed" : undefined;
    await supabase.from("wa_broadcast_recipients").update(error ? { status: newStatus, error } : { status: newStatus }).eq("id", rec.id);
  }
  await recomputeBroadcast(rec.broadcast_id);
}

async function recomputeBroadcast(broadcastId: string) {
  const { data: recs } = await supabase.from("wa_broadcast_recipients").select("status").eq("broadcast_id", broadcastId);
  const c = { sent: 0, delivered: 0, read: 0, failed: 0 };
  for (const r of recs ?? []) {
    if (r.status === "failed") c.failed++;
    else {
      c.sent++;
      if (r.status === "delivered" || r.status === "read") c.delivered++;
      if (r.status === "read") c.read++;
    }
  }
  await supabase.from("wa_broadcasts").update({ sent: c.sent, delivered: c.delivered, read: c.read, failed: c.failed }).eq("id", broadcastId);
}

// WhatsApp inbound adapter.
async function handleWhatsApp(m: any, contacts: any[]) {
  const phone: string = m.from;
  if (!phone) return;
  const name = contacts.find((c) => c.wa_id === phone)?.profile?.name || phone;
  const body: string = m.text?.body ?? `[${m.type ?? "message"}]`;
  await storeInbound("whatsapp", phone, name, body, m.id ?? null);
}

// Messenger / Instagram inbound adapter (Messenger Platform event format).
// Returns true if it stored a real inbound message.
async function handleMessaging(channel: string, ev: any): Promise<boolean> {
  if (!ev?.message || ev.message.is_echo) return false; // ignore echoes, delivery/read receipts
  const senderId: string = ev.sender?.id;
  if (!senderId) return false;
  const body: string = ev.message.text ?? (ev.message.attachments?.length ? "[attachment]" : "[message]");
  const mid: string | null = ev.message.mid ?? null;
  const name = (await fetchMetaUserName(senderId)) ?? `${channel === "instagram" ? "Instagram" : "Messenger"} user`;
  await storeInbound(channel, senderId, name, body, mid);
  return true;
}

// Generic inbound handler shared by every channel.
async function storeInbound(channel: string, contactId: string, name: string, body: string, mid: string | null) {
  // Dedupe by message id.
  if (mid) {
    const { data: existing } = await supabase.from("wa_messages").select("id").eq("wa_message_id", mid).maybeSingle();
    if (existing) return;
  }

  const { data: convo } = await supabase.from("wa_conversations").select("*").eq("contact_phone", contactId).eq("channel", channel).maybeSingle();
  let conversationId: string;
  if (convo) {
    conversationId = convo.id;
    await supabase
      .from("wa_conversations")
      .update({ contact_name: name, last_message: body, last_time: new Date().toISOString(), unread: (convo.unread ?? 0) + 1 })
      .eq("id", conversationId);
  } else {
    const patientId = await resolveLead(channel, contactId, name);
    const { data: created } = await supabase
      .from("wa_conversations")
      .insert({ contact_phone: contactId, channel, contact_name: name, last_message: body, last_time: new Date().toISOString(), unread: 1, patient_id: patientId })
      .select("id")
      .single();
    conversationId = created!.id;
  }

  await supabase.from("wa_messages").insert({ conversation_id: conversationId, direction: "inbound", author: name, body, wa_message_id: mid });

  // A human has taken over ("Assign to me") — never auto-reply.
  if (convo?.status === "human") {
    await logEvent(`Stored ${channel} message from ${name}. No auto-reply: conversation is assigned to a human.`);
    return;
  }

  // Conversation override, else the Agent-Hub default for this channel.
  let agentId: string | null = convo?.assigned_agent_id ?? null;
  if (!agentId) {
    const { data: def } = await supabase.from("channel_defaults").select("agent_id, enabled").eq("channel", channel).maybeSingle();
    if (def?.enabled && def.agent_id) agentId = def.agent_id;
  }
  if (!agentId) {
    await logEvent(`Stored ${channel} message from ${name}. No auto-reply: no agent set for ${channel} (turn one on in AI Agents → Agent Hub).`);
    return;
  }

  const { data: agent } = await supabase.from("agents").select("*").eq("id", agentId).maybeSingle();
  if (!agent) {
    await logEvent(`No auto-reply: assigned agent not found.`);
    return;
  }
  if (agent.status === "Paused") {
    await logEvent(`No auto-reply: agent "${agent.name}" is Paused.`);
    return;
  }

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
  if (result.error || !result.reply) {
    await logEvent(`⚠️ AI reply failed (${result.error ?? "empty reply"}). Check OPENROUTER_API_KEY in Netlify.`);
    return;
  }

  const sent = await sendByChannel(channel, contactId, result.reply);
  if (!sent.ok) {
    await logEvent(`⚠️ Generated a reply but sending failed (${sent.error}). Check the access token in Settings → WhatsApp config (it may have expired).`);
  }
  await supabase.from("wa_messages").insert({
    conversation_id: conversationId,
    direction: "outbound",
    author: `${agent.name} (AI)`,
    by_bot: true,
    body: result.reply,
    wa_message_id: sent.id ?? null,
  });
  if (sent.ok) await logEvent(`✅ ${agent.name} auto-replied on ${channel} to ${name}.`);
  await supabase.from("wa_conversations").update({ last_message: result.reply, last_time: new Date().toISOString() }).eq("id", conversationId);
}
