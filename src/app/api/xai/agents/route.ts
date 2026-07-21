import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { syncXaiAgent } from "@/lib/xai-voice";

// Mirrors a Pydent voice agent into the xAI console (Voice → Agents) so the
// clinic can see it there and deploy it to a phone number from xAI's side.
// Called after every voice-agent save when the xAI engine is selected.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { agentId } = await req.json().catch(() => ({}));
  if (!agentId) return NextResponse.json({ error: "agentId is required." }, { status: 400 });

  const { data: agent } = await supabase.from("agents").select("*").eq("id", agentId).maybeSingle();
  if (!agent) return NextResponse.json({ error: "Agent not found." }, { status: 404 });

  const existing: string | null = agent.xai_agent_id || null;
  const res = await syncXaiAgent(agent, existing);
  if (!res.ok) return NextResponse.json({ error: res.error ?? "xAI sync failed." }, { status: 502 });

  // Remember the console agent id so the next save UPDATES instead of
  // duplicating. Tolerant: the column arrives with migration 0057.
  if (res.id && res.id !== existing) {
    const { error } = await supabase.from("agents").update({ xai_agent_id: res.id }).eq("id", agentId);
    if (error && !/xai_agent_id/.test(error.message)) console.error("xai id store failed", error.message);
  }
  return NextResponse.json({ ok: true, id: res.id ?? existing ?? null });
}
