import { NextResponse, type NextRequest } from "next/server";
import { authorizeRequest, serviceRoleConfigured } from "@/lib/server-auth-deps";
import { makeRoutingDeps, RoutingMigrationMissing } from "@/lib/number-routing-server";
import { requestOrigin } from "@/lib/livekit";
import type { RoutingDeps, RoutingOutcome } from "@/lib/number-routing";

// Shared plumbing for the /api/voice-numbers/[id]/* routes: authorization
// (workspace ALWAYS from the bearer token), service-role requirement, and a
// clear 503 when migration 0064 has not been applied yet.
export async function withRouting(
  req: NextRequest,
  opts: { requireAdmin: boolean },
  run: (ctx: { ws: string; userId: string; deps: RoutingDeps }) => Promise<RoutingOutcome | { httpStatus: number; body: unknown }>
) {
  const auth = await authorizeRequest(req, { requireAdmin: opts.requireAdmin });
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  if (!serviceRoleConfigured()) {
    return NextResponse.json({ ok: false, error: "Server is missing SUPABASE_SERVICE_ROLE_KEY — routing changes are disabled." }, { status: 503 });
  }
  try {
    const deps = await makeRoutingDeps(auth.workspaceId, requestOrigin(req));
    const out = await run({ ws: auth.workspaceId, userId: auth.userId, deps });
    return NextResponse.json(out.body, { status: out.httpStatus });
  } catch (e) {
    if (e instanceof RoutingMigrationMissing) return NextResponse.json({ ok: false, code: "migration_missing", error: e.message }, { status: 503 });
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message.slice(0, 300) : "Routing request failed." }, { status: 500 });
  }
}
