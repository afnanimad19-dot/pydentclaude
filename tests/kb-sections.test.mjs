// Legacy knowledge blob — remove / replace a document's section safely.
// Synthetic knowledge only.
import { test } from "node:test";
import assert from "node:assert/strict";

const K = await import("@/lib/kb-sections");
const { splitSources } = await import("@/lib/kb-retrieval");

const HEAD = "Clinic hours: 9-5 daily.";
const kb = [
  HEAD,
  "--- clinic-prices.pdf ---\nCleaning AED 300.\n\nWhitening AED 900.",
  "--- doctors.docx ---\nDr. Example — orthodontist.",
  "--- Website — Example Clinic ---\n--- Website page: https://example.com/ ---\nWelcome.\n\n--- Website page: https://example.com/team ---\nOur team.",
  "--- faq.md ---\nWe accept insurance.",
].join("\n\n");

const names = (blob) => splitSources(blob).map((s) => s.name);

test("remove: drops exactly the selected section; everything else intact and in order", () => {
  const out = K.removeKbSection(kb, "clinic-prices.pdf");
  assert.ok(!out.includes("Cleaning AED 300"));
  assert.ok(!out.includes("--- clinic-prices.pdf ---"));
  assert.deepEqual(names(out), names(kb).filter((n) => n !== "clinic-prices.pdf"));
  assert.ok(out.startsWith(HEAD));
  assert.ok(out.includes("--- doctors.docx ---\nDr. Example — orthodontist."));
});

test("remove: a website import takes its nested page sections with it, and nothing after", () => {
  const out = K.removeKbSection(kb, "Website — Example Clinic");
  assert.ok(!out.includes("Welcome.") && !out.includes("Our team.") && !out.includes("Website page:"));
  assert.deepEqual(names(out), ["Knowledge base", "clinic-prices.pdf", "doctors.docx", "faq.md"]);
});

test("remove: the last section, keeping taught Q&A appended by AI Learning", () => {
  const taught = `${kb}\n\nQ: Do you open Fridays?\nA: Yes, 2-8pm.\n\nQ: Parking?\nA: Free basement parking.`;
  const out = K.removeKbSection(taught, "faq.md");
  assert.ok(!out.includes("We accept insurance."));
  assert.ok(out.endsWith("Q: Do you open Fridays?\nA: Yes, 2-8pm.\n\nQ: Parking?\nA: Free basement parking."));
});

test("remove: special-character filenames (no regex built from the name)", () => {
  for (const name of ["price (2).pdf", "a*b?.pdf", "$&.pdf", "عربي — الأسعار.pdf", "[draft]+{v2}.docx", "a --- b.pdf", "x.y\\z.txt"]) {
    const blob = `${HEAD}\n\n--- ${name} ---\nsecret-${name}\n\n--- keep.pdf ---\nkeep me`;
    const out = K.removeKbSection(blob, name);
    assert.ok(!out.includes(`secret-${name}`), name);
    assert.equal(out, `${HEAD}\n\n--- keep.pdf ---\nkeep me`, name);
  }
});

test("remove: a missing section, empty, malformed or legacy input is handled safely", () => {
  assert.equal(K.removeKbSection(kb, "not-there.pdf"), kb, "unknown name → unchanged");
  assert.equal(K.removeKbSection("", "x.pdf"), "");
  assert.equal(K.removeKbSection(null, "x.pdf"), "");
  assert.equal(K.removeKbSection(kb, ""), kb);
  assert.equal(K.removeKbSection(kb, "bad\nname"), kb, "names with newlines are refused");
  // Marker-less legacy text is never touched.
  assert.equal(K.removeKbSection("Just some notes.\n\nQ: x\nA: y", "notes"), "Just some notes.\n\nQ: x\nA: y");
  // A half marker / prefix does not match.
  assert.equal(K.removeKbSection("--- clinic ---\nA\n\n--- clinic-prices.pdf ---\nB", "clinic"), "--- clinic-prices.pdf ---\nB");
  // Legacy data with the SAME name twice (the old re-import bug): both go.
  const dup = "--- a.pdf ---\nold\n\n--- b.pdf ---\nB\n\n--- a.pdf ---\nolder";
  assert.equal(K.removeKbSection(dup, "a.pdf"), "--- b.pdf ---\nB");
  // A section we don't own (seeded website import) right after the removed one survives.
  const seeded = "--- x.pdf ---\nX\n\n--- Website import (https://example.com) ---\nSeeded.";
  assert.equal(K.removeKbSection(seeded, "x.pdf"), "--- Website import (https://example.com) ---\nSeeded.");
});

test("replace: same filename replaces in place — exactly one section, others unchanged", () => {
  const out = K.upsertKbSection(kb, "clinic-prices.pdf", "Cleaning AED 350.");
  assert.equal(out.split("--- clinic-prices.pdf ---").length - 1, 1);
  assert.ok(out.includes("--- clinic-prices.pdf ---\nCleaning AED 350."));
  assert.ok(!out.includes("Cleaning AED 300") && !out.includes("Whitening AED 900"));
  assert.deepEqual(names(out), names(kb), "same sources, same order");
  assert.equal(K.removeKbSection(out, "clinic-prices.pdf"), K.removeKbSection(kb, "clinic-prices.pdf"), "nothing else changed");
});

test("replace: deterministic and idempotent; duplicate legacy sections collapse to one", () => {
  const once = K.upsertKbSection(kb, "doctors.docx", "New doctors list.");
  assert.equal(K.upsertKbSection(once, "doctors.docx", "New doctors list."), once);
  const dup = "--- a.pdf ---\nold\n\n--- b.pdf ---\nB\n\n--- a.pdf ---\nolder";
  assert.equal(K.upsertKbSection(dup, "a.pdf", "new"), "--- a.pdf ---\nnew\n\n--- b.pdf ---\nB");
  assert.equal(K.upsertKbSection("", "n.pdf", "text"), "--- n.pdf ---\ntext");
  assert.equal(K.upsertKbSection(HEAD, "n.pdf", "text"), `${HEAD}\n\n--- n.pdf ---\ntext`);
});

test("replace: special-character filename", () => {
  const name = "$&price (v2) [final].pdf";
  const blob = `--- ${name} ---\nold\n\n--- z.pdf ---\nZ`;
  assert.equal(K.upsertKbSection(blob, name, "new $& $1"), `--- ${name} ---\nnew $& $1\n\n--- z.pdf ---\nZ`);
});

test("compose (Save): a re-uploaded file replaces; a failed re-read keeps the old knowledge", () => {
  const files = ["clinic-prices.pdf", "doctors.docx", "Website — Example Clinic", "faq.md"];
  const ok = K.composeKnowledge(kb, { "clinic-prices.pdf": "Cleaning AED 350." }, files);
  assert.equal(ok.split("--- clinic-prices.pdf ---").length - 1, 1);
  assert.ok(ok.includes("Cleaning AED 350.") && !ok.includes("AED 300"));
  const failed = K.composeKnowledge(kb, { "clinic-prices.pdf": "[Could not read clinic-prices.pdf: parse error]" }, files);
  assert.equal(failed, kb, "failed extraction never destroys good knowledge");
  // A brand-new document is appended once; saving again does not append it twice.
  const added = K.composeKnowledge(kb, { "new.txt": "Fresh." }, [...files, "new.txt"]);
  assert.equal(K.composeKnowledge(added, { "new.txt": "Fresh." }, [...files, "new.txt"]), added);
  assert.equal(added.split("--- new.txt ---").length - 1, 1);
  // A session text whose name was removed from kb_files is not written back.
  assert.equal(K.composeKnowledge(kb, { "gone.pdf": "x" }, files), kb);
});

test("remove then save: the removed document no longer reaches runtime retrieval", () => {
  const files = ["doctors.docx", "Website — Example Clinic", "faq.md"];
  const saved = K.composeKnowledge(K.removeKbSection(kb, "clinic-prices.pdf"), {}, files);
  assert.ok(!splitSources(saved).some((s) => /AED 300|Whitening/.test(s.text)));
});
