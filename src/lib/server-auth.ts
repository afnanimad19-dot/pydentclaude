// Server-side request authorization for workspace-scoped API routes — pure
// logic with injected lookups (bound to Supabase in server-auth-deps.ts), so
// it is unit-testable without a database.
//
// The workspace is ALWAYS derived from the caller's verified session: bearer
// token → Supabase user → the user's ACTIVE workspace (profiles.workspace_id)
// → confirmed membership of that workspace. A `ws` value supplied by the
// browser is never trusted; routes ignore it.
//
// Roles: provider-routing mutations (creating / deleting trunks and dispatch
// rules, registering or reassigning numbers) require an ADMIN role. Admin =
// workspace_members.role, or for invited staff team_members.role, in
// ADMIN_ROLES. Reads (routing status, deployed-agent lists) require only
// membership.

export const ADMIN_ROLES: readonly string[] = ["owner", "admin"];

export interface WorkspaceAuthDeps {
  /** Verify a Supabase access token; the user id, or null when invalid/expired. */
  getUserId: (token: string) => Promise<string | null>;
  /** The user's ACTIVE workspace (profiles.workspace_id), or null. */
  getActiveWorkspace: (userId: string) => Promise<string | null>;
  /** The user's role in that workspace (membership / invite), or null when not a member. */
  getMembershipRole: (userId: string, workspaceId: string) => Promise<string | null>;
}

export type WorkspaceAuthResult =
  | { ok: true; userId: string; workspaceId: string; role: string; isAdmin: boolean }
  | { ok: false; status: 401 | 403; error: string };

export function bearerToken(authorization: string | null | undefined): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(String(authorization ?? "").trim());
  return m ? m[1].trim() || null : null;
}

export function isAdminRole(role: string | null | undefined): boolean {
  return !!role && ADMIN_ROLES.includes(String(role).toLowerCase());
}

export async function authorizeWorkspaceRequest(
  deps: WorkspaceAuthDeps,
  token: string | null | undefined,
  opts: { requireAdmin?: boolean } = {}
): Promise<WorkspaceAuthResult> {
  if (!token) return { ok: false, status: 401, error: "Sign in first." };
  let userId: string | null = null;
  try {
    userId = await deps.getUserId(token);
  } catch {
    userId = null;
  }
  if (!userId) return { ok: false, status: 401, error: "Invalid or expired session." };
  const workspaceId = await deps.getActiveWorkspace(userId);
  if (!workspaceId) return { ok: false, status: 403, error: "No active workspace for this account." };
  const role = await deps.getMembershipRole(userId, workspaceId);
  if (!role) return { ok: false, status: 403, error: "You are not a member of this workspace." };
  const isAdmin = isAdminRole(role);
  if (opts.requireAdmin && !isAdmin) {
    return { ok: false, status: 403, error: "Only a workspace owner or admin can change phone-number routing." };
  }
  return { ok: true, userId, workspaceId, role, isAdmin };
}
