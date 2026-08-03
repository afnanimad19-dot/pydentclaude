import { NextRequest, NextResponse } from "next/server";
import { pushToGoogleCalendar } from "@/lib/google-api";
import { pushToEngineCalendar, engineCalendarDebug } from "@/lib/booking-server";

// Mirrors a manually-booked appointment onto the clinic's Google Calendar —
// the same two-path push agent bookings use: in-app Google OAuth first, then
// the calendar connected on the marketing engine (Hyperfx). Best-effort.
export const runtime = "nodejs";

// One-click LIVE TEST: open /api/calendar/gcal in the browser and it creates a
// clearly-labeled test event for tomorrow 09:00 through the same two-path push
// real bookings use, returning exactly what happened (path used, event id, or
// the engine's full error text) — so a silent mirror failure becomes visible.
export async function GET(req: NextRequest) {
  const ws = req.nextUrl.searchParams.get("ws") ?? "";
  const d = new Date(Date.now() + 86400000);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const ev = { summary: "Pydent calendar test — safe to delete", description: "Created by the calendar connection test.", date, time: "09:00" };
  try {
    if (ws) {
      const eventId = await pushToGoogleCalendar(ws, ev);
      if (eventId) return NextResponse.json({ ok: true, via: "google (in-app connection)", eventId, when: `${date} 09:00`, note: "Check Google Calendar tomorrow 09:00 — and make sure the target calendar's checkbox is ticked in the left sidebar." });
    }
    const engine = await pushToEngineCalendar(ws, ev);
    const calendarToolSchema = await engineCalendarDebug(ws);
    return NextResponse.json({
      calendarToolSchema,
      ok: engine.ok,
      via: engine.ok ? "marketing engine (Hyperfx Google Calendar)" : "none",
      eventId: engine.id ?? null,
      eventLink: engine.link ?? null,
      when: `${date} 09:00 (Asia/Dubai)`,
      engineResponse: engine.raw ?? undefined,
      error: engine.ok ? undefined : engine.error,
      note: engine.ok
        ? (engine.link
            ? "CLICK eventLink above — it opens the created event directly and shows which Google account/calendar it landed on."
            : "The engine reported success. Check which Google account is authorized for Google Calendar on hyperfx.ai (Connections) — the event is on THAT account's calendar. The engineResponse field shows exactly what the engine returned.")
        : "The engine calendar call failed — this error text is exactly what to share to get it fixed.",
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "calendar test failed" });
  }
}

export async function POST(req: NextRequest) {
  const { ws, summary, description, date, time } = await req.json().catch(() => ({}));
  if (!ws || !date || !time) return NextResponse.json({ ok: false, error: "ws, date and time are required." }, { status: 400 });
  try {
    const eventId = await pushToGoogleCalendar(String(ws), {
      summary: String(summary ?? "Appointment"),
      description: String(description ?? ""),
      date: String(date),
      time: String(time),
    });
    if (eventId) return NextResponse.json({ ok: true, via: "google" });
    const engine = await pushToEngineCalendar(String(ws), {
      summary: String(summary ?? "Appointment"),
      description: String(description ?? ""),
      date: String(date),
      time: String(time),
    });
    return NextResponse.json({ ok: engine.ok, via: engine.ok ? "engine" : "none" });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "calendar push failed" });
  }
}
