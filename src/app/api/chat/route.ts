import { NextRequest, NextResponse } from "next/server";
import { generateAgentReply } from "@/lib/agent-reply";

// Generates an AI reply for a chat agent (OpenRouter behind the scenes).
export async function POST(req: NextRequest) {
  const body = await req.json();
  const result = await generateAgentReply(body);
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ reply: result.reply });
}
