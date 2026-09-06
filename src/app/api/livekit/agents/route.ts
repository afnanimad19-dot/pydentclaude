import { NextRequest, NextResponse } from "next/server";
import { getLivekitCreds, lkConfigured, listCloudAgents } from "@/lib/livekit";

// Lists the agents deployed on the workspace's LiveKit project (the ones you
// built/deployed in the LiveKit console, plus the Pydent worker) so a Pydent
// agent can be bound to one, or an existing LiveKit agent can be imported.
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const ws = req.nextUrl.searchParams.get("ws") ?? "";
  const creds = await getLivekitCreds(ws || null);
  if (!lkConfigured(creds)) return NextResponse.json({ ok: false, error: "LiveKit isn't configured for this workspace.", agents: [] });
  try {
    const agents = await listCloudAgents(creds);
    return NextResponse.json({ ok: true, workerAgentName: creds.agentName, agents });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Could not list LiveKit agents.", agents: [], workerAgentName: creds.agentName });
  }
}
