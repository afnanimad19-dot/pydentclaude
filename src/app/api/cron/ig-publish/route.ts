import { NextRequest, NextResponse } from "next/server";
import { runDueIgPosts } from "@/lib/ig-publish-runner";

// Publishes scheduled Instagram posts whose time has arrived. Point a scheduler
// at this (the Netlify ig-publish-cron function does, every 5 min). Protected by
// CRON_SECRET via the x-cron-secret header or ?secret=/?key= query when set.
export const runtime = "nodejs";
export const maxDuration = 300;

async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const provided = req.headers.get("x-cron-secret") ?? req.nextUrl.searchParams.get("secret") ?? req.nextUrl.searchParams.get("key");
    if (provided !== secret) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const res = await runDueIgPosts();
  return NextResponse.json(res);
}

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
