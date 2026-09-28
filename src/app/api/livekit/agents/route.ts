import { NextRequest, NextResponse } from "next/server";
import { getLivekitCreds, lkConfigured, listCloudAgents } from "@/lib/livekit";
import { authorizeRequest } from "@/lib/server-auth-deps";

// Lists the agents deployed on the workspace's LiveKit project (the ones you
// built/deployed in the LiveKit console, plus the Pydent worker) so a Pydent
// agent can be bound to one, or an existing LiveKit agent can be imported.
// Workspace members only; the workspace comes from the bearer token (a `ws`
// query parameter is ignored).
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await authorizeRequest(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error, agents: [] }, { status: auth.status });
  const creds = await getLivekitCreds(auth.workspaceId);
  if (!lkConfigured(creds)) return NextResponse.json({ ok: false, error: "LiveKit isn't configured for this workspace.", agents: [] });
  try {
    const agents = await listCloudAgents(creds);
    return NextResponse.json({ ok: true, workerAgentName: creds.agentName, agents });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Could not list LiveKit agents.", agents: [], workerAgentName: creds.agentName });
  }
}
