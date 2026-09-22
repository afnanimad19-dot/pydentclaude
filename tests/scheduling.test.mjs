// Scheduling helpers: timezone-aware "today", clinic-hours settings with safe
// defaults, and duration-aware overlap rules. Pure functions, fictional data.

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  todayInTz, normalizeSchedulingSettings, DEFAULT_SCHEDULING,
  rangesOverlap, apptDuration, clampDuration,
  conflictsWithBooked, openSlotsForDay, weekdayInTz, sameProvider,
} = await import("@/lib/scheduling");

const { voiceSpoken } = await import("@/lib/builder-tools");

// ── Timezone-aware "today" ───────────────────────────────────────────────────
test("today in Asia/Dubai rolls over 4 hours before UTC midnight", () => {
  const now = new Date("2026-01-01T22:30:00Z"); // 02:30 on Jan 2 in Dubai
  assert.equal(todayInTz("Asia/Dubai", now), "2026-01-02");
  assert.equal(todayInTz("UTC", now), "2026-01-01");
});

test("an invalid timezone falls back to the UTC date instead of throwing", () => {
  const now = new Date("2026-03-05T10:00:00Z");
  assert.equal(todayInTz("Not/AZone", now), "2026-03-05");
});

// ── Settings normalization (old workspaces keep safe defaults) ───────────────
test("missing or garbage settings normalize to the historical defaults", () => {
  assert.deepEqual(normalizeSchedulingSettings(null), DEFAULT_SCHEDULING);
  assert.deepEqual(normalizeSchedulingSettings({ open_time: "late", slot_minutes: "many" }), DEFAULT_SCHEDULING);
});

test("configured settings parse, and close<=open resets the hours", () => {
  const s = normalizeSchedulingSettings({ open_time: "08:00", close_time: "20:00", slot_minutes: 15, default_duration_min: 45, closed_days: "sunday, friday" });
  assert.deepEqual(s, { openTime: "08:00", closeTime: "20:00", slotMinutes: 15, defaultDurationMin: 45, closedDays: ["sunday", "friday"] });
  const bad = normalizeSchedulingSettings({ open_time: "18:00", close_time: "09:00" });
  assert.equal(bad.openTime, "09:00");
  assert.equal(bad.closeTime, "17:00");
});

// ── Durations and overlap ────────────────────────────────────────────────────
test("stored duration is respected; missing/garbage falls back to 60 (the DB default)", () => {
  assert.equal(apptDuration(30), 30);
  assert.equal(apptDuration(null), 60);
  assert.equal(apptDuration("soon"), 60);
  assert.equal(clampDuration(90, 30), 90);
  assert.equal(clampDuration(undefined, 30), 30);
});

test("rangesOverlap: adjacent ranges do not overlap, contained ones do", () => {
  assert.equal(rangesOverlap(600, 30, 630, 30), false); // 10:00–10:30 vs 10:30–11:00
  assert.equal(rangesOverlap(600, 60, 630, 30), true);  // 10:00–11:00 vs 10:30
  assert.equal(rangesOverlap(630, 30, 600, 60), true);
});

test("a 60-minute booking at 10:00 blocks 10:30 for the SAME doctor only", () => {
  const booked = [{ time: "10:00", provider: "Dr. Demo", duration_min: 60 }];
  assert.equal(conflictsWithBooked(booked, "10:30", 30, "Dr. Demo"), true);
  assert.equal(conflictsWithBooked(booked, "11:00", 30, "Dr. Demo"), false);
  assert.equal(conflictsWithBooked(booked, "10:30", 30, "Dr. Other"), false); // another doctor is free
});

test("open slots: empty day reproduces the historical 09:00–16:30 grid", () => {
  const open = openSlotsForDay([], DEFAULT_SCHEDULING, {});
  assert.equal(open.length, 16);
  assert.equal(open[0], "09:00");
  assert.equal(open.at(-1), "16:30");
});

test("open slots honor durations, closed days and clinic hours", () => {
  const booked = [{ time: "10:00", provider: "", duration_min: 60 }];
  const open = openSlotsForDay(booked, DEFAULT_SCHEDULING, { doctor: "", durationMin: 30 });
  assert.equal(open.includes("10:00"), false);
  assert.equal(open.includes("10:30"), false); // covered by the 60-minute booking
  assert.equal(open.includes("11:00"), true);
  // A 60-minute candidate cannot start at 16:30 (would end past close).
  const long = openSlotsForDay([], DEFAULT_SCHEDULING, { durationMin: 60 });
  assert.equal(long.at(-1), "16:00");
  // Closed day → nothing offered.
  assert.deepEqual(openSlotsForDay([], { ...DEFAULT_SCHEDULING, closedDays: ["sunday"] }, { weekday: "sunday" }), []);
});

test("weekdayInTz names the clinic-local weekday", () => {
  assert.equal(weekdayInTz("2026-09-27", "Asia/Dubai"), "sunday");
});

test("sameProvider keeps its fuzzy matching after the move", () => {
  assert.equal(sameProvider("Dr. Anmol", "Anmol Batria"), true);
  assert.equal(sameProvider("", ""), true);
  assert.equal(sameProvider("Dr. A", ""), false);
});

// ── Voice prose for shared flows ─────────────────────────────────────────────
test("voiceSpoken enumerates appointment choices with their real ids", () => {
  const body = {
    success: false,
    reason: "ambiguous_appointment",
    spoken: "This patient has several upcoming appointments — ask which one.",
    appointments: [
      { appointment_id: "appt-fict-1", date: "2099-01-10", time: "10:00", doctor: "Dr. Demo", service: "Cleaning", status: "Scheduled" },
      { appointment_id: "appt-fict-2", date: "2099-02-01", time: "14:30", doctor: "", service: "", status: "Scheduled" },
    ],
  };
  const out = voiceSpoken(body);
  assert.match(out, /1\. 2099-01-10 at 10:00 with Dr\. Demo for Cleaning — appointment_id appt-fict-1/);
  assert.match(out, /2\. 2099-02-01 at 14:30 — appointment_id appt-fict-2/);
  assert.equal(voiceSpoken({ spoken: "Cancelled." }), "Cancelled.");
});
