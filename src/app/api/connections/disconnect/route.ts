import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/server-auth-deps";
import { ADMIN_ROLES } from "@/lib/server-auth";
import { disconnectGoogle, realOAuthFlowDeps, GOOGLE_SCOPES } from "@/lib/google-oauth-flow";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";

// Disconnect a provider (GC-1 hardened): requires a signed-in workspace
// OWNER/ADMIN; the workspace always comes from the verified session — the
// previous unauthenticated handler that trusted a workspaceId in the body is
// REMOVED, so one tenant can never sever another tenant's integrations.
//
// Google providers additionally get best-effort token revocation at Google
// before the stored rows are deleted (a revocation failure never blocks the
// local disconnect, and is reported in the response).
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = await authorizeRequest(req, {
    allowedRoles: ADMIN_ROLES,
    roleError: "Only a workspace owner or admin can disconnect integrations.",
  });
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { provider } = await req.json().catch(() => ({}));
  if (!provider || typeof provider !== "string") {
    return NextResponse.json({ error: "provider is required." }, { status: 400 });
  }

  if (provider in GOOGLE_SCOPES) {
    const r = await disconnectGoogle(realOAuthFlowDeps(), { ws: auth.workspaceId, provider });
    return NextResponse.json({ ok: true, revoked: r.revoked });
  }

  // Non-Google providers: same row cleanup, scoped to the session workspace.
  await supabase.from("oauth_tokens").delete().eq("workspace_id", auth.workspaceId).eq("provider", provider);
  await supabase.from("connections").delete().eq("workspace_id", auth.workspaceId).eq("provider", provider);
  return NextResponse.json({ ok: true });
}
