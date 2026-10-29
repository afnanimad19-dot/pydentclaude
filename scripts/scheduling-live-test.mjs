// Smart Scheduling — LIVE read-only verification of the Google Calendar
// FreeBusy integration for one doctor. No events are created, modified or
// deleted; the FreeBusy API returns busy intervals only (no patient details).
//
// Usage (run from the repo root):
//   node --experimental-strip-types --import ./tests/alias-loader-register.mjs \
//     scripts/scheduling-live-test.mjs \
//     --calendar <calendar-id> --date 2026-10-30 --doctor "Dr. Leila Hariri" \
//     [--tz Asia/Dubai] [--open 08:00] [--close 21:00] [--grid 5] [--duration 30]
//
// Requires GOOGLE_CALENDAR_SA_KEY_JSON in the environment (the read-only
// service account's JSON key). Without it the script reports the exact
// blocker and exits non-zero — it NEVER substitutes mock availability.

import { parseArgs } from "node:util";

const { freeBusyQuery, googleCalendarConfigured } = await import("@/lib/google-freebusy");
const { computeDaySlots, parseBusyIntervals, zonedTimeToUtcMs } = await import("@/lib/availability");

const { values: a } = parseArgs({
  options: {
    calendar: { type: "string" },
    doctor: { type: "string", default: "(doctor)" },
    date: { type: "string" },
    tz: { type: "string", default: "Asia/Dubai" },
    open: { type: "string", default: "08:00" },
    close: { type: "string", default: "21:00" },
    grid: { type: "string", default: "5" },
    duration: { type: "string", default: "30" },
  },
});

if (!a.calendar || !a.date) {
  console.error("Missing --calendar or --date. See the usage comment at the top of this script.");
  process.exit(2);
}

console.log(`Live FreeBusy test — ${a.doctor}, ${a.date} (${a.tz}), hours ${a.open}–${a.close}, duration ${a.duration} min`);

if (!googleCalendarConfigured()) {
  console.error("\nBLOCKED — authentication: GOOGLE_CALENDAR_SA_KEY_JSON is not set (or is not a valid service-account JSON key).");
  console.error("Setup: create a JSON key for the read-only service account, set it as the");
  console.error("GOOGLE_CALENDAR_SA_KEY_JSON environment variable, and share each doctor's");
  console.error("calendar with the service account ('See only free/busy').");
  process.exit(1);
}

const openMs = zonedTimeToUtcMs(a.date, a.open, a.tz);
const closeMs = zonedTimeToUtcMs(a.date, a.close, a.tz);
const res = await freeBusyQuery({
  timeMin: new Date(openMs).toISOString(),
  timeMax: new Date(closeMs).toISOString(),
  timeZone: a.tz,
  calendarIds: [a.calendar],
});

console.log(`\nAuthentication: ${res.error === "auth_failed" || res.error === "not_configured" ? "FAILED" : "succeeded"}`);
console.log(`API response time: ${res.tookMs} ms (HTTP ${res.status})`);

if (!res.ok) {
  console.error(`Calendar access: FAILED — ${res.error}${res.detail ? `: ${res.detail}` : ""}`);
  process.exit(1);
}

const cal = res.calendars[a.calendar];
if (!cal || cal.errors?.length) {
  console.error(`Calendar access: FAILED — ${JSON.stringify(cal?.errors ?? "calendar missing from response")}`);
  console.error("Most likely the calendar is not shared with the service account ('See only free/busy').");
  process.exit(1);
}

const busy = parseBusyIntervals(cal.busy);
const slots = computeDaySlots({
  date: a.date, timezone: a.tz, openTime: a.open, closeTime: a.close,
  slotMinutes: Number(a.grid), durationMin: Number(a.duration), busy,
});
console.log("Calendar access: succeeded");
console.log(`Busy intervals: ${busy.length}`);
for (const b of cal.busy) console.log(`  busy ${b.start} → ${b.end}`);
console.log(`Available ${a.duration}-minute starts (${slots.length}):`);
console.log(slots.map((s) => s.start).join(", ") || "  (none — fully booked)");
