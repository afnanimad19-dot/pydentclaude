import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { getLivekitCreds, lkConfigured, lkRoomName, mintRoomToken, builderMetadata, boundLivekitAgent, requestOrigin } from "@/lib/livekit";

// Starts an in-browser LiveKit test call for an agent: creates a room name that
// carries the workspace, mints a join token whose room config auto-dispatches
// the agent's bound LiveKit agent (the Pydent worker, or an agent built in the
// LiveKit console) with the agent's LIVE instructions/greeting as job metadata,
// and hands the browser the URL + token. The API secret never leaves the server.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { agentId } = await req.json().catch(() => ({}));
  if (!agentId) return NextResponse.json({ error: "agentId is required." }, { status: 400 });

  const { data: agent } = await supabase.from("agents").select("*").eq("id", agentId).maybeSingle();
  if (!agent) return NextResponse.json({ error: "Agent not found." }, { status: 404 });
  const ws = String(agent.workspace_id ?? "");
  const creds = await getLivekitCreds(ws);
  if (!lkConfigured(creds)) return NextResponse.json({ error: "LiveKit isn't configured — add your LiveKit URL, API key and secret in Settings → Connections → LiveKit." }, { status: 503 });

  const bound = boundLivekitAgent(agent, creds);
  const room = lkRoomName(ws, "test");
  const identity = `web-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const metadata = builderMetadata(agent, ws, requestOrigin(req), { source: "web-test" });
    const token = await mintRoomToken(creds, room, identity, metadata, bound.name);
    return NextResponse.json({ ok: true, url: creds.url, token, room, agentName: agent.name, livekitAgent: bound.name, external: bound.external });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not create the LiveKit session." }, { status: 500 });
  }
}
