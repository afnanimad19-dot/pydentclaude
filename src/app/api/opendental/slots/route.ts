import { NextRequest, NextResponse } from "next/server";
import { odForward } from "@/lib/opendental-gateway";

// Returns available appointment slots for a doctor + service + date.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { workspaceId, doctorId, serviceId, date } = body ?? {};
  if (!doctorId || !serviceId || !date) {
    return NextResponse.json({ error: "doctorId, serviceId and date are required." }, { status: 400 });
  }
  const { status, data } = await odForward(workspaceId ?? null, "/available-slots", { method: "POST", body: { doctorId, serviceId, date } });
  return NextResponse.json(data, { status });
}
