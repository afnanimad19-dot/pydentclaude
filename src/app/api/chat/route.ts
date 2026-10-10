import { NextRequest, NextResponse } from "next/server";
import { generateAgentReply } from "@/lib/agent-reply";
import { authorizeRequest } from "@/lib/server-auth-deps";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { centralRetrievalForReply } from "@/lib/agent-tools-core";
import { buildChatInput, consumeRateLimit, type RateWindow, type ServerChatAgent } from "@/lib/chat-route-lib";
import type { RetrievalResult } from "@/lib/kb-retrieval";

// Generates an AI reply for a chat agent through the shared gateway
// (OpenRouter or LiveKit Inference, per the agent's model), used by the
// dashboard (Test Chat, Inbox AI reply, Team AI) behind login.
//
// HARDENED (Phase 2C): the caller must be a signed-in workspace member
// (authorizeRequest — bearer token → user → ACTIVE workspace → membership),
// the workspace is ALWAYS the session's (a ws sent by the page is ignored),
// and Central
// Knowledge flows only for an `agentId` the server itself loads from that
// workspace. Draft agent fields from the body remain testable — they grant
// nothing. Per-user rate limiting bounds runaway loops and credit abuse.
// Pass debug:true to also get retrieval metadata — which knowledge
// sources/chunks were supplied, with scores; never the knowledge text itself
// and never any secrets.
export const runtime = "nodejs";

const rateStore = new Map<string, RateWindow>();

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const auth = await authorizeRequest(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!consumeRateLimit(rateStore, auth.userId, Date.now())) {
    return NextResponse.json({ error: "Too many chat requests — wait a minute and try again." }, { status: 429 });
  }

  // Central Knowledge: ONLY via a server-side load of the agent from the
  // SESSION workspace. A foreign or unknown id is a 404; no id means a draft
  // test (legacy knowledgeBase path only).
  let serverAgent: ServerChatAgent | null = null;
  let retrieval: RetrievalResult | null = null;
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  if (agentId) {
    let row: ServerChatAgent | null = null;
    try {
      const { data, error } = await supabase
        .from("agents")
        .select("id, workspace_id, name, knowledge_base")
        .eq("workspace_id", auth.workspaceId)
        .eq("id", agentId)
        .maybeSingle();
      row = error ? null : ((data as ServerChatAgent | null) ?? null);
    } catch {
      row = null; // a malformed UUID rejects the query — same as no match
    }
    if (!row) return NextResponse.json({ error: "No such agent in your workspace." }, { status: 404 });
    serverAgent = row;
    const central = await centralRetrievalForReply(serverAgent, Array.isArray(body.messages) ? (body.messages as { role: string; content: string }[]) : [], "chat");
    if (central) retrieval = central.retrieval;
  }

  const result = await generateAgentReply(buildChatInput(body, auth.workspaceId, serverAgent, retrieval));
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ reply: result.reply, ...(body.debug ? { retrieval: result.retrieval } : {}) });
}
