// Smart Scheduling — pure availability math (src/lib/availability.ts).
// Fictional calendars, no network. Covers the Day-1 required scenarios that
// live in pure logic: empty / fully / partially booked days, overlapping and
// adjacent busy periods, 15/30/60-minute durations, 5-minute grid alignment,
// opening/closing boundaries, and timezone conversion incl. a DST transition.

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  zonedTimeToUtcMs, formatTimeInTz, parseBusyIntervals,
  mergeBusyIntervals, freeWindows, computeDaySlots, isValidDateStr,
} = await import("@/lib/availability");

const TZ = "Asia/Dubai";
const DAY = "2026-10-30";
// LHDM-style settings (08:00–21:00, 5-minute grid) — passed in as config, the
// values are not hardcoded anywhere in application logic.
const base = { date: DAY, timezone: TZ, openTime: "08:00", closeTime: "21:00", slotMinutes: 5 };
const at = (time) => zonedTimeToUtcMs(DAY, time, TZ);
const busy = (from, to) => ({ start: at(from), end: at(to) });

// ── Timezone conversion ────────────────────────────────────────────────────────
test("Dubai wall-clock converts to the correct UTC instant (UTC+4, no DST)", () => {
  assert.equal(at("08:00"), Date.parse(`${DAY}T04:00:00Z`));
  assert.equal(formatTimeInTz(at("08:00"), TZ), "08:00");
});

test("DST transition day resolves to real instants (Europe/Berlin, clocks back)", () => {
  // 2026-10-25 is the EU change: 03:00 CEST → 02:00 CET. 08:00 local is UTC+1.
  const ms = zonedTimeToUtcMs("2026-10-25", "08:00", "Europe/Berlin");
  assert.equal(ms, Date.parse("2026-10-25T07:00:00Z"));
  // The day before the change, 08:00 local is UTC+2.
  assert.equal(zonedTimeToUtcMs("2026-10-24", "08:00", "Europe/Berlin"), Date.parse("2026-10-24T06:00:00Z"));
});

test("slot grid stays 5-minute aligned across a fall-back DST day", () => {
  const slots = computeDaySlots({
    date: "2026-10-25", timezone: "Europe/Berlin",
    openTime: "01:00", closeTime: "04:00", slotMinutes: 5, durationMin: 30, busy: [],
  });
  // The local 01:00–04:00 window spans 4 real hours (02:00–03:00 happens twice).
  assert.equal(slots.length, (4 * 60 - 30) / 5 + 1);
  for (const s of slots) assert.match(s.start, /^\d{2}:[0-5][05]$/);
});

// ── Busy-interval merging ──────────────────────────────────────────────────
test("overlapping busy periods merge into one", () => {
  const merged = mergeBusyIntervals([busy("10:00", "11:00"), busy("10:30", "11:30")]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], busy("10:00", "11:30"));
});

test("adjacent busy periods merge (10–10:30 + 10:30–11 = 10–11)", () => {
  const merged = mergeBusyIntervals([busy("10:30", "11:00"), busy("10:00", "10:30")]);
  assert.deepEqual(merged, [busy("10:00", "11:00")]);
});

test("malformed busy entries are dropped, never guessed", () => {
  assert.deepEqual(parseBusyIntervals([{ start: "nope", end: "2026-10-30T07:00:00Z" }, {}]), []);
  assert.equal(parseBusyIntervals([{ start: "2026-10-30T06:00:00Z", end: "2026-10-30T07:00:00Z" }]).length, 1);
});

// ── Free windows ──────────────────────────────────────────────────────────────
test("busy outside operating hours does not affect free windows", () => {
  const w = freeWindows(at("08:00"), at("21:00"), [busy("06:00", "07:30"), busy("22:00", "23:00")]);
  assert.deepEqual(w, [{ start: at("08:00"), end: at("21:00") }]);
});

test("busy overlapping the open/close boundary is clipped", () => {
  const w = freeWindows(at("08:00"), at("21:00"), [busy("07:00", "09:00"), busy("20:30", "22:00")]);
  assert.deepEqual(w, [{ start: at("09:00"), end: at("20:30") }]);
});

// ── Slot generation ──────────────────────────────────────────────────────────
test("empty calendar: full 5-minute grid, last start leaves room for the duration", () => {
  const slots = computeDaySlots({ ...base, durationMin: 30, busy: [] });
  assert.equal(slots[0].start, "08:00");
  assert.equal(slots[slots.length - 1].start, "20:30"); // 20:30+30 = close
  assert.equal(slots.length, (13 * 60 - 30) / 5 + 1);   // 08:00..20:30 inclusive
  assert.equal(slots[0].end, "08:30");
});

test("fully booked day yields no slots", () => {
  assert.deepEqual(computeDaySlots({ ...base, durationMin: 30, busy: [busy("08:00", "21:00")] }), []);
});

test("partially booked day offers only times whose FULL duration is free", () => {
  const slots = computeDaySlots({ ...base, durationMin: 30, busy: [busy("10:00", "12:00")] });
  const starts = slots.map((s) => s.start);
  assert.ok(starts.includes("09:30"));  // ends exactly at 10:00
  assert.ok(!starts.includes("09:35")); // would overlap 10:00
  assert.ok(!starts.includes("11:55"));
  assert.ok(starts.includes("12:00")); // resumes exactly at the busy end
});

test("gap shorter than the requested duration is excluded entirely", () => {
  // Free gap 10:00–10:20 (20 min) between busy blocks.
  const slots = computeDaySlots({ ...base, durationMin: 30, busy: [busy("08:00", "10:00"), busy("10:20", "21:00")] });
  assert.deepEqual(slots, []);
});

test("durations 15 / 30 / 60 respect the same busy block differently", () => {
  const b = [busy("09:00", "10:00")];
  const latestBefore = (dur) =>
    computeDaySlots({ ...base, durationMin: dur, busy: b }).filter((s) => s.start < "09:00").pop().start;
  assert.equal(latestBefore(15), "08:45");
  assert.equal(latestBefore(30), "08:30");
  assert.equal(latestBefore(60), "08:00");
});

test("grid stays anchored at opening time even when a busy block ends off-grid", () => {
  // Busy ends 10:12 → next grid start is 10:15, not 10:12.
  const slots = computeDaySlots({ ...base, durationMin: 30, busy: [{ start: at("08:00"), end: at("10:12") }] });
  assert.equal(slots[0].start, "10:15");
});

test("invalid inputs produce no slots instead of garbage", () => {
  assert.deepEqual(computeDaySlots({ ...base, date: "not-a-date", durationMin: 30, busy: [] }), []);
  assert.deepEqual(computeDaySlots({ ...base, openTime: "21:00", closeTime: "08:00", durationMin: 30, busy: [] }), []);
  assert.equal(isValidDateStr("2026-10-30"), true);
  assert.equal(isValidDateStr("30/10/2026"), false);
});
