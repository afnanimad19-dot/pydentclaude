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
    if (existing?.workspace_id) {
      // SELF-HEAL for legacy accounts: before the isolation fix, some accounts
      // were left pointing at ANOTHER user's workspace (they saw that clinic's
      // data). If this user is not the workspace's original owner and was never
      // invited as a team member, detach them into a fresh, empty workspace.
      // The original owner's account and data are never touched.
      const { data: members } = await db.from("profiles").select("user_id, created_at").eq("workspace_id", existing.workspace_id).order("created_at").limit(1);
      const owner = members?.[0];
      if (owner && owner.user_id !== user.id) {
        const email0 = (user.email ?? "").toLowerCase();
        const { data: invite } = email0
          ? await db.from("team_members").select("id").eq("workspace_id", existing.workspace_id).eq("email", email0).limit(1).maybeSingle()
          : { data: null };
        if (!invite) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const freshName = (user.user_metadata as any)?.clinic_name || user.email || "My clinic";
          const { data: fresh } = await db.from("workspaces").insert({ name: freshName }).select("id").single();
          if (fresh?.id) {
            await db.from("profiles").update({ workspace_id: fresh.id }).eq("user_id", user.id);
            return NextResponse.json({ workspaceId: fresh.id, healed: true });
          }
        }
      }
      return NextResponse.json({ workspaceId: existing.workspace_id });
    }

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
