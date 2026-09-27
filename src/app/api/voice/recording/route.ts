import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { authorizeRecordingAccess, recordingView } from "@/lib/call-recording";
import { recordingReadUrl } from "@/lib/call-recording-server";

// Authenticated recording access (Stage C2). The recordings live in a PRIVATE
// Azure container — this route is the only way to reach one: valid session,
// call must belong to the caller's workspace (foreign/unknown ids answer 404),
// and the response is a short-lived, blob-scoped, read-only SAS URL. Nothing
// public is ever stored or returned, and the account key never leaves the
// server. Vapi recordings keep their own recording_url path and never hit
// this route.
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const callId = String(req.nextUrl.searchParams.get("callId") ?? "");
  const download = req.nextUrl.searchParams.get("download") === "1";

  const auth = await authorizeRecordingAccess(
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

  const { data: row } = await supabaseAdmin
    .from("voice_calls")
    .select("id, recording_path, recording_status")
    .eq("id", callId)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "Call not found." }, { status: 404 });

  const view = recordingView({
    recordingStatus: String(row.recording_status ?? ""),
    recordingPath: String(row.recording_path ?? ""),
  });
  if (view !== "complete") {
    return NextResponse.json({ error: "No playable recording for this call.", status: view }, { status: 404 });
  }

  const signed = recordingReadUrl(String(row.recording_path), {
    download,
    filename: `call-${callId}.ogg`,
  });
  if (!signed) return NextResponse.json({ error: "Recording storage is not configured." }, { status: 503 });
  return NextResponse.json({ ok: true, url: signed.url, expiresAt: signed.expiresAt });
}
