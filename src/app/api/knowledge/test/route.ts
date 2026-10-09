import type { NextRequest } from "next/server";
import { knowledgeDeps, knowledgeTesterChat } from "@/lib/knowledge-server";
import { withKnowledge } from "@/lib/knowledge-route";
import { testKnowledge } from "@/lib/knowledge-tester";

// Knowledge Tester (any workspace member). Body: { resourceIds, question }.
// Searches ONLY the selected Central KB resources of the caller's session
// workspace and, when configured, answers from them with a neutral prompt.
// Not used by any agent.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  return withKnowledge(knowledgeDeps(req), "read", "test", ({ ws, store, log }) => testKnowledge(store, ws, body, knowledgeTesterChat(), log));
}
