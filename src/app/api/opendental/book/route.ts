import { NextRequest, NextResponse } from "next/server";
import { odForward } from "@/lib/opendental-gateway";

// Creates an appointment in Open Dental via the clinic middleware. Only scheduling
// + contact fields are sent — never clinical data.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { workspaceId, name, phone, email, doctorId, serviceId, datetime, consent } = body ?? {};
  if (!name || !phone || !doctorId || !serviceId || !datetime) {
    return NextResponse.json({ error: "name, phone, doctorId, serviceId and datetime are required." }, { status: 400 });
  }
  const { status, data } = await odForward(workspaceId ?? null, "/create-appointment", {
    method: "POST",
    body: { name, phone, email: email ?? "", doctorId, serviceId, datetime, consent: !!consent },
  });
  return NextResponse.json(data, { status });
}
