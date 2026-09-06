import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { getLivekitCreds, lkConfigured, webhookReceiver, wsFromRoom } from "@/lib/livekit";

// LiveKit webhook (set this URL in the LiveKit project → Settings → Webhooks).
// Gives Call Logs a live "in progress" row the moment a call starts and closes
// it on room_finished — even if the worker's own end-of-call post never lands.
// Rooms are named p_<workspace>_<kind>_<rand>, so the workspace is read from the
// room name, its LiveKit creds loaded, and THEN the signature is verified with
// those creds (a spoofed body can't pass verification).
export const runtime = "nodejs";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function upsert(roomKey: string, row: Record<string, any>) {
  const { data: existing } = await supabase.from("voice_calls").select("id, transcript").eq("vapi_call_id", roomKey).limit(1).maybeSingle();
  const write = (r: Record<string, any>) =>
    existing ? supabase.from("voice_calls").update(r).eq("id", existing.id) : supabase.from("voice_calls").insert({ vapi_call_id: roomKey, ...r });
  let { error } = await write(row);
  if (error && /engine|to_phone|ended_reason|messages|structured_data|campaign_id/.test(error.message)) {
    const slim = { ...row };
    delete slim.engine; delete slim.to_phone; delete slim.ended_reason; delete slim.messages; delete slim.structured_data; delete slim.campaign_id;
    ({ error } = await write(slim));
  }
  return error;
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  let peek: any = {};
  try { peek = JSON.parse(body); } catch { return NextResponse.json({ error: "bad body" }, { status: 400 }); }
  const roomName: string = peek?.room?.name ?? "";
  const { ws, kind } = wsFromRoom(roomName);
  if (!ws) return NextResponse.json({ ok: true, ignored: "not a Pydent room" });

  const creds = await getLivekitCreds(ws);
  if (!lkConfigured(creds)) return NextResponse.json({ error: "LiveKit not configured for this workspace" }, { status: 503 });

  let event: any;
  try {
    event = await webhookReceiver(creds).receive(body, req.headers.get("authorization") ?? undefined);
  } catch (e) {
    return NextResponse.json({ error: `signature check failed: ${e instanceof Error ? e.message : "invalid"}` }, { status: 401 });
  }

  const key = `lk:${roomName}`;
  const type: string = event?.event ?? "";
  const direction = kind === "out" ? "outbound" : "inbound";
  const now = new Date().toISOString();

  if (type === "room_started") {
    await upsert(key, { workspace_id: ws, direction, status: "live", started_at: now, engine: "livekit", structured_data: { engine: "livekit", room: roomName, source: kind } });
  } else if (type === "participant_joined") {
    // SIP callers carry their number as a participant attribute.
    const attrs = event?.participant?.attributes ?? {};
    const phone = attrs["sip.phoneNumber"] ?? attrs["sip.from"] ?? "";
    const to = attrs["sip.trunkPhoneNumber"] ?? attrs["sip.to"] ?? "";
    if (phone || to) await upsert(key, { workspace_id: ws, ...(phone ? { caller_phone: String(phone) } : {}), ...(to ? { to_phone: String(to) } : {}) });
  } else if (type === "room_finished") {
    const created = Number(event?.room?.creationTime ?? 0);
    const startedIso = created ? new Date(created * 1000).toISOString() : null;
    const duration = created ? Math.max(0, Math.round(Date.now() / 1000 - created)) : 0;
    await upsert(key, { workspace_id: ws, status: "ended", ended_at: now, ...(startedIso ? { started_at: startedIso } : {}), duration_sec: duration });
  }
  return NextResponse.json({ ok: true });
}
