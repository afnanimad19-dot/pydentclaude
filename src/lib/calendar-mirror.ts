// Google Calendar mirror operations for the /api/calendar/gcal route — pure
// logic with injected push/status services, so authorization boundaries and
// fallback order are unit-testable without Google or a database.
//
// Security contract (Phase 2A): the workspace ALWAYS comes from the caller's
// verified session (the route's authorizeRequest result) — a `ws` field in the
// request body is ignored. The status check performs NO calendar writes; the
// old unauthenticated GET that created a real test event is gone.

export interface CalendarMirrorDeps {
  /** In-app Google OAuth push; resolves the created event id, or null. */
  pushGoogle(ws: string, ev: { summary: string; description: string; date: string; time: string }): Promise<string | null>;
  /** Marketing-engine fallback push. */
  pushEngine(ws: string, ev: { summary: string; description: string; date: string; time: string }): Promise<{ ok: boolean; id?: string | null; error?: string }>;
  /** True when the workspace has a usable in-app Google Calendar connection (read-only check, no writes). */
  googleConnected(ws: string): Promise<boolean>;
  /** True when the workspace's marketing-engine calendar is configured (read-only check, no writes). */
  engineConfigured(ws: string): Promise<boolean>;
}

export interface MirrorResult {
  status: number;
  body: Record<string, unknown>;
}

// Mirror one manually-booked appointment onto the clinic's connected calendar:
// in-app Google OAuth first, then the engine fallback — the same two-path push
// agent bookings use. `ws` is the session workspace; body fields are data only.
export async function mirrorBookingEvent(deps: CalendarMirrorDeps, ws: string, body: unknown): Promise<MirrorResult> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const date = String(b.date ?? "").slice(0, 10);
  const time = String(b.time ?? "").slice(0, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return { status: 400, body: { ok: false, error: "date (YYYY-MM-DD) and time (HH:MM) are required." } };
  }
  const ev = {
    summary: String(b.summary ?? "Appointment").slice(0, 200),
    description: String(b.description ?? "").slice(0, 2000),
    date,
    time,
  };
  try {
    const eventId = await deps.pushGoogle(ws, ev);
    if (eventId) return { status: 200, body: { ok: true, via: "google" } };
    const engine = await deps.pushEngine(ws, ev);
    return { status: 200, body: { ok: engine.ok, via: engine.ok ? "engine" : "none", ...(engine.ok ? {} : { error: engine.error ?? "calendar mirror failed" }) } };
  } catch (e) {
    return { status: 200, body: { ok: false, via: "none", error: e instanceof Error ? e.message : "calendar push failed" } };
  }
}

// Connection status for the session workspace. Replaces the old GET "live
// test": it reports which mirror paths are configured WITHOUT creating any
// calendar event.
export async function calendarMirrorStatus(deps: CalendarMirrorDeps, ws: string): Promise<MirrorResult> {
  const [google, engine] = await Promise.all([
    deps.googleConnected(ws).catch(() => false),
    deps.engineConfigured(ws).catch(() => false),
  ]);
  return {
    status: 200,
    body: {
      ok: google || engine,
      google: { connected: google },
      engine: { configured: engine },
      note: google || engine
        ? "A calendar mirror path is available. No test event was created — book a (test) appointment to verify end to end."
        : "No calendar connection found. Connect Google Calendar in Settings → Connections, or configure the marketing engine.",
    },
  };
}
