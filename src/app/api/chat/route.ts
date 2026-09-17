import { NextRequest, NextResponse } from "next/server";
import { generateAgentReply } from "@/lib/agent-reply";

// Generates an AI reply for a chat agent through the shared gateway
// (OpenRouter or LiveKit Inference, per the agent's model). Pass debug:true
// (used by the dashboard's Test Chat, behind login) to also get retrieval
// metadata — which knowledge sources/chunks were supplied, with scores; never
// the knowledge text itself and never any secrets.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const result = await generateAgentReply(body);
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ reply: result.reply, ...(body.debug ? { retrieval: result.retrieval } : {}) });
}
