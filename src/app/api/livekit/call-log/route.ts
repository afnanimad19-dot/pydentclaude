import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { resolveWorkerToken } from "@/lib/livekit";

// The deployed LiveKit worker posts here when a call ends: the transcript,
// caller number, timing and which agent handled it. Stored in voice_calls
// tagged engine="livekit" so Call Logs shows LiveKit and Vapi calls side by
// side with a source tag. Keyed by the room name (vapi_call_id = "lk:<room>")
// so the webhook's room_started/room_finished rows merge into the same record.
export const runtime = "nodejs";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function upsert(roomKey: string, row: Record<string, any>) {
  const { data: existing } = await supabase.from("voice_calls").select("id").eq("vapi_call_id", roomKey).limit(1).maybeSingle();
  const write = (r: Record<string, any>) =>
    existing ? supabase.from("voice_calls").update(r).eq("id", existing.id) : supabase.from("voice_calls").insert({ vapi_call_id: roomKey, ...r });
  let { error } = await write(row);
  // Older DBs: drop columns that may not be migrated yet and retry.
  if (error && /engine|to_phone|ended_reason|messages|structured_data|campaign_id/.test(error.message)) {
    const slim = { ...row };
    delete slim.engine; delete slim.to_phone; delete slim.ended_reason; delete slim.messages; delete slim.structured_data; delete slim.campaign_id;
    ({ error } = await write(slim));
  }
  return error;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const auth = await resolveWorkerToken(body.token);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });

  const room = String(body.room ?? "");
  const ws = auth.ws ?? String(body.ws ?? "");
  if (!room || !ws) return NextResponse.json({ error: "room and ws are required." }, { status: 400 });

  const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
  const transcript = messages.length
    ? messages.map((m: any) => `${m.role === "assistant" ? (body.agentName || "Agent") : "Caller"}: ${String(m.text ?? m.content ?? "").trim()}`).filter((l: string) => !/:\s*$/.test(l)).join("\n")
    : String(body.transcript ?? "");
  const started = body.startedAt ? new Date(body.startedAt) : null;
  const ended = body.endedAt ? new Date(body.endedAt) : new Date();
  const duration = started ? Math.max(0, Math.round((ended.getTime() - started.getTime()) / 1000)) : Number(body.durationSec ?? 0) || 0;

  const error = await upsert(`lk:${room}`, {
    workspace_id: ws,
    agent_name: String(body.agentName ?? ""),
    caller_phone: String(body.callerPhone ?? ""),
    to_phone: String(body.toPhone ?? ""),
    direction: String(body.direction ?? "inbound"),
    status: "ended",
    started_at: started ? started.toISOString() : null,
    ended_at: ended.toISOString(),
    duration_sec: duration,
    ended_reason: String(body.endedReason ?? ""),
    transcript,
    summary: String(body.summary ?? ""),
    outcome: String(body.outcome ?? ""),
    messages: messages.map((m: any, i: number) => ({ role: m.role === "assistant" ? "bot" : "user", message: String(m.text ?? m.content ?? ""), secondsFromStart: Number(m.secondsFromStart ?? i) })),
    engine: "livekit",
    structured_data: { engine: "livekit", room, source: body.source ?? "", ...(body.structuredData && typeof body.structuredData === "object" ? body.structuredData : {}) },
  });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
