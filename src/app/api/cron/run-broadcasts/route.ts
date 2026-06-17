import { NextRequest, NextResponse } from "next/server";
import { runDueBroadcasts } from "@/lib/broadcast-runner";

// Fires any scheduled broadcasts whose time has arrived. Called on a schedule by
// the Netlify scheduled function (or any external cron). Protected by CRON_SECRET
// when that env var is set.
async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const provided = req.headers.get("x-cron-secret") ?? req.nextUrl.searchParams.get("secret");
    if (provided !== secret) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const res = await runDueBroadcasts();
  return NextResponse.json({ ok: true, ...res });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
