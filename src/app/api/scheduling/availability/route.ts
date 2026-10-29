import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/server-auth-deps";
import { getDoctorAvailability, realAvailabilityDeps } from "@/lib/availability-server";

// GET /api/scheduling/availability?doctor=…&date=YYYY-MM-DD[&date_end=…][&duration=30]
//
// One doctor's open appointment start times from live calendar free/busy data
// (read-only). Tenant-secured: the workspace comes from the verified session,
// never from the request; results never contain credentials, calendar ids, or
// event details (FreeBusy has none). A failed upstream call returns
// success:false with a machine-readable error — never an empty "fully booked"
// calendar.
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await authorizeRequest(req);
  if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });

  const p = req.nextUrl.searchParams;
  const doctor = (p.get("doctor") ?? "").trim();
  const date = (p.get("date") ?? "").trim();
  if (!doctor || !date) {
    return NextResponse.json({ success: false, error: "invalid_request", detail: "doctor and date are required." }, { status: 400 });
  }

  const result = await getDoctorAvailability(realAvailabilityDeps, auth.workspaceId, {
    doctor,
    date,
    dateEnd: p.get("date_end") ?? undefined,
    durationMin: p.get("duration") ?? undefined,
  });
  // 200 with success:false — the request was valid; availability is what failed.
  return NextResponse.json(result, { status: result.error === "invalid_date" ? 400 : 200 });
}
