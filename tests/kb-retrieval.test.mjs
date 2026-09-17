// Knowledge retrieval regression tests — the "Sarah misses doctor facts" bug.
// The KB mirrors the real failure: the doctor profile sits BEHIND ~60k chars of
// other content, past the old 48k truncation cliff that made it invisible.

import { test } from "node:test";
import assert from "node:assert/strict";

const { retrieveKnowledge, queriesFromMessages, splitSources, chunkKnowledge } =
  await import("@/lib/kb-retrieval");

const PROFILE = `Dr. Anmol Batria (also known as Dr. Anu)
GP / Root Canal Specialist — DDS, MSc. Languages: English, Spanish.

Dr. Anmol Batria is a General Practice Dentist who graduated from Universidad CEU Cardenal Herrera, Valencia-Spain in 2008 and obtained her Master of Endodontics in 2012 from the University of Valencia, Spain. She has several years of experience in conservative and general restorative dentistry.

Her special expertise is: Endodontics (root canal and retreatments), periodontal treatment, ceramic crowns and bridges, LED whitening, TMJ treatments, nightguards.`;

const filler = (seed) =>
  Array.from({ length: 120 }, (_, i) => `${seed} paragraph ${i}: the clinic offers modern dentistry, comfortable rooms, and friendly staff for families across Dubai. Opening hours and insurance details are described elsewhere in this manual.`).join("\n\n");

const KB = [
  `--- ai_receptionist_training_manual.docx ---\n${filler("Manual A")}`,
  `--- Sleep_Apnea_Training.txt ---\n${filler("Sleep apnea guide")}`,
  `--- Website page: https://lhdm.ae/ ---\n${filler("Homepage")}`,
  `--- Website page: https://lhdm.ae/our-team/dr-anmol-batria/ ---\n${PROFILE}`,
  `--- Website page: https://lhdm.ae/our-services/root-canal-treatment/ ---\nRoot canal treatment (RCT) in Dubai: our endodontic team saves infected teeth. Root canal treatment removes infected pulp and seals the tooth.`,
].join("\n\n");

const ask = (q, history = []) =>
  retrieveKnowledge(KB, queriesFromMessages([...history, { role: "user", content: q }]));

function topSources(r) {
  return r.chunks.map((c) => c.source);
}

test("the KB is genuinely past the old truncation cliff", () => {
  assert.ok(KB.length > 48000, `KB is ${KB.length} chars`);
  assert.ok(KB.indexOf("Anmol") > 48000, "profile sits beyond the old slice(0, 48000)");
});

test("sources and chunks parse from the stored marker convention", () => {
  assert.equal(splitSources(KB).length, 5);
  assert.ok(chunkKnowledge(KB).length > 5);
});

test("1+2: doctor-by-name questions surface the profile chunk", () => {
  for (const q of ["Tell me about Dr Anmol Batria.", "Who performs root canal treatment?"]) {
    const r = ask(q);
    assert.equal(r.mode, "retrieved");
    assert.match(r.text, /Universidad CEU Cardenal Herrera/, q);
  }
});

test("3: alias question — Dr Anu's expertise finds the same profile", () => {
  const r = ask("What is Dr Anu's expertise?");
  assert.match(r.text, /special expertise/i);
  assert.ok(topSources(r).some((s) => s.includes("dr-anmol-batria")), topSources(r).join());
});

test("4+5+6: pronoun follow-ups use conversation context for the entity", () => {
  const history = [
    { role: "user", content: "I want to book appointment for RCT" },
    { role: "assistant", content: "Dr. Anmol Batria (Dr. Anu) specialises in root canal treatment." },
  ];
  for (const q of ["What is her nationality?", "How much experience does she have?", "Which university did she study at?"]) {
    const r = ask(q, history);
    assert.ok(topSources(r).some((s) => s.includes("dr-anmol-batria")), `${q} -> ${topSources(r).join()}`);
  }
  // Nationality is NOT in the profile — retrieval still supplies the profile so
  // the grounded model can truthfully say the detail isn't on file.
  assert.doesNotMatch(PROFILE, /nationality/i);
});

test("7: abbreviation expansion — 'What is RCT?' finds root canal content", () => {
  const r = ask("What is RCT?");
  assert.ok(
    topSources(r).some((s) => s.includes("root-canal-treatment") || s.includes("dr-anmol-batria")),
    topSources(r).join()
  );
});

test("nothing that used to be included is lost: budget still filled from the KB head", () => {
  const r = ask("Tell me about Dr Anmol Batria.");
  assert.ok(r.text.includes("Manual A paragraph 0"), "the old slice(0,…) content is still present");
  assert.ok(r.contextChars <= 48000 + 200);
});

test("a small KB passes through whole — retrieval never removes information without pressure", () => {
  const small = `--- doc.txt ---\n${PROFILE}`;
  const r = retrieveKnowledge(small, ["anything at all"]);
  assert.equal(r.mode, "full");
  assert.equal(r.text, small);
});

test("empty KB stays empty", () => {
  assert.equal(retrieveKnowledge("", ["hi"]).mode, "empty");
});
