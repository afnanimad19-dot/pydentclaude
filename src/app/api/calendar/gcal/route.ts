import { NextRequest, NextResponse } from "next/server";
import { pushToGoogleCalendar } from "@/lib/google-api";
import { pushToEngineCalendar } from "@/lib/booking-server";

// Mirrors a manually-booked appointment onto the clinic's Google Calendar —
// the same two-path push agent bookings use: in-app Google OAuth first, then
// the calendar connected on the marketing engine (Hyperfx). Best-effort.
export const runtime = "nodejs";

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
