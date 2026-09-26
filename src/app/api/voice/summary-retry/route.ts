import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { authorizeSummaryRetry } from "@/lib/call-summary";
import { runCallSummaryForRow } from "@/lib/call-summary-server";

// Regenerate the AI Call Summary for one stored call — the Retry action on the
// Call Details page. Authenticated and workspace-authorized: the bearer token
// must be a valid Supabase session AND the call must belong to that user's
// workspace (foreign call ids answer 404, indistinguishable from missing).
// Only calls WITHOUT a summary are regenerated — an existing summary (Vapi or
// AI) is never overwritten — and generation uses ONLY the stored transcript /
// messages and recorded tool results: a call with no stored transcript fails
// gracefully instead of inventing one.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const body = (await req.json().catch(() => ({}))) as { callId?: string };
  const callId = String(body.callId ?? "");

  const auth = await authorizeSummaryRetry(
    {
      getUserId: async (t) => {
        const { data, error } = await supabaseAdmin.auth.getUser(t);
        return error ? null : data?.user?.id ?? null;
      },
      getProfileWorkspace: async (userId) => {
        const { data } = await supabaseAdmin.from("profiles").select("workspace_id").eq("user_id", userId).maybeSingle();
        return data?.workspace_id ?? null;
      },
      getCallWorkspace: async (id) => {
        const { data } = await supabaseAdmin.from("voice_calls").select("workspace_id").eq("id", id).maybeSingle();
        return data?.workspace_id ?? null;
      },
    },
    token,
    callId
  );
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { data: row, error } = await supabaseAdmin
    .from("voice_calls")
    .select("id, summary, transcript, messages, structured_data, agent_name")
    .eq("id", callId)
    .maybeSingle();
  if (error || !row) return NextResponse.json({ error: "Call not found." }, { status: 404 });

  // A retry is an explicit user action: a stale "processing" marker from a
  // frozen earlier run must not block it, so it is cleared by regenerating —
  // runCallSummary treats only a FRESH processing marker as in-progress.
  const outcome = await runCallSummaryForRow(row);
  if (outcome.status === "available") return NextResponse.json({ ok: true, status: "available", summary: outcome.summary });
  if (outcome.status === "skipped") return NextResponse.json({ ok: true, status: "skipped", reason: outcome.reason });
  return NextResponse.json({ ok: false, status: "failed", reason: outcome.reason });
}
