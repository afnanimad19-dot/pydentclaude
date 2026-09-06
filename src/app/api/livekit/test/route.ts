import { NextRequest, NextResponse } from "next/server";
import { getLivekitCreds, lkConfigured, lkSipDomain, roomService, listCloudAgents, type CloudAgentInfo } from "@/lib/livekit";

// Settings → LiveKit "Test connection": proves the URL + API key/secret work by
// listing rooms through the server API, and reports the project's SIP domain
// (what a carrier / PBX dials into) plus the worker agent name in use.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { ws } = await req.json().catch(() => ({}));
  const creds = await getLivekitCreds(ws ? String(ws) : null);
  if (!lkConfigured(creds)) return NextResponse.json({ ok: false, error: "LiveKit isn't configured — paste the WebSocket URL, API key and API secret from your LiveKit project and save." });
  try {
    const rooms = await roomService(creds).listRooms();
    // Also list the agents deployed on the project (best-effort) so the card
    // shows what will answer calls — the Pydent worker and/or console-built ones.
    let agents: CloudAgentInfo[] = [];
    let agentsError = "";
    try { agents = await listCloudAgents(creds); } catch (e) { agentsError = e instanceof Error ? e.message : "could not list agents"; }
    return NextResponse.json({
      ok: true,
      source: creds.source,
      rooms: rooms.length,
      sipDomain: lkSipDomain(creds.url),
      agentName: creds.agentName,
      workerToken: !!(process.env.LIVEKIT_WORKER_TOKEN || "").trim(),
      agents,
      agentsError: agentsError || undefined,
      workerDeployed: agents.some((a) => a.agentName === creds.agentName),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "LiveKit rejected the credentials";
    return NextResponse.json({ ok: false, error: /401|403|unauth|invalid/i.test(msg) ? `LiveKit rejected the API key/secret (${msg}).` : `Could not reach LiveKit at ${creds.url} — ${msg}` });
  }
}
