import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/server-auth-deps";
import { getClinicAvailability, realAvailabilityDeps } from "@/lib/availability-server";

// GET /api/scheduling/clinic-availability?date=YYYY-MM-DD[&duration=30][&doctors=a,b]
//
// Open start times for every configured doctor of the authenticated clinic on
// one date — a single batched FreeBusy query mapped back per doctor, with
// per-calendar failures isolated (one broken calendar never hides the rest).
// Tenant-secured like /api/scheduling/availability.
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await authorizeRequest(req);
  if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });

  const p = req.nextUrl.searchParams;
  const date = (p.get("date") ?? "").trim();
  if (!date) return NextResponse.json({ success: false, error: "invalid_request", detail: "date is required." }, { status: 400 });
  const doctors = (p.get("doctors") ?? "").split(",").map((d) => d.trim()).filter(Boolean);

  const result = await getClinicAvailability(realAvailabilityDeps, auth.workspaceId, {
    date,
    durationMin: p.get("duration") ?? undefined,
    doctors: doctors.length ? doctors : undefined,
  });
  return NextResponse.json(result, { status: result.error === "invalid_date" ? 400 : 200 });
}
