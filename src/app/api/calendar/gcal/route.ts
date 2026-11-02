import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/server-auth-deps";
import { pushToGoogleCalendar, getValidGoogleToken } from "@/lib/google-api";
import { pushToEngineCalendar } from "@/lib/booking-server";
import { getHfxCreds, hfxConfigured } from "@/lib/hyperfx";
import { mirrorBookingEvent, calendarMirrorStatus, type CalendarMirrorDeps } from "@/lib/calendar-mirror";

// Google Calendar mirror for manually-booked appointments (Phase 2A secured).
//
// Both methods require a signed-in workspace member; the workspace ALWAYS
// comes from the verified session (authorizeRequest) — a `ws` value in the
// request is ignored, so one tenant can never write to or probe another
// tenant's calendar connection.
//
// GET  — read-only connection status. The previous unauthenticated GET that
//        created a real "test" calendar event on every visit is REMOVED.
// POST — mirror one booking onto the connected calendar (OAuth first, engine
//        fallback), same two-path push agent bookings use.
export const runtime = "nodejs";

const deps: CalendarMirrorDeps = {
  pushGoogle: (ws, ev) => pushToGoogleCalendar(ws, ev),
  pushEngine: (ws, ev) => pushToEngineCalendar(ws, ev),
  googleConnected: async (ws) => !!(await getValidGoogleToken(ws, "google_calendar")),
  engineConfigured: async (ws) => hfxConfigured(await getHfxCreds(ws)),
};

export async function GET(req: NextRequest) {
  const auth = await authorizeRequest(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const r = await calendarMirrorStatus(deps, auth.workspaceId);
  return NextResponse.json(r.body, { status: r.status });
}

export async function POST(req: NextRequest) {
  const auth = await authorizeRequest(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const body = await req.json().catch(() => ({}));
  const r = await mirrorBookingEvent(deps, auth.workspaceId, body);
  return NextResponse.json(r.body, { status: r.status });
}
