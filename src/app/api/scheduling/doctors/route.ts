import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/server-auth-deps";
import { realAvailabilityDeps } from "@/lib/availability-server";
import { googleCalendarConfigured } from "@/lib/google-freebusy";
import { removeDoctorCalendar, realDoctorCalendarDeps, upsertDoctorCalendar } from "@/lib/doctor-calendars-server";
import { ADMIN_ROLES } from "@/lib/server-auth";

// Doctor → calendar mappings for the authenticated workspace (Smart
// Scheduling). The workspace always comes from the caller's verified session
// (authorizeRequest) — never from a query parameter — so cross-clinic access
// is impossible. Calendar ids are masked in listings: they are addresses the
// dashboard doesn't need in full, and responses must never leak another
// tenant's data even if copy-pasted around.
//
// GET    — list mappings (any workspace member).
// POST   — create/update one mapping (owner/admin only). Calendar ids are
//          configuration data entered here, never hardcoded anywhere.
// DELETE — remove one mapping (owner/admin only).
export const runtime = "nodejs";

const mask = (id: string) => (id.length <= 12 ? "…" : `${id.slice(0, 6)}…${id.slice(-10)}`);

const ADMIN_OPTS = {
  allowedRoles: ADMIN_ROLES,
  roleError: "Only a workspace owner or admin can change doctor calendar mappings.",
} as const;

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
      timezone: r.timezone ?? null,
      test: r.is_test === true,
    })),
  });
}

export async function POST(req: NextRequest) {
  const auth = await authorizeRequest(req, ADMIN_OPTS);
  if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ success: false, error: "Body must be a JSON object: { doctor, calendar_id, provider?, timezone?, active?, is_test? }." }, { status: 400 });
  }
  const r = await upsertDoctorCalendar(realDoctorCalendarDeps, auth.workspaceId, body);
  if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: r.status });
  const m = r.mapping;
  return NextResponse.json({
    success: true,
    mapping: { doctor: m.doctor_name, provider: m.provider, active: m.active, calendar: mask(m.calendar_id), timezone: m.timezone, test: m.is_test },
  });
}

export async function DELETE(req: NextRequest) {
  const auth = await authorizeRequest(req, ADMIN_OPTS);
  if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => ({}));
  const r = await removeDoctorCalendar(realDoctorCalendarDeps, auth.workspaceId, body ?? {});
  if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: r.status });
  return NextResponse.json({ success: true, removed: { doctor: r.doctor, provider: r.provider } });
}
