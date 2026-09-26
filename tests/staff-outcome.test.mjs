// Staff-confirmed Call Outcome (Stage B): value validation, note handling,
// author/timestamp attribution, save/reload/change semantics, workspace
// isolation, and the guarantee that automated post-call processing can never
// touch the staff columns.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const {
  STAFF_OUTCOMES,
  STAFF_OUTCOME_LABELS,
  STAFF_NOTE_MAX,
  validateStaffOutcome,
  buildStaffOutcomeUpdate,
  authorizeStaffOutcome,
} = await import("@/lib/staff-outcome");

// ── value validation ─────────────────────────────────────────────────────────
test("all five canonical outcome values are accepted", () => {
  assert.deepEqual([...STAFF_OUTCOMES], ["potential", "non_potential", "closed", "cold_lead", "others"]);
  for (const o of STAFF_OUTCOMES) {
    const r = validateStaffOutcome({ outcome: o });
    assert.equal(r.ok, true, o);
    assert.equal(r.value.outcome, o);
    assert.equal(r.value.note, "");
  }
});

test("invalid outcome values are rejected", () => {
  for (const bad of ["", "Potential", "POTENTIAL", "Success", "won", "closed ", 42, null, undefined, ["closed"]]) {
    const r = validateStaffOutcome({ outcome: bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.error, /outcome must be one of/);
  }
  assert.equal(validateStaffOutcome(null).ok, false);
  assert.equal(validateStaffOutcome("potential").ok, false); // body must be an object
});

test("the note is optional, trimmed, and length-capped", () => {
  const withNote = validateStaffOutcome({ outcome: "others", note: "  call back next week  " });
  assert.equal(withNote.ok, true);
  assert.equal(withNote.value.note, "call back next week");

  const noNote = validateStaffOutcome({ outcome: "closed" });
  assert.equal(noNote.ok, true);
  assert.equal(noNote.value.note, "");

  const tooLong = validateStaffOutcome({ outcome: "others", note: "x".repeat(STAFF_NOTE_MAX + 1) });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error, /at most/);

  const wrongType = validateStaffOutcome({ outcome: "others", note: { text: "hi" } });
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.error, /note must be a string/);
});

test("every outcome value has its display label", () => {
  assert.deepEqual(STAFF_OUTCOME_LABELS, {
    potential: "Potential",
    non_potential: "Non-Potential",
    closed: "Closed",
    cold_lead: "Cold Lead",
    others: "Others",
  });
});

// ── update payload: author, timestamp, and column scope ──────────────────────
test("the update payload writes EXACTLY the four staff columns", () => {
  const upd = buildStaffOutcomeUpdate({ outcome: "potential", note: "n" }, { id: "u1", email: "staff@clinic.test" });
  assert.deepEqual(Object.keys(upd).sort(), ["staff_outcome", "staff_outcome_at", "staff_outcome_by", "staff_outcome_note"]);
});

test("author is the editor's email, falling back to their user id", () => {
  const now = new Date("2026-09-26T12:00:00Z");
  const byEmail = buildStaffOutcomeUpdate({ outcome: "closed", note: "" }, { id: "u1", email: "staff@clinic.test" }, now);
  assert.equal(byEmail.staff_outcome_by, "staff@clinic.test");
  assert.equal(byEmail.staff_outcome_at, "2026-09-26T12:00:00.000Z");
  const byId = buildStaffOutcomeUpdate({ outcome: "closed", note: "" }, { id: "u1", email: "" }, now);
  assert.equal(byId.staff_outcome_by, "u1");
  const byIdNull = buildStaffOutcomeUpdate({ outcome: "closed", note: "" }, { id: "u1", email: null }, now);
  assert.equal(byIdNull.staff_outcome_by, "u1");
});

// ── save / reload / change semantics ─────────────────────────────────────────
test("saving then reopening shows the saved classification; a change replaces author and time", () => {
  // The stored row is the source of truth the page re-reads on reopen.
  let row = { id: "c1", summary: "AI summary", outcome: "Success", structured_data: { toolCalls: [] } };

  const first = buildStaffOutcomeUpdate(
    { outcome: "potential", note: "wants whitening quote" },
    { id: "u1", email: "reception@clinic.test" },
    new Date("2026-09-26T09:00:00Z")
  );
  row = { ...row, ...first };
  assert.equal(row.staff_outcome, "potential");
  assert.equal(row.staff_outcome_note, "wants whitening quote");
  assert.equal(row.staff_outcome_by, "reception@clinic.test");

  // A different staff member changes the classification later.
  const second = buildStaffOutcomeUpdate(
    { outcome: "closed", note: "" },
    { id: "u2", email: "manager@clinic.test" },
    new Date("2026-09-26T15:30:00Z")
  );
  row = { ...row, ...second };
  assert.equal(row.staff_outcome, "closed");
  assert.equal(row.staff_outcome_note, "");
  assert.equal(row.staff_outcome_by, "manager@clinic.test");
  assert.equal(row.staff_outcome_at, "2026-09-26T15:30:00.000Z");

  // The AI/engine fields were never part of either update.
  assert.equal(row.summary, "AI summary");
  assert.equal(row.outcome, "Success");
  assert.deepEqual(row.structured_data, { toolCalls: [] });
});

// ── automated processing can never overwrite staff fields ────────────────────
test("no webhook / post-call / summary writer names the staff columns", async () => {
  // Postgres UPDATEs touch only the columns they SET, so it is sufficient
  // (and load-bearing) that none of the automated writers mentions them.
  const writers = [
    "src/app/api/vapi/events/route.ts",
    "src/app/api/livekit/call-log/route.ts",
    "src/app/api/livekit/webhook/route.ts",
    "src/lib/post-call.ts",
    "src/lib/call-summary-server.ts",
  ];
  for (const f of writers) {
    const src = await readFile(new URL(`../${f}`, import.meta.url), "utf8");
    assert.equal(src.includes("staff_outcome"), false, `${f} must not write staff columns`);
  }
});

test("a staff save conversely never names the AI/engine fields", () => {
  const upd = buildStaffOutcomeUpdate({ outcome: "cold_lead", note: "" }, { id: "u1", email: "a@b.c" });
  for (const k of ["summary", "outcome", "structured_data", "extracted_data", "transcript", "messages"]) {
    assert.equal(k in upd, false, k);
  }
});

// ── authorization & tenant isolation ─────────────────────────────────────────
const AUTH_DB = {
  users: { "good-token": "user-1" },
  profiles: { "user-1": "ws-A" },
  calls: { "call-1": "ws-A", "call-2": "ws-B" },
};
const authDeps = {
  getUserId: async (t) => AUTH_DB.users[t] ?? null,
  getProfileWorkspace: async (u) => AUTH_DB.profiles[u] ?? null,
  getCallWorkspace: async (c) => AUTH_DB.calls[c] ?? null,
};

test("outcome updates require a valid session", async () => {
  assert.deepEqual(await authorizeStaffOutcome(authDeps, null, "call-1"), { ok: false, status: 401, error: "Sign in first." });
  assert.deepEqual(await authorizeStaffOutcome(authDeps, "bad-token", "call-1"), { ok: false, status: 401, error: "Invalid session." });
});

test("outcome updates are workspace-isolated: foreign and missing calls are 404", async () => {
  assert.deepEqual(await authorizeStaffOutcome(authDeps, "good-token", "call-1"), { ok: true });
  const foreign = await authorizeStaffOutcome(authDeps, "good-token", "call-2");
  const missing = await authorizeStaffOutcome(authDeps, "good-token", "call-x");
  assert.deepEqual(foreign, { ok: false, status: 404, error: "Call not found." });
  assert.deepEqual(missing, foreign);
});
