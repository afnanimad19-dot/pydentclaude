import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { getLivekitCreds, lkConfigured, livekitAgentConfig, listCloudAgents, workerTokenConfigured, requestOrigin, boundLivekitAgent } from "@/lib/livekit";
import { splitSources } from "@/lib/kb-retrieval";
import { AGENT_TOOLS } from "@/lib/agent-config";

// Voice Agent alignment diagnostic — answers "is what Pydent shows for this
// agent actually what the LiveKit worker will run on the NEXT call?" by
// building the EXACT config object the worker fetches per call and reporting
// it alongside LiveKit/worker connectivity. Admin/developer use; no secrets.
//
//   GET /api/livekit/alignment?ws=<workspace id>&agent=<name or id>
export const runtime = "nodejs";

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function GET(req: NextRequest) {
  const ws = req.nextUrl.searchParams.get("ws") ?? "";
  const agentKey = req.nextUrl.searchParams.get("agent") ?? "";
  if (!ws || !agentKey) return NextResponse.json({ error: "Pass ?ws=<workspace id>&agent=<agent name or id>." }, { status: 400 });

  let q = supabase.from("agents").select("*").eq("workspace_id", ws).eq("kind", "voice");
  q = /^[0-9a-f-]{36}$/i.test(agentKey) ? q.eq("id", agentKey) : q.ilike("name", agentKey);
  const { data: rows } = await q.limit(1);
  const agent = rows?.[0];
  if (!agent) return NextResponse.json({ error: "Voice agent not found in this workspace." }, { status: 404 });

  // This is not a preview — it is the same function the per-call config
  // endpoint uses, so what it returns IS what the worker receives.
  const cfg: any = livekitAgentConfig(agent, ws, requestOrigin(req));

  const creds = await getLivekitCreds(ws);
  // Which LiveKit agent THIS Pydent agent actually dispatches to — the Pydent
  // worker, or a console/Builder agent it is explicitly bound to. Several
  // LiveKit agents can be deployed side by side (e.g. a Builder agent serving
  // production SIP and the Pydent worker serving test calls), so the check is
  // against the agent's real binding, never an assumption that only the
  // Pydent worker exists.
  const binding = boundLivekitAgent(agent, creds);
  let dispatchTargetDeployed: { agentName: string; status: string } | { error: string } | null = null;
  let pydentWorkerDeployed: { agentName: string; status: string } | { error: string } | null = null;
  if (lkConfigured(creds)) {
    try {
      const agents = await listCloudAgents(creds);
      const find = (name: string) => agents.find((a) => a.agentName === name);
      const boundHit = find(binding.name);
      dispatchTargetDeployed = boundHit
        ? { agentName: boundHit.agentName, status: boundHit.status }
        : { error: `No deployed agent named "${binding.name}" on the LiveKit project.` };
      const workerHit = find(creds.agentName);
      pydentWorkerDeployed = workerHit
        ? { agentName: workerHit.agentName, status: workerHit.status }
        : { error: `Pydent worker "${creds.agentName}" is not deployed on the LiveKit project.` };
    } catch (e) {
      const err = { error: e instanceof Error ? e.message.slice(0, 160) : "Could not list deployed agents." };
      dispatchTargetDeployed = err;
      pydentWorkerDeployed = err;
    }
  }

  const kb = String(agent.knowledge_base ?? "");
  const sources = splitSources(kb);
  const toolStates = AGENT_TOOLS.map((t) => ({ id: t.id, enabled: !!cfg.tools?.[t.id], always: !!t.always }));

  return NextResponse.json({
    agent: agent.name,
    agentId: agent.id,
    configVersion: cfg.configVersion,
    database: { loaded: true, status: agent.status },
    livekit: {
      configured: lkConfigured(creds),
      credentialSource: creds.source, // "workspace" | "env" | "none"
      // The LiveKit agent this Pydent agent dispatches to on a test call.
      // external=true means a console/Builder agent, not the Pydent worker —
      // the advanced settings/tools/KB below then do NOT apply to its calls.
      dispatch: { agentName: binding.name, external: binding.external, deployed: dispatchTargetDeployed },
      workerAgentName: creds.agentName,
      workerDeployed: pydentWorkerDeployed,
      workerTokenConfigured: await workerTokenConfigured(ws),
    },
    models: { stt: cfg.stt, sttLanguage: cfg.sttLanguage || "auto", llm: cfg.llm, tts: cfg.tts, voice: cfg.voice },
    conversation: { greetFirst: cfg.greetFirst, greeting: cfg.greeting, purpose: agent.purpose ?? "both", language: agent.language ?? "English" },
    prompt: {
      identity: !!agent.agent_identity,
      tasks: !!agent.instructions,
      styleGuardrails: !!agent.behavior,
      compiledChars: String(cfg.instructions ?? "").length,
    },
    knowledge: {
      totalChars: kb.length,
      sources: sources.map((s) => ({ name: s.name, chars: s.text.length })),
      websiteIndexed: sources.some((s) => /^Website page:/i.test(s.name) || /^Website /i.test(s.name)),
      inlinePromptChars: Math.min(kb.length, 48000),
      perTurnRetrievalTool: "search_knowledge (always registered)",
    },
    tools: toolStates,
    transfer: { number: cfg.transferNumber || null, enabled: !!cfg.tools?.transfer_call },
    vad: cfg.vad,
    turnDetection: cfg.turnDetection,
    interruptions: cfg.interruptionOptions ?? cfg.interruptions,
    noise: cfg.noise,
    backgroundAudio: cfg.backgroundAudio,
    amd: { ...cfg.amd, note: "runs on outbound calls only" },
    limits: cfg.limits,
    postCall: { extractionFields: (cfg.extractionFields ?? []).length, privacy: cfg.privacy?.dataStorage },
  });
}
