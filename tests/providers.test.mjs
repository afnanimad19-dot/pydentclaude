// M1A provider foundation: ID-aware provider matching (stable UUIDs first,
// legacy fuzzy-name fallback) and provider input normalization. Pure
// functions, fictional data — no database, no network. The pre-existing
// scheduling tests are untouched; these only cover the ADDITIVE helpers.

import { test } from "node:test";
import assert from "node:assert/strict";

const { sameProviderRef, conflictsWithBookedRef, conflictsWithBooked } = await import("@/lib/scheduling");
const { normalizeProviderInput, WEEKDAYS, BLOCK_TYPES } = await import("@/lib/providers-server");

// Fictional stable ids.
const DR_A = "11111111-1111-4111-8111-111111111111";
const DR_B = "22222222-2222-4222-8222-222222222222";

// ── sameProviderRef: ids decide when both sides have one ────────────────────
test("same provider UUID matches regardless of how the names are written", () => {
  assert.equal(sameProviderRef({ id: DR_A, name: "Dr. Demo" }, { id: DR_A, name: "Demo Person" }), true);
  assert.equal(sameProviderRef({ id: DR_A }, { id: DR_A }), true);
});

test("different provider UUIDs never match — even when the names fuzzy-match", () => {
  // Legacy matching would call these the same doctor ("Dr. Demo" ⊂ "Demo").
  assert.equal(sameProviderRef({ id: DR_A, name: "Dr. Demo" }, { id: DR_B, name: "Demo" }), false);
});

test("missing ids fall back to the legacy fuzzy name matching", () => {
  assert.equal(sameProviderRef({ name: "Dr. Anmol" }, { name: "Anmol Batria" }), true);
  assert.equal(sameProviderRef({ id: DR_A, name: "Dr. Demo" }, { name: "Demo" }), true); // one id only → names decide
  assert.equal(sameProviderRef({ name: "Dr. A" }, { name: "Dr. B" }), false);
  assert.equal(sameProviderRef({}, {}), true);            // both unassigned → same "slot owner", as before
  assert.equal(sameProviderRef(null, undefined), true);
});

// ── conflictsWithBookedRef: duration-aware, id-first ────────────────────────
test("a booking blocks an overlapping slot for the SAME provider UUID only", () => {
  const booked = [{ time: "10:00", provider: "Dr. Demo", provider_id: DR_A, duration_min: 60 }];
  assert.equal(conflictsWithBookedRef(booked, "10:30", 30, { id: DR_A, name: "Someone Else" }), true);
  assert.equal(conflictsWithBookedRef(booked, "11:00", 30, { id: DR_A }), false); // adjacent, no overlap
  assert.equal(conflictsWithBookedRef(booked, "10:30", 30, { id: DR_B, name: "Dr. Demo" }), false); // other UUID is free
});

test("booked rows without provider_id keep the legacy name behaviour exactly", () => {
  // Rows written before migration 0065 carry only the free-text name.
  const legacyRow = [{ time: "10:00", provider: "Dr. Demo", duration_min: 60 }];
  for (const [time, dur, doctor] of [["10:30", 30, "Dr. Demo"], ["11:00", 30, "Dr. Demo"], ["10:30", 30, "Dr. Other"], ["10:00", 30, ""]]) {
    assert.equal(
      conflictsWithBookedRef(legacyRow, time, dur, { name: doctor }),
      conflictsWithBooked(legacyRow, time, dur, doctor),
      `parity with conflictsWithBooked for ${time} / ${doctor || "(unassigned)"}`
    );
  }
});

// ── normalizeProviderInput ──────────────────────────────────────────────────
test("provider input: trims fields, requires a name, defaults the flags on", () => {
  assert.equal(normalizeProviderInput({ name: "   " }), null);
  assert.equal(normalizeProviderInput(null), null);
  const p = normalizeProviderInput({ name: "  Dr. Demo ", specialty: " Ortho " });
  assert.deepEqual(p, { name: "Dr. Demo", displayName: "", specialty: "Ortho", color: "", active: true, bookingEnabled: true });
  assert.equal(normalizeProviderInput({ name: "Dr. Demo", active: false, bookingEnabled: false }).active, false);
});

// ── migration 0065 HH:MM check constraints ──────────────────────────────────
// Verify the ACTUAL regex patterns in the migration file: strictly 00:00–23:59
// (never 24:00 and up). Postgres `~` and JS RegExp agree on this simple POSIX
// pattern, so testing it here pins the constraint without a database.
test("migration 0065 time checks accept 00:00–23:59 and reject hour 24+", async () => {
  const { readFile } = await import("node:fs/promises");
  const sql = await readFile(new URL("../supabase/migrations/0065_provider_foundation.sql", import.meta.url), "utf8");
  const patterns = [...sql.matchAll(/check \((?:start|end)_time ~ '([^']+)'\)/g)].map((m) => m[1]);
  assert.equal(patterns.length, 4, "provider_schedules and schedule_blocks each constrain start_time and end_time");
  for (const p of patterns) {
    const re = new RegExp(p);
    for (const good of ["00:00", "09:30", "23:59"]) assert.equal(re.test(good), true, `${good} must be valid`);
    for (const bad of ["24:00", "24:30", "25:00", "9:30", "12:60", "noon"]) assert.equal(re.test(bad), false, `${bad} must be invalid`);
  }
});

// ── vocabulary matches the existing scheduling utilities ────────────────────
test("weekday and block-type vocabularies are the expected closed sets", () => {
  assert.deepEqual([...WEEKDAYS], ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
  assert.deepEqual([...BLOCK_TYPES], ["break", "leave", "blocked", "closure"]);
});
