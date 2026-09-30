import type { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { authorizeWorkspaceRequest, bearerToken, type WorkspaceAuthDeps, type WorkspaceAuthResult } from "@/lib/server-auth";

// Supabase bindings for lib/server-auth.ts (server-only: uses the service-role
// client). Membership comes from workspace_members; staff invited by email
// (team_members, joined via /api/auth/bootstrap) resolve through their ACTIVE
// invite for that workspace.
export const workspaceAuthDeps: WorkspaceAuthDeps = {
  getUserId: async (token) => {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    return error ? null : data?.user?.id ?? null;
  },
  getActiveWorkspace: async (userId) => {
    const { data } = await supabaseAdmin.from("profiles").select("workspace_id").eq("user_id", userId).maybeSingle();
    return data?.workspace_id ? String(data.workspace_id) : null;
  },
  getMembershipRole: async (userId, workspaceId) => {
    const { data: m } = await supabaseAdmin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .maybeSingle();
    if (m?.role) return String(m.role);
    const { data: u } = await supabaseAdmin.auth.admin.getUserById(userId).catch(() => ({ data: null }));
    const email = String(u?.user?.email ?? "").toLowerCase();
    if (!email) return null;
    const { data: t } = await supabaseAdmin
      .from("team_members")
      .select("role, status")
      .eq("workspace_id", workspaceId)
      .eq("email", email)
      .limit(1)
      .maybeSingle();
    return t && t.status === "active" && t.role ? String(t.role) : null;
  },
};

/** Authorize an incoming route request from its Authorization header. */
export function authorizeRequest(
  req: NextRequest,
  opts: { requireAdmin?: boolean; allowedRoles?: readonly string[]; roleError?: string } = {}
): Promise<WorkspaceAuthResult> {
  return authorizeWorkspaceRequest(workspaceAuthDeps, bearerToken(req.headers.get("authorization")), opts);
}

/** True when the server can write with the service role (RLS-bypassing, required for routing changes). */
export function serviceRoleConfigured(): boolean {
  return !!(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
}
