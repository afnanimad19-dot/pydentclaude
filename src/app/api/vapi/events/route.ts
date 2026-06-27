import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getSlots, bookAppointment, rescheduleAppt, cancelAppt, type BookingCtx } from "@/lib/booking-server";

// Vapi server webhook. Set this URL as the assistant's Server URL in Vapi.
// Handles status updates (live state) and the end-of-call report (transcript,
// recording, summary). Stores everything in voice_calls, scoped to the clinic
// whose assistant took the call. Optionally protected by VAPI_WEBHOOK_SECRET.

/* eslint-disable @typescript-eslint/no-explicit-any */
async function upsertCall(vapiCallId: string, row: Record<string, any>) {
  const { data: existing } = await supabase.from("voice_calls").select("id").eq("vapi_call_id", vapiCallId).limit(1).maybeSingle();
  const write = (r: Record<string, any>) =>
    existing
      ? supabase.from("voice_calls").update(r).eq("id", existing.id)
      : supabase.from("voice_calls").insert({ vapi_call_id: vapiCallId, ...r });
  let { error } = await write(row);
  // Newer columns (to_phone/ended_reason/messages/structured_data) may not be
  // migrated yet — strip them and retry so the core record still saves.
  if (error && /to_phone|ended_reason|messages|structured_data/.test(error.message)) {
    const slim = { ...row };
    delete slim.to_phone; delete slim.ended_reason; delete slim.messages; delete slim.structured_data;
    ({ error } = await write(slim));
  }
}

// Find the clinic + agent that owns this Vapi assistant, and the caller's phone.
async function resolveContext(msg: any): Promise<{ ws: string | null; agentId: string | null; agentName: string }> {
  const assistantId = msg?.call?.assistantId ?? msg?.assistant?.id ?? msg?.assistantId;
  if (!assistantId) return { ws: null, agentId: null, agentName: "" };
  const { data } = await supabase.from("agents").select("id, name, workspace_id").eq("vapi_assistant_id", assistantId).maybeSingle();
  return { ws: data?.workspace_id ?? null, agentId: data?.id ?? null, agentName: data?.name ?? "" };
}

async function captureCaller(ws: string | null, phone: string, name: string): Promise<string | null> {
  if (!phone) return null;
  try {
    const digits = phone.replace(/\D/g, "");
    const { data: pts } = await supabase.from("patients").select("id, phone").eq("workspace_id", ws);
    const match = (pts ?? []).find((p: any) => String(p.phone ?? "").replace(/\D/g, "").endsWith(digits.slice(-9)));
    if (match) return match.id;
    const { data: created } = await supabase
      .from("patients")
      .insert({ workspace_id: ws, name: name || phone, phone, status: "New", source_channel: "voice", source_agent: "Voice agent" })
      .select("id")
      .single();
    return created?.id ?? null;
  } catch {
    return null;
  }
}

// Normalise Vapi's tool-call payloads (which vary by version) into a flat list
// of { id, name, args }.
function extractToolCalls(msg: any): { id: string; name: string; args: any }[] {
  const list = msg?.toolCallList ?? msg?.toolCalls ?? msg?.toolWithToolCallList ?? [];
  const out: { id: string; name: string; args: any }[] = [];
  for (const tc of Array.isArray(list) ? list : []) {
    const fn = tc?.function ?? tc;
    let args = fn?.arguments ?? fn?.parameters ?? tc?.arguments ?? {};
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { args = {}; }
    }
    out.push({ id: tc?.id ?? tc?.toolCallId ?? "", name: fn?.name ?? tc?.name ?? "", args: args ?? {} });
  }
  // Legacy single function-call shape.
  if (out.length === 0 && msg?.functionCall) {
    let args = msg.functionCall.parameters ?? msg.functionCall.arguments ?? {};
    if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
    out.push({ id: msg.functionCall.id ?? "", name: msg.functionCall.name ?? "", args });
  }
  return out;
}

async function runVoiceTool(ctx: BookingCtx, name: string, args: any): Promise<string> {
  switch (name) {
    case "get_available_slots":
      return getSlots(ctx.ws, args);
    case "book_appointment":
      return bookAppointment(ctx, args);
    case "reschedule_appointment":
      return rescheduleAppt(ctx, args);
    case "cancel_appointment":
      return cancelAppt(ctx, args);
    default:
      return "Unsupported tool.";
  }
}

async function handleToolCalls(msg: any): Promise<NextResponse> {
  const ctx = await resolveContext(msg);
  const phone = msg?.call?.customer?.number ?? msg?.customer?.number ?? "";
  const patientId = await captureCaller(ctx.ws, phone, "");
  const bookingCtx: BookingCtx = {
    ws: ctx.ws,
    patientId,
    name: "",
    phone,
    source: "voice",
    bookedBy: ctx.agentName,
  };

  const calls = extractToolCalls(msg);
  const results = [];
  for (const c of calls) {
    let result: string;
    try {
      result = await runVoiceTool(bookingCtx, c.name, c.args);
    } catch (e) {
      result = `Error: ${e instanceof Error ? e.message : "tool failed"}`;
    }
    results.push({ toolCallId: c.id, name: c.name, result });
  }

  // Vapi expects { results: [{ toolCallId, result }] }.
  return NextResponse.json({ results });
}

export async function POST(req: NextRequest) {
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (secret) {
    const got = req.headers.get("x-vapi-secret") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (got !== secret) return NextResponse.json({ ok: true }); // ack, ignore
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }
  const msg = body?.message ?? body;
  const type: string = msg?.type ?? "";
  const callId: string = msg?.call?.id ?? msg?.callId ?? "";

  // Live-call booking: the agent invoked one of our tools mid-call. Run it
  // (Calendar + Open Dental) and return the result so the agent can confirm.
  if (type === "tool-calls" || type === "function-call") {
    return handleToolCalls(msg);
  }

  if (!callId) return NextResponse.json({ ok: true });

  try {
    if (type === "status-update") {
      const status = msg?.status ?? msg?.call?.status ?? "in-progress";
      const ctx = await resolveContext(msg);
      await upsertCall(callId, {
        workspace_id: ctx.ws,
        agent_id: ctx.agentId,
        agent_name: ctx.agentName,
        caller_phone: msg?.call?.customer?.number ?? msg?.customer?.number ?? "",
        direction: msg?.call?.type === "outboundPhoneCall" ? "outbound" : "inbound",
        status: status === "ended" ? "ended" : "in-progress",
      });
    } else if (type === "end-of-call-report") {
      const ctx = await resolveContext(msg);
      const phone = msg?.call?.customer?.number ?? msg?.customer?.number ?? "";
      const patientId = await captureCaller(ctx.ws, phone, "");
      const transcript = msg?.artifact?.transcript ?? msg?.transcript ?? "";
      const recording = msg?.artifact?.recordingUrl ?? msg?.recordingUrl ?? msg?.artifact?.recording?.stereoUrl ?? "";
      const summary = msg?.analysis?.summary ?? msg?.summary ?? "";
      const startedAt = msg?.startedAt ?? msg?.call?.startedAt;
      const endedAt = msg?.endedAt ?? msg?.call?.endedAt ?? new Date().toISOString();
      const duration = Math.round(Number(msg?.durationSeconds ?? msg?.call?.durationSeconds ?? 0));
      // The clinic/assistant number that was called ("To"), and the structured
      // conversation timeline (turns + tool calls) for the detail page.
      const toPhone = msg?.phoneNumber?.number ?? msg?.call?.phoneNumber?.number ?? msg?.call?.phoneNumberId ?? "";
      const endedReason = msg?.endedReason ?? msg?.call?.endedReason ?? "";
      const messages = msg?.artifact?.messages ?? msg?.messages ?? [];
      const structuredData = msg?.analysis?.structuredData ?? {};
      const row: Record<string, unknown> = {
        workspace_id: ctx.ws,
        agent_id: ctx.agentId,
        agent_name: ctx.agentName,
        caller_phone: phone,
        patient_id: patientId,
        status: "ended",
        started_at: startedAt ?? null,
        ended_at: endedAt,
        duration_sec: duration,
        transcript,
        summary,
        recording_url: recording,
        outcome: msg?.analysis?.successEvaluation ? "Success" : "",
        to_phone: toPhone,
        ended_reason: endedReason,
        messages,
        structured_data: structuredData,
      };
      await upsertCall(callId, row);
    }
  } catch (e) {
    console.error("vapi webhook error", e);
  }

  return NextResponse.json({ ok: true });
}
