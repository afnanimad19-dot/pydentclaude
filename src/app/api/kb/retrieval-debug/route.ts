import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { authorizeRequest } from "@/lib/server-auth-deps";
import { withKbAuth, kbRetrievalDebug, type DebugAgentRow } from "@/lib/kb-auth";

// Admin/diagnostic view of knowledge retrieval for one agent — makes "why did
// Sarah miss this fact?" answerable in seconds:
//
//   GET /api/kb/retrieval-debug?agent=<name or id>&q=<question>
//   Authorization: Bearer <session token>
//
// The workspace comes from the caller's session (a ?ws= that differs is
// refused), and the agent lookup is scoped to it, so no other workspace's
// knowledge can be inspected. Returns source names, counts and short previews
// only — never patient data or secrets.
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  return withKbAuth(() => authorizeRequest(req), async ({ workspaceId }) => {
    const sp = req.nextUrl.searchParams;
    const out = await kbRetrievalDebug(
      async (ws, key) => {
        let query = supabase.from("agents").select("id, name, workspace_id, knowledge_base, kb_files").eq("workspace_id", ws);
        query = key.id ? query.eq("id", key.id) : query.ilike("name", String(key.name ?? ""));
        const { data, error } = await query.limit(1);
        if (error) return null;
        return (data?.[0] as DebugAgentRow | undefined) ?? null;
      },
      { workspaceId, requestedWs: sp.get("ws"), agentKey: sp.get("agent") ?? "", q: sp.get("q") ?? "" }
    );
    return NextResponse.json(out.body, { status: out.status });
  });
}
