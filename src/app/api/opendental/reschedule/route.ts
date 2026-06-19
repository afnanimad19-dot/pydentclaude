import { NextRequest, NextResponse } from "next/server";
import { odForward } from "@/lib/opendental-gateway";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { workspaceId, appointmentId, datetime } = body ?? {};
  if (!appointmentId || !datetime) return NextResponse.json({ error: "appointmentId and datetime are required." }, { status: 400 });
  const { status, data } = await odForward(workspaceId ?? null, "/reschedule-appointment", { method: "POST", body: { appointmentId, datetime } });
  return NextResponse.json(data, { status });
}
