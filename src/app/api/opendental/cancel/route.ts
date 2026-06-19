import { NextRequest, NextResponse } from "next/server";
import { odForward } from "@/lib/opendental-gateway";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { workspaceId, appointmentId } = body ?? {};
  if (!appointmentId) return NextResponse.json({ error: "appointmentId is required." }, { status: 400 });
  const { status, data } = await odForward(workspaceId ?? null, "/cancel-appointment", { method: "POST", body: { appointmentId } });
  return NextResponse.json(data, { status });
}
