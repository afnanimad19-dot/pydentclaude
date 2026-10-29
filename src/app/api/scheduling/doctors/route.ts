import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/server-auth-deps";
import { realAvailabilityDeps } from "@/lib/availability-server";
import { googleCalendarConfigured } from "@/lib/google-freebusy";

// Lists the authenticated workspace's doctor → calendar mappings (Smart
// Scheduling). The workspace always comes from the caller's verified session
// (authorizeRequest) — never from a query parameter — so cross-clinic access
// is impossible. Calendar ids are masked: they are addresses the dashboard
// doesn't need in full, and responses must never leak another tenant's data
// even if copy-pasted around.
export const runtime = "nodejs";

const mask = (id: string) => (id.length <= 12 ? "…" : `${id.slice(0, 6)}…${id.slice(-10)}`);

export async function GET(req: NextRequest) {
  const auth = await authorizeRequest(req);
  if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });

  const mappings = await realAvailabilityDeps.listDoctorCalendars(auth.workspaceId);
  if (!mappings.ok) {
    return NextResponse.json({ success: true, configured: googleCalendarConfigured(), doctors: [], note: mappings.error });
  }
  return NextResponse.json({
    success: true,
    configured: googleCalendarConfigured(),
    doctors: mappings.rows.map((r) => ({
      doctor: r.doctor_name,
      provider: r.provider,
      active: r.active,
      calendar: mask(r.calendar_id),
    })),
  });
}
