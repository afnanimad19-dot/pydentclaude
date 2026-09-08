// Post-call data extraction: the typed coercion applied to whatever the model
// returns before it is written to voice_calls.extracted_data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceValue } from "@/lib/post-call";

const f = (type, options) => ({ name: "x", description: "", type, options });

test("blank answers become null instead of a guess", () => {
  for (const raw of [null, undefined, ""]) {
    assert.equal(coerceValue(raw, f("text")), null);
    assert.equal(coerceValue(raw, f("number")), null);
    assert.equal(coerceValue(raw, f("boolean")), null);
  }
});

test("numbers are parsed out of the model's prose", () => {
  assert.equal(coerceValue(42, f("number")), 42);
  assert.equal(coerceValue("AED 350", f("number")), 350);
  assert.equal(coerceValue("not stated", f("number")), null);
});

test("booleans accept the words a model actually returns", () => {
  assert.equal(coerceValue(true, f("boolean")), true);
  assert.equal(coerceValue("Yes", f("boolean")), true);
  assert.equal(coerceValue("no", f("boolean")), false);
  assert.equal(coerceValue("1", f("boolean")), true);
  assert.equal(coerceValue("maybe", f("boolean")), null);
});

test("dates and datetimes keep only a valid shape", () => {
  assert.equal(coerceValue("Sometime on 2026-09-14 please", f("date")), "2026-09-14");
  assert.equal(coerceValue("next Tuesday", f("date")), null);
  assert.equal(coerceValue("2026-09-14 10:30", f("datetime")), "2026-09-14T10:30");
  assert.equal(coerceValue("2026-09-14", f("datetime")), null);
});

test("enums must match one of the allowed values", () => {
  const field = f("enum", ["booked", "cancelled", "none"]);
  assert.equal(coerceValue("Booked", field), "booked");
  assert.equal(coerceValue("rescheduled", field), null);
  assert.equal(coerceValue("anything", f("enum", [])), "anything");
});

test("legacy \"string\" fields behave as text and are length-capped", () => {
  assert.equal(coerceValue("  Sarah ", f("string")), "  Sarah ");
  assert.equal(coerceValue("a".repeat(5000), f("text")).length, 2000);
});
