import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { generateAgentReply, generateAgentReplyWithTools } from "@/lib/agent-reply";
import { sendByChannel, fetchMetaUserName, getWaCredsByPhoneId, getPageCredsByPageId } from "@/lib/wa-send";
import { getSlots, bookAppointment, rescheduleAppt, cancelAppt, type BookingCtx } from "@/lib/booking-server";
import { sendAgentEmail } from "@/lib/email-send";
import { triggerWorkflows } from "@/lib/workflow-runner";

// Meta calls this endpoint:
//  1. GET  — verification handshake when you save the webhook (echo hub.challenge).
//  2. POST — inbound messages / status updates. We store messages, surface them
//     in the Omnichannel Inbox, and (if an agent is set for WhatsApp in the Agent
//     Hub or on the conversation) auto-reply from the agent's knowledge base.

async function expectedVerifyToken(): Promise<string | null> {
  if (process.env.WHATSAPP_VERIFY_TOKEN) return process.env.WHATSAPP_VERIFY_TOKEN;
  try {
    const { data } = await supabase.from("whatsapp_config").select("verify_token").not("verify_token","is",null).limit(1).maybeSingle();
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
          const phoneNumberId: string | undefined = value.metadata?.phone_number_id;
          for (const m of value.messages ?? []) {
            await handleWhatsApp(m, contacts, phoneNumberId);
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
        const pageId: string | undefined = entry.id;
        for (const ev of entry.messaging ?? []) {
          if (await handleMessaging(channel, ev, pageId)) handled++;
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

// The active clinic's workspace id (single connected clinic for now — keyed off
// the stored WhatsApp config). Inbound rows are tagged with this so they show in
// that clinic's (scoped) dashboards.
async function activeWorkspace(): Promise<string | null> {
  try {
    const { data } = await supabase.from("whatsapp_config").select("workspace").limit(1).maybeSingle();
    return data?.workspace ?? null;
  } catch {
    return null;
  }
}

// Auto-capture a lead into the CRM. WhatsApp matches an existing patient by phone;
// Messenger/Instagram create a new contact (no phone to match on).
async function resolveLead(channel: string, contactId: string, name: string, ws: string | null): Promise<string | null> {
  try {
    if (channel === "whatsapp") {
      const digits = contactId.replace(/\D/g, "");
      const { data: pts } = await supabase.from("patients").select("id, phone").eq("workspace_id", ws);
      const match = (pts ?? []).find((p: any) => {
        const d = String(p.phone ?? "").replace(/\D/g, "");
        return d.length >= 7 && (d === digits || d.endsWith(digits.slice(-9)) || digits.endsWith(d.slice(-9)));
      });
      if (match) return match.id;
      const { data: created } = await supabase
        .from("patients")
        .insert({ workspace_id: ws, name: name || `+${contactId}`, phone: `+${contactId}`, status: "New", source_channel: "whatsapp", source_agent: "WhatsApp inbox" })
        .select("id")
        .single();
      return created?.id ?? null;
    }
    const { data: created } = await supabase
      .from("patients")
      .insert({ workspace_id: ws, name: name || `${channel} user`, phone: "", status: "New", source_channel: channel, source_agent: `${channel} inbox` })
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

// WhatsApp inbound adapter — resolves the receiving number's account so the
// reply is sent from (and stored under) the right clinic.
async function handleWhatsApp(m: any, contacts: any[], phoneNumberId?: string) {
  const phone: string = m.from;
  if (!phone) return;
  const name = contacts.find((c) => c.wa_id === phone)?.profile?.name || phone;
  const body: string = m.text?.body ?? `[${m.type ?? "message"}]`;
  const creds = phoneNumberId ? await getWaCredsByPhoneId(phoneNumberId) : null;
  // Diagnose the #1 silent failure after re-registering a number: the Phone
  // Number ID Meta sends doesn't match the one saved in the config, so the
  // reply is sent from (and stored under) the wrong/unknown account.
  if (phoneNumberId && !creds) {
    await logEvent(`⚠️ Inbound arrived on Phone Number ID ${phoneNumberId}, but NO saved WhatsApp config matches it. Paste THIS exact Phone Number ID in Settings → WhatsApp config (Meta → WhatsApp → API Setup shows it). Using a fallback account for now.`);
  }
  const ws = creds?.workspace ?? (await activeWorkspace());
  await storeInbound("whatsapp", phone, name, body, m.id ?? null, ws, creds ? { wa: { phoneNumberId: creds.phoneNumberId, accessToken: creds.accessToken } } : undefined);
}

// Messenger / Instagram inbound adapter (Messenger Platform event format).
// Returns true if it stored a real inbound message.
async function handleMessaging(channel: string, ev: any, pageId?: string): Promise<boolean> {
  if (!ev?.message || ev.message.is_echo) return false; // ignore echoes, delivery/read receipts
  const senderId: string = ev.sender?.id;
  if (!senderId) return false;
  const body: string = ev.message.text ?? (ev.message.attachments?.length ? "[attachment]" : "[message]");
  const mid: string | null = ev.message.mid ?? null;
  const name = (await fetchMetaUserName(senderId)) ?? `${channel === "instagram" ? "Instagram" : "Messenger"} user`;
  const page = pageId ? await getPageCredsByPageId(pageId) : null;
  await storeInbound(channel, senderId, name, body, mid, page?.workspace ?? (await activeWorkspace()), page ? { pageToken: page.pageToken } : undefined);
  return true;
}


// Explain a rejected send in plain terms. THE classic "it replies to my phone but
// not to another number": a test/unpublished app can only message a short list of
// allowed recipients, so the very first message from any other number is rejected.
function sendFailureHint(error: string | undefined, channel: string): string {
  const e = (error ?? "").toLowerCase();
  if (channel === "whatsapp" && (/#131030/.test(e) || /not in allowed list|recipient phone number not/.test(e))) {
    return "CAUSE: this number is running as a TEST/unpublished WhatsApp app, so Meta only delivers to numbers on the allowed-recipients list — that's exactly why it replies to your phone but NOT to a different number. FIX: switch to a real registered WhatsApp number and set the Meta app to LIVE (App Dashboard → top toggle → Live), or, to keep testing, add each tester's number under WhatsApp → API Setup → 'To' → Manage phone number list. Also make sure the Access Token is a permanent System-User token.";
  }
  if (/#131047|re-?engagement|24 ?hour|outside.*window/.test(e)) {
    return "CAUSE: the 24-hour customer-service window is closed (the patient hasn't messaged in the last 24h), so free-form text can't be delivered — you must open with an approved TEMPLATE. FIX: send an approved template message first; once they reply, normal messages work for 24h.";
  }
  if (/#?190|access token|expired|oauth|session has been invalidated/.test(e)) {
    return "CAUSE: the access token is expired/invalid. FIX: paste a permanent System-User token in Settings → WhatsApp config.";
  }
  return "Most common causes: (1) the app is still a TEST number so only allowed recipients get replies — publish it Live or add the number to the allowed list; (2) the access token expired — paste a permanent token in Settings → WhatsApp config.";
}

// Did the agent defer / not know the answer? (Heuristic on the reply text.)
function looksLikeDefer(reply: string): boolean {
  const r = reply.toLowerCase();
  return /check with (the|our) team|get back to you|i('?| a)?m not sure|i don'?t have (that|this|the)|i don'?t know|let me (check|find out|confirm)|our team will|someone (from )?(the )?team|connect you (to|with) (a|our|the)|direct you to|reception|i'?ll have (someone|the)|follow up with you|can'?t answer that|not able to (help|answer)/.test(
    r
  );
}

// Record an unanswered question for the Learning Agent. Summarized: the same
// question from the same agent increments a counter instead of duplicating.
async function captureLearning(ws: string | null, agentId: string | null, agentName: string, question: string) {
  const q = (question || "").trim();
  if (!ws || !q || q.length < 4 || q.startsWith("[")) return;
  const norm = q.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!norm) return;
  try {
    const { data: existing } = await supabase
      .from("learning_questions")
      .select("id, times_asked")
      .eq("workspace_id", ws)
      .eq("agent_id", agentId)
      .eq("question_norm", norm)
      .eq("status", "open")
      .maybeSingle();
    if (existing) {
      await supabase.from("learning_questions").update({ times_asked: (existing.times_asked ?? 1) + 1, last_seen: new Date().toISOString() }).eq("id", existing.id);
    } else {
      await supabase.from("learning_questions").insert({ workspace_id: ws, agent_id: agentId, agent_name: agentName, question: q.slice(0, 500), question_norm: norm });
    }
  } catch {
    /* table may not exist yet */
  }
}

// Generic inbound handler shared by every channel.
async function storeInbound(
  channel: string,
  contactId: string,
  name: string,
  body: string,
  mid: string | null,
  ws: string | null,
  sendCreds?: { wa?: { phoneNumberId: string; accessToken: string }; pageToken?: string }
) {
  // Dedupe by message id.
  if (mid) {
    const { data: existing } = await supabase.from("wa_messages").select("id").eq("wa_message_id", mid).maybeSingle();
    if (existing) return;
  }

  const { data: convo } = await supabase.from("wa_conversations").select("*").eq("workspace_id", ws).eq("contact_phone", contactId).eq("channel", channel).maybeSingle();
  let conversationId: string;
  let convoPatientId: string | null = convo?.patient_id ?? null;
  if (convo) {
    conversationId = convo.id;
    await supabase
      .from("wa_conversations")
      .update({ contact_name: name, last_message: body, last_time: new Date().toISOString(), unread: (convo.unread ?? 0) + 1 })
      .eq("id", conversationId);
  } else {
    convoPatientId = await resolveLead(channel, contactId, name, ws);
    const { data: created } = await supabase
      .from("wa_conversations")
      .insert({ workspace_id: ws, contact_phone: contactId, channel, contact_name: name, last_message: body, last_time: new Date().toISOString(), unread: 1, patient_id: convoPatientId })
      .select("id")
      .single();
    conversationId = created!.id;
    // New conversation → fire any Live workflows whose trigger is "conversation opened".
    try {
      const started = await triggerWorkflows(supabase, ws, "conversation_opened", channel, { patientId: convoPatientId, conversationId, channel, contactPhone: contactId, name, lastMessage: body });
      if (started > 0) await logEvent(`▶ Started ${started} workflow run${started > 1 ? "s" : ""} for new ${channel} conversation with ${name}.`);
    } catch { /* never block the inbound */ }
  }

  // Insert the inbound message. If Meta retried (duplicate message id), the unique
  // index rejects it — abort so we don't reply twice.
  const { error: inboundErr } = await supabase.from("wa_messages").insert({ workspace_id: ws, conversation_id: conversationId, direction: "inbound", author: name, body, wa_message_id: mid });
  if (inboundErr && mid) {
    await logEvent(`Duplicate inbound from ${name} ignored (Meta retry).`);
    return;
  }

  // A human has taken over ("Assign to me") — never auto-reply.
  if (convo?.status === "human") {
    await logEvent(`Stored ${channel} message from ${name}. No auto-reply: conversation is assigned to a human.`);
    return;
  }

  // Conversation override, else the Agent-Hub default for this channel.
  let agentId: string | null = convo?.assigned_agent_id ?? null;
  if (!agentId) {
    const { data: def } = await supabase.from("channel_defaults").select("agent_id, enabled").eq("workspace_id", ws).eq("channel", channel).maybeSingle();
    if (def?.enabled && def.agent_id) agentId = def.agent_id;

    // SINGLE-CLINIC TOLERANCE: the config row and the channel default can end up
    // under different workspace keys (e.g. the config saved under "default"
    // while the agent default is under the real workspace UUID). When there is
    // exactly ONE enabled default for this channel across the whole install,
    // use it rather than silently dropping the reply. Multi-tenant installs
    // (several enabled defaults) stay strict — no cross-clinic leakage.
    if (!agentId) {
      const { data: allDefs } = await supabase.from("channel_defaults").select("workspace_id, agent_id, enabled").eq("channel", channel).eq("enabled", true).not("agent_id", "is", null);
      const enabled = (allDefs ?? []).filter((d: any) => d.agent_id);
      if (enabled.length === 1) {
        agentId = enabled[0].agent_id;
        await logEvent(`ℹ️ Used the only WhatsApp agent set on this account (its default lives under a different workspace than this number's config — reconnecting the number under the same login keeps them aligned).`);
      }
    }
  }
  if (!agentId) {
    await logEvent(`Stored ${channel} message from ${name}. No auto-reply: no agent is set for ${channel} in workspace ${ws ?? "(none)"} — turn one on in AI Agents → Agent Hub while logged into this clinic.`);
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

  // The MOST RECENT messages, in chronological order. (Fetch newest-first then
  // reverse — otherwise a long chat freezes on its oldest 12 messages and the
  // agent loops, never seeing what the patient just said.)
  const { data: historyRows } = await supabase
    .from("wa_messages")
    .select("direction, body, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(20);
  const history = (historyRows ?? []).slice().reverse();

  // A returning contact (existing conversation, idle past the session window) gets
  // a short "welcome back" with a choice instead of starting cold. Default 5
  // minutes — a quiet chat is treated as ended and re-opened on their next reply.
  const sessionMin = Number(process.env.RETURNING_SESSION_MIN ?? 5);
  const RETURNING_MS = sessionMin * 60 * 1000;
  let sessionNote = "";
  if (convo?.last_time) {
    const gap = Date.now() - new Date(convo.last_time).getTime();
    if (gap > RETURNING_MS) {
      sessionNote =
        `FOR THIS REPLY ONLY (this overrides other instructions for this one message): the chat went quiet for a few minutes, so the ` +
        `previous session is treated as ended and the patient is now RETURNING. Whatever they just typed, do NOT continue the old topic yet. ` +
        `Instead: greet them warmly by name, say it's good to hear from them again, then offer exactly these THREE choices and ask them to reply with the number — ` +
        `1) Continue where we left off, 2) Start a new chat, 3) Just ask a question about a service (or hours/prices). ` +
        `If they then want to book, collect their details in ONE message — full name, email, phone number, the service, and a preferred day/time — not one at a time. Keep it short and friendly.`;
    }
  }

  // Give the agent context about any existing upcoming appointment.
  let apptContext = "";
  if (convoPatientId) {
    const { data: ap } = await supabase
      .from("appointments")
      .select("date, time, procedure")
      .eq("workspace_id", ws)
      .eq("patient_id", convoPatientId)
      .gte("date", new Date().toISOString().slice(0, 10))
      .neq("status", "Broken")
      .order("date")
      .order("time")
      .limit(1)
      .maybeSingle();
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
    patientContext: `Contact name: ${name}. Contact phone: ${contactId}.${apptContext}`,
    sessionNote,
    messages: (history ?? []).map((h: any) => ({ role: h.direction === "inbound" ? ("user" as const) : ("assistant" as const), content: h.body })),
  };

  const useTools = agent.can_book || agent.can_reschedule || agent.can_cancel;
  // Stamp every booking with the channel it came from and the chat agent's name.
  const bookingCtx: BookingCtx = {
    ws,
    patientId: convoPatientId,
    name,
    phone: contactId,
    source: channel,
    bookedBy: agent.name,
    log: logEvent,
  };
  const executeTool = async (toolName: string, args: any): Promise<string> => {
    if (toolName === "get_available_slots") return getSlots(ws, args);
    if (toolName === "book_appointment") return bookAppointment(bookingCtx, args);
    if (toolName === "reschedule_appointment") return rescheduleAppt(bookingCtx, args);
    if (toolName === "cancel_appointment") return cancelAppt(bookingCtx, args);
    if (toolName === "send_email")
      return sendAgentEmail({ to: String(args.to ?? ""), subject: String(args.subject ?? ""), body: String(args.body ?? ""), ws: ws ?? undefined, fromName: agent.name });
    return "Unsupported tool.";
  };

  const result = useTools ? await generateAgentReplyWithTools(replyInput, executeTool) : await generateAgentReply(replyInput);
  if (result.error || !result.reply) {
    await logEvent(`⚠️ AI reply failed (${result.error ?? "empty reply"}). Check OPENROUTER_API_KEY in Netlify.`);
    return;
  }

  // Learning agent: if the agent deferred (didn't know), record the patient's
  // question so the clinic can teach the answer later.
  if (looksLikeDefer(result.reply)) {
    await captureLearning(ws, agentId, agent.name, body);
  }

  const sent = await sendByChannel(channel, contactId, result.reply, sendCreds);
  if (!sent.ok) {
    // Do NOT store it as a delivered reply — that's why the inbox showed a message
    // the patient never received. Surface the real reason instead.
    await logEvent(`⚠️ ${agent.name} drafted a reply but WhatsApp/Meta REJECTED the send: ${sent.error}. ${sendFailureHint(sent.error, channel)}`);
    return;
  }
  await supabase.from("wa_messages").insert({
    workspace_id: ws,
    conversation_id: conversationId,
    direction: "outbound",
    author: `${agent.name} (AI)`,
    by_bot: true,
    body: result.reply,
    wa_message_id: sent.id ?? null,
  });
  await logEvent(`✅ ${agent.name} auto-replied on ${channel} to ${name} (delivered).`);
  await supabase.from("wa_conversations").update({ last_message: result.reply, last_time: new Date().toISOString() }).eq("id", conversationId);
}
