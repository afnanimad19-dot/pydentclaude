import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

// Vapi server webhook. Set this URL as the assistant's Server URL in Vapi.
// Handles status updates (live state) and the end-of-call report (transcript,
// recording, summary). Stores everything in voice_calls, scoped to the clinic
// whose assistant took the call. Optionally protected by VAPI_WEBHOOK_SECRET.

/* eslint-disable @typescript-eslint/no-explicit-any */
async function upsertCall(vapiCallId: string, row: Record<string, any>) {
  const { data: existing } = await supabase.from("voice_calls").select("id").eq("vapi_call_id", vapiCallId).limit(1).maybeSingle();
  if (existing) await supabase.from("voice_calls").update(row).eq("id", existing.id);
  else await supabase.from("voice_calls").insert({ vapi_call_id: vapiCallId, ...row });
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
      await upsertCall(callId, {
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
      });
    }
  } catch (e) {
    console.error("vapi webhook error", e);
  }

  return NextResponse.json({ ok: true });
}
