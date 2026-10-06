import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { getLivekitCreds, lkConfigured, lkRoomName, mintRoomToken, builderMetadata, dispatchMetadata, boundLivekitAgent, requestOrigin } from "@/lib/livekit";
import { recordingEligible } from "@/lib/call-recording";
import { recordingEnv, startCallRecording } from "@/lib/call-recording-server";
import { normalizeVoiceSettings } from "@/lib/agent-config";
import { authorizeRequest } from "@/lib/server-auth-deps";

// Starts an in-browser LiveKit test call for an agent: creates a room name that
// carries the workspace, mints a join token whose room config auto-dispatches
// the agent's bound LiveKit agent (the Pydent worker, or an agent built in the
// LiveKit console), and hands the browser the URL + token. The API secret never
// leaves the server.
//
// AUTHENTICATION (fail closed): only a signed-in member of the agent's OWN
// workspace can start a test call — the session is verified BEFORE the agent
// row is read, and an agent outside the caller's workspace reads as not found.
//
// JOB METADATA: for the Pydent worker the dispatch metadata is only the ids
// ({ pydentAgentId, ws, source }) — the worker fetches the live config itself
// through the authenticated /api/livekit/agent-config, so the knowledge base
// never rides inside the join token handed to the browser. Only a console-built
// (Agent Builder) agent still receives the compiled instructions as metadata —
// that is its one configuration channel ({{metadata.instructions}}) — and that
// token now reaches only an authenticated member of the same workspace.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = await authorizeRequest(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { agentId } = await req.json().catch(() => ({}));
  if (!agentId) return NextResponse.json({ error: "agentId is required." }, { status: 400 });

  const { data: agent } = await supabase.from("agents").select("*").eq("id", agentId).maybeSingle();
  // An agent of another workspace answers exactly like a missing one.
  if (!agent || String(agent.workspace_id ?? "") !== auth.workspaceId) {
    return NextResponse.json({ error: "Agent not found." }, { status: 404 });
  }
  const ws = String(agent.workspace_id ?? "");
  const creds = await getLivekitCreds(ws);
  if (!lkConfigured(creds)) return NextResponse.json({ error: "LiveKit isn't configured — add your LiveKit URL, API key and secret in Settings → Connections → LiveKit." }, { status: 503 });

  const bound = boundLivekitAgent(agent, creds);
  const room = lkRoomName(ws, "test");
  const identity = `web-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const metadata = bound.external
      ? builderMetadata(agent, ws, requestOrigin(req), { source: "web-test" })
      : dispatchMetadata(String(agent.id), ws, { source: "web-test" });

    // Call recording (Stage C2): strictly opt-in per agent, enforced HERE on
    // the server (the browser cannot request it), worker-bound agents only.
    // Every failure degrades to an unrecorded call — never a broken one.
    const vs = normalizeVoiceSettings(agent.voice_settings);
    const eligible = recordingEligible({
      recordCalls: vs.recordCalls === true,
      dataStorage: vs.dataStorage,
      external: bound.external,
      envReady: recordingEnv() !== null,
    });
    let recording = "off";
    if (eligible.ok) {
      const started = await startCallRecording({ creds, ws, room, agentName: bound.name, metadata });
      recording = started.recording;
    }

    const token = await mintRoomToken(creds, room, identity, metadata, bound.name);
    return NextResponse.json({ ok: true, url: creds.url, token, room, agentName: agent.name, livekitAgent: bound.name, external: bound.external, recording });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not create the LiveKit session." }, { status: 500 });
  }
}
