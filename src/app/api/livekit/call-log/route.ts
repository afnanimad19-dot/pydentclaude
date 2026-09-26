import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { resolveWorkerToken } from "@/lib/livekit";
import { runPostCallExtraction } from "@/lib/post-call";
import { runCallSummaryForRow } from "@/lib/call-summary-server";
import { SUMMARY_AI_KEY } from "@/lib/call-summary";
import type { ExtractionField } from "@/lib/db";

// The deployed LiveKit worker posts here when a call ends: the transcript,
// caller number, timing and which agent handled it. Stored in voice_calls
// tagged engine="livekit" so Call Logs shows LiveKit and Vapi calls side by
// side with a source tag. Keyed by the room name (vapi_call_id = "lk:<room>")
// so the webhook's room_started/room_finished rows merge into the same record.
export const runtime = "nodejs";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function upsert(roomKey: string, row: Record<string, any>) {
  const { data: existing } = await supabase
    .from("voice_calls").select("id, summary, structured_data").eq("vapi_call_id", roomKey).limit(1).maybeSingle();

  // A worker re-post (retry / duplicate submission) must never lose what an
  // earlier round already produced: keep a non-empty stored summary when the
  // incoming one is empty, and carry the summary_ai status key over into the
  // freshly composed structured_data (the post itself replaces the rest).
  if (existing) {
    if (!String(row.summary ?? "").trim() && String(existing.summary ?? "").trim()) row.summary = existing.summary;
    const priorAi = (existing.structured_data as Record<string, any> | null)?.[SUMMARY_AI_KEY];
    if (priorAi && row.structured_data && typeof row.structured_data === "object") {
      row.structured_data = { [SUMMARY_AI_KEY]: priorAi, ...row.structured_data };
    }
  }

  const write = (r: Record<string, any>) =>
    existing
      ? supabase.from("voice_calls").update(r).eq("id", existing.id).select("id").maybeSingle()
      : supabase.from("voice_calls").insert({ vapi_call_id: roomKey, ...r }).select("id").maybeSingle();
  let { data, error } = await write(row);
  // Older DBs: drop columns that may not be migrated yet and retry.
  if (error && /engine|to_phone|ended_reason|messages|structured_data|campaign_id|latency_metrics|config_version|extracted_data/.test(error.message)) {
    const slim = { ...row };
    delete slim.engine; delete slim.to_phone; delete slim.ended_reason; delete slim.messages; delete slim.structured_data; delete slim.campaign_id;
    delete slim.latency_metrics; delete slim.config_version;
    ({ data, error } = await write(slim));
  }
  return { error, id: data?.id ? String(data.id) : existing?.id ? String(existing.id) : "" };
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const auth = await resolveWorkerToken(body.token);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });

  const room = String(body.room ?? "");
  const ws = auth.ws ?? String(body.ws ?? "");
  if (!room || !ws) return NextResponse.json({ error: "room and ws are required." }, { status: 400 });

  // Privacy (Data Storage Preference) decides what may be persisted:
  //   store_analyze -> transcript + analysis (summary/extraction)
  //   store_only    -> transcript, no analysis
  //   no_store      -> metadata only: no transcript, no messages, no analysis
  const privacy = ["store_analyze", "store_only", "no_store"].includes(String(body.privacy))
    ? String(body.privacy)
    : "store_analyze";
  const analyze = privacy === "store_analyze" && body.analyze !== false;
  const storeTranscript = privacy !== "no_store";

  const messages: any[] = storeTranscript && Array.isArray(body.messages) ? body.messages : [];
  const transcript = messages.length
    ? messages.map((m: any) => `${m.role === "assistant" ? (body.agentName || "Agent") : "Caller"}: ${String(m.text ?? m.content ?? "").trim()}`).filter((l: string) => !/:\s*$/.test(l)).join("\n")
    : storeTranscript ? String(body.transcript ?? "") : "";
  const started = body.startedAt ? new Date(body.startedAt) : null;
  const ended = body.endedAt ? new Date(body.endedAt) : new Date();
  const duration = started ? Math.max(0, Math.round((ended.getTime() - started.getTime()) / 1000)) : Number(body.durationSec ?? 0) || 0;

  const row: Record<string, any> = {
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
    structured_data: { engine: "livekit", room, source: body.source ?? "", privacy, ...(body.structuredData && typeof body.structuredData === "object" ? body.structuredData : {}) },
    latency_metrics: body.latencyMetrics && typeof body.latencyMetrics === "object" ? body.latencyMetrics : {},
    config_version: Number(body.configVersion) || 1,
  };
  const saved = await upsert(`lk:${room}`, row);
  if (saved.error) return NextResponse.json({ ok: false, error: saved.error.message }, { status: 500 });

  // Post-call data extraction. Runs only when the agent's privacy setting
  // allows analysis, and AFTER the call row is saved — it never delays the
  // worker's shutdown (the worker does not await the result).
  const fields = Array.isArray(body.extractionFields) ? (body.extractionFields as ExtractionField[]) : [];
  if (analyze && fields.length && transcript.trim()) {
    void runPostCallExtraction({
      callKey: `lk:${room}`,
      transcript,
      fields,
      agentName: String(body.agentName ?? "the agent"),
    });
  }

  // AI Call Summary — AWAITED before responding: on this serverless runtime a
  // fire-and-forget promise is frozen once the response is sent, so awaiting
  // is the only guaranteed way to finish. Generation is deadline-bounded
  // inside runCallSummaryForRow, the worker posts with a 60s timeout after the
  // caller already hung up, and runCallSummary itself skips when a summary
  // already exists (idempotent against re-posts).
  let summaryStatus = "skipped";
  if (analyze && saved.id) {
    const outcome = await runCallSummaryForRow({
      id: saved.id,
      summary: row.summary,
      transcript,
      messages: row.messages,
      structured_data: row.structured_data,
      agent_name: row.agent_name,
    });
    summaryStatus = outcome.status;
  }

  return NextResponse.json({ ok: true, extraction: analyze && fields.length ? "queued" : "skipped", summary: summaryStatus });
}
