import type { NextRequest } from "next/server";
import { knowledgeDeps } from "@/lib/knowledge-server";
import { withKnowledge } from "@/lib/knowledge-route";
import { refreshResource } from "@/lib/knowledge-service";

// Manual refresh of a URL resource's addresses (owner/manager). Phase A: on
// demand only — no scheduled refresh. Failed pages keep their last good content.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withKnowledge(knowledgeDeps(req), "write", "refresh", ({ ws, userId, store, importSite, now }) => refreshResource(store, ws, userId, id, importSite, now));
}
