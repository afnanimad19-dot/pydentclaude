import { NextRequest, NextResponse } from "next/server";
import { publishOneNow } from "@/lib/ig-publish-runner";

// "Publish now" for a single content-calendar post — publishes to all its
// selected platforms immediately instead of waiting for the scheduled time.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { postId, ws } = await req.json().catch(() => ({}));
  if (!postId || !ws) return NextResponse.json({ ok: false, error: "postId and ws are required." }, { status: 400 });
  const r = await publishOneNow(String(postId), String(ws));
  return NextResponse.json(r, { status: r.ok ? 200 : 502 });
}
