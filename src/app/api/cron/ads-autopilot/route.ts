import { NextRequest, NextResponse } from "next/server";
import { runAdsAutopilot } from "@/lib/ads-autopilot";

// Meta ads recommendation autopilot — also runs as part of /api/cron/run, this
// standalone route exists for a dedicated schedule or a manual kick.
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.nextUrl.searchParams.get("key") !== secret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const r = await runAdsAutopilot(req.nextUrl.origin);
  return NextResponse.json(r);
}
