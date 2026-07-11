import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// Rename the caller's clinic workspace. RLS only grants SELECT on workspaces,
// so the rename runs with the service role — but ONLY after verifying the
// bearer token belongs to a member of that workspace (no cross-tenant renames).
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  const userId = userData?.user?.id;
  if (userErr || !userId) return NextResponse.json({ error: "Invalid session." }, { status: 401 });

  const { name } = (await req.json().catch(() => ({}))) as { name?: string };
  const trimmed = String(name ?? "").trim().slice(0, 120);
  if (!trimmed) return NextResponse.json({ error: "Enter a clinic name." }, { status: 400 });

  const { data: profile } = await supabaseAdmin.from("profiles").select("workspace_id").eq("user_id", userId).maybeSingle();
  if (!profile?.workspace_id) return NextResponse.json({ error: "No workspace for this account." }, { status: 400 });

  const { error } = await supabaseAdmin.from("workspaces").update({ name: trimmed }).eq("id", profile.workspace_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
