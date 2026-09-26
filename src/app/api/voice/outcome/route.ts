import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { validateStaffOutcome, buildStaffOutcomeUpdate, authorizeStaffOutcome } from "@/lib/staff-outcome";

// Save the staff-confirmed classification for one call (Stage B). The bearer
// token must be a valid Supabase session AND the call must belong to that
// user's workspace (foreign and unknown call ids both answer 404). Invalid
// outcome values are rejected. The update touches ONLY the staff_outcome*
// columns — the engine's `outcome`, the AI summary and structured_data are
// written by other, unrelated code paths and can never collide with this one.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const body = (await req.json().catch(() => ({}))) as { callId?: string; outcome?: unknown; note?: unknown };
  const callId = String(body.callId ?? "");

  // One token verification serves both the authorization check and the
  // author attribution (email) on the saved classification.
  let editor: { id: string; email?: string | null } | null = null;
  const auth = await authorizeStaffOutcome(
    {
      getUserId: async (t) => {
        const { data, error } = await supabaseAdmin.auth.getUser(t);
        const user = error ? null : data?.user ?? null;
        if (user) editor = { id: user.id, email: user.email };
        return user?.id ?? null;
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
  if (!editor) return NextResponse.json({ error: "Invalid session." }, { status: 401 });

  const parsed = validateStaffOutcome(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const update = buildStaffOutcomeUpdate(parsed.value, editor);
  const { error } = await supabaseAdmin.from("voice_calls").update(update).eq("id", callId);
  if (error) {
    // The Stage B columns come from migration 0062 — not applied yet on this DB.
    if (/staff_outcome/.test(error.message)) {
      return NextResponse.json(
        { error: "Staff outcome storage is missing — apply migration 0062_staff_call_outcome.sql first." },
        { status: 503 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    outcome: update.staff_outcome,
    note: update.staff_outcome_note,
    by: update.staff_outcome_by,
    at: update.staff_outcome_at,
  });
}
