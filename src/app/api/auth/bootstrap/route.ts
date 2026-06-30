import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Guarantees every signed-in user has their OWN workspace + profile, regardless of
// whether the DB trigger ran. If the user was INVITED to an existing clinic
// (team_members has their email), they join that workspace; otherwise they get a
// brand-new, empty workspace. Never returns another tenant's workspace by accident.
export const runtime = "nodejs";

function admin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://mzqynjywncbvqfikbzgm.supabase.co";
  return key ? createClient(url, key) : null;
}

export async function POST(req: NextRequest) {
  const db = admin();
  if (!db) return NextResponse.json({ error: "Server not configured (SUPABASE_SERVICE_ROLE_KEY)." }, { status: 503 });

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return NextResponse.json({ error: "Missing auth token." }, { status: 401 });

  // Verify the JWT → the real user (can't be spoofed; the service role validates it).
  const { data: u, error: uErr } = await db.auth.getUser(token);
  const user = u?.user;
  if (uErr || !user) return NextResponse.json({ error: "Invalid session." }, { status: 401 });

  try {
    // Already provisioned?
    const { data: existing } = await db.from("profiles").select("workspace_id").eq("user_id", user.id).maybeSingle();
    if (existing?.workspace_id) return NextResponse.json({ workspaceId: existing.workspace_id });

    const email = user.email ?? "";
    // Invited to an existing clinic? Join it (don't create a new empty one).
    if (email) {
      const { data: invite } = await db.from("team_members").select("workspace_id, id").eq("email", email.toLowerCase()).limit(1).maybeSingle();
      if (invite?.workspace_id) {
        await db.from("profiles").upsert({ user_id: user.id, workspace_id: invite.workspace_id, email }, { onConflict: "user_id" });
        await db.from("team_members").update({ status: "active" }).eq("id", invite.id);
        return NextResponse.json({ workspaceId: invite.workspace_id });
      }
    }

    // Otherwise: a fresh, isolated workspace for this user.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const name = (user.user_metadata as any)?.clinic_name || email || "My clinic";
    const { data: ws, error: wErr } = await db.from("workspaces").insert({ name }).select("id").single();
    if (wErr || !ws) return NextResponse.json({ error: wErr?.message ?? "Could not create workspace." }, { status: 500 });
    await db.from("profiles").upsert({ user_id: user.id, workspace_id: ws.id, email }, { onConflict: "user_id" });
    return NextResponse.json({ workspaceId: ws.id });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Bootstrap failed." }, { status: 500 });
  }
}
