// Phase 2B chunker (lib/knowledge-chunker.ts): pure, deterministic,
// NON-OVERLAPPING chunking of one Central Knowledge document into the exact
// JSON shape knowledge_reindex_document (migration 0068) accepts. No database,
// no network, synthetic text only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const {
  chunkDocumentContent,
  chunkSourceLabel,
  CHUNK_TARGET_CHARS,
  CHUNK_MAX_CHARS,
  CHUNK_TAIL_MIN_CHARS,
  SOURCE_LABEL_MAX_CHARS,
} = await import("@/lib/knowledge-chunker");
const { centralSourceLabel } = await import("@/lib/knowledge-runtime");

const LABEL = "Pricing / prices.pdf";
const chunk = (content, sourceLabel = LABEL) => chunkDocumentContent({ content, sourceLabel });
const para = (token, len = 400) => `${token} ${"x".repeat(Math.max(0, len - token.length - 1))}`;

/** Every invariant the 0068 contract demands, asserted for one output. */
function assertContract(chunks, label = LABEL) {
  chunks.forEach((c, i) => {
    assert.deepEqual(Object.keys(c).sort(), ["chunk_index", "content", "heading", "source_label"], "exact RPC payload keys");
    assert.equal(c.chunk_index, i, "chunk_index exactly 0..n-1 in order");
    assert.equal(typeof c.content, "string");
    assert.ok(c.content.length >= 1, "no empty chunk");
    assert.ok(c.content.length <= CHUNK_MAX_CHARS, `hard max: ${c.content.length}`);
    assert.equal(c.source_label, label);
    assert.ok(c.source_label.length >= 1 && c.source_label.length <= SOURCE_LABEL_MAX_CHARS);
    assert.ok(c.heading === null || (typeof c.heading === "string" && c.heading.length > 0));
    // Valid UTF-16 throughout (a lone surrogate would throw here and be
    // rejected as JSON by the database).
    assert.doesNotThrow(() => encodeURIComponent(c.content));
  });
}

test("constants match the approved design and the 0068 CHECK constraints", () => {
  assert.equal(CHUNK_TARGET_CHARS, 1500);
  assert.equal(CHUNK_MAX_CHARS, 4000);
  assert.equal(CHUNK_TAIL_MIN_CHARS, 200);
  assert.equal(SOURCE_LABEL_MAX_CHARS, 200);
});

test("deterministic: the same input always produces the same ordered output (no time/randomness)", () => {
  const doc = ["Intro paragraph.", "--- Page https://example.com/a ---", para("alpha"), para("beta"), "--- Fees ---", para("gamma", 2000)].join("\n\n");
  const a = chunk(doc);
  const b = chunk(doc);
  const c = chunk(doc);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.ok(a.length > 0);
  // The module itself is pure: no I/O, env, time or randomness anywhere
  // (comments stripped — the header merely DESCRIBES these prohibitions).
  const srcText = fs
    .readFileSync(path.resolve(import.meta.dirname, "..", "src/lib/knowledge-chunker.ts"), "utf8")
    .replace(/^\s*\/\/[^\n]*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(srcText, /\bimport\b|require\(/, "no imports at all — fully self-contained");
  assert.doesNotMatch(srcText, /supabase|fetch\(|process\.|node:|Date\.|Date\(|Math\.random|setTimeout/i);
});

test("whitespace-only and empty content → [] (and null-ish is tolerated)", () => {
  for (const s of ["", "   ", "\n\n\t  \r\n", null, undefined]) {
    assert.deepEqual(chunkDocumentContent({ content: s, sourceLabel: LABEL }), [], JSON.stringify(s));
  }
});

test("short document → one chunk, index 0, heading null, trimmed content", () => {
  const out = chunk("  Cleaning costs AED 300.  \n");
  assertContract(out);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { chunk_index: 0, content: "Cleaning costs AED 300.", source_label: LABEL, heading: null });
});

test("paragraph packing: paragraphs group toward ~1500, never past it when combining, boundaries on whole paragraphs", () => {
  const tokens = Array.from({ length: 12 }, (_, i) => `PARA${String(i).padStart(2, "0")}`);
  const out = chunk(tokens.map((t) => para(t, 400)).join("\n\n"));
  assertContract(out);
  assert.ok(out.length >= 3 && out.length < 12, `packed into ${out.length} chunks`);
  for (const c of out) {
    assert.ok(c.content.length <= CHUNK_TARGET_CHARS, "combined chunks stay within the target");
    // Chunk boundaries are paragraph boundaries: content is whole paragraphs.
    for (const p of c.content.split("\n\n")) assert.match(p, /^PARA\d{2} x+$/);
  }
  // Order is stable and nothing is lost or duplicated.
  const seen = out.flatMap((c) => c.content.match(/PARA\d{2}/g));
  assert.deepEqual(seen, tokens);
});

test("multiple paragraphs in one small document stay one chunk, joined with blank lines", () => {
  const out = chunk("First fact.\n\nSecond fact.\n\nThird fact.");
  assertContract(out);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, "First fact.\n\nSecond fact.\n\nThird fact.");
});

test("section markers (splitSources convention): each section's chunks carry its heading", () => {
  const out = chunk(["--- Page https://example.com/pricing ---", para("alpha"), "--- Opening hours ---", para("beta")].join("\n\n"));
  assertContract(out);
  assert.deepEqual(out.map((c) => c.heading), ["Page https://example.com/pricing", "Opening hours"]);
  assert.match(out[0].content, /alpha/);
  assert.match(out[1].content, /beta/);
});

test("heading extraction is deterministic: internal whitespace collapsed, surrounding whitespace trimmed", () => {
  const out = chunk("---   Page    One  ---\n\nBody text.");
  assertContract(out);
  assert.equal(out[0].heading, "Page One");
});

test("content before the first marker → heading null, ordered first; marker-less documents are all heading null", () => {
  const out = chunk(`Preamble before any marker.\n\n--- Section A ---\n\n${para("alpha")}`);
  assertContract(out);
  assert.equal(out[0].heading, null);
  assert.match(out[0].content, /Preamble/);
  assert.equal(out[1].heading, "Section A");
  for (const c of chunk(para("solo", 3000))) assert.equal(c.heading, null);
});

test("oversized paragraph: split on sentence boundaries — every chunk ≤ 4000, every sentence intact in exactly one chunk", () => {
  const sentences = Array.from({ length: 40 }, (_, i) => `Sentence ${String(i).padStart(2, "0")} ${"y".repeat(180)}.`);
  const out = chunk(sentences.join(" ")); // ONE paragraph ~7600 chars
  assertContract(out);
  assert.ok(out.length >= 2, "split happened");
  const all = out.map((c) => c.content).join("\u0000");
  for (const s of sentences) {
    const hits = all.split(s).length - 1;
    assert.equal(hits, 1, `sentence appears exactly once, never cut: ${s.slice(0, 20)}`);
  }
});

test("oversized unbroken text (no sentences, no spaces): deterministic hard split, nothing lost, nothing duplicated", () => {
  const monster = "a".repeat(10_000);
  const out = chunk(monster);
  assertContract(out);
  assert.equal(out.map((c) => c.content).join(""), monster, "concatenation reconstructs the source exactly");
  assert.equal(out.length, Math.ceil(10_000 / CHUNK_MAX_CHARS));
});

test("Unicode: multi-byte text survives; hard splits never cut a surrogate pair", () => {
  const emoji = "😀".repeat(3_000); // 6000 UTF-16 units, no sentence/space boundaries
  const out = chunk(emoji);
  assertContract(out); // encodeURIComponent inside proves no lone surrogates
  assert.equal(out.map((c) => c.content).join(""), emoji);
  const arabic = chunk("عيادة الأسنان تقدم تنظيف الأسنان.\n\nالسعر ٣٠٠ درهم.");
  assertContract(arabic);
  assert.equal(arabic.length, 1);
});

test("newline normalization: CRLF / CR input chunks identically to LF input", () => {
  const lf = `--- Page A ---\n\n${para("alpha")}\n\n${para("beta")}`;
  const crlf = lf.replace(/\n/g, "\r\n");
  const cr = lf.replace(/\n/g, "\r");
  assert.deepEqual(chunk(crlf), chunk(lf));
  assert.deepEqual(chunk(cr), chunk(lf));
});

test("stable global ordering: chunk_index runs 0..n-1 across ALL sections in document order", () => {
  const doc = ["head para", "--- S1 ---", para("a", 2000), para("b", 2000), "--- S2 ---", para("c")].join("\n\n");
  const out = chunk(doc);
  assertContract(out);
  assert.deepEqual(out.map((c) => c.chunk_index), out.map((_, i) => i));
  const order = out.map((c) => c.heading);
  assert.equal(order[0], null);
  assert.ok(order.indexOf("S1") < order.indexOf("S2"));
});

test("source_label: Central Knowledge convention (matches centralSourceLabel), hard-capped at 200 chars", () => {
  // Convention parity with the Phase 1B runtime label.
  for (const [name, doc] of [
    ["Pricing", { filename: "prices.pdf", sourceUrl: null }],
    ["Website", { filename: null, sourceUrl: "https://example.com/a" }],
    ["  Spaced   name ", { filename: "  two   words.txt ", sourceUrl: null }],
    ["", { filename: null, sourceUrl: null }],
  ]) {
    assert.equal(chunkSourceLabel(name, doc), centralSourceLabel(name, { filename: doc.filename, source_url: doc.sourceUrl }), JSON.stringify(name));
  }
  // The DB cap (the runtime label has none).
  const long = chunkSourceLabel("R".repeat(300), { filename: "f".repeat(300), sourceUrl: null });
  assert.equal(long.length, SOURCE_LABEL_MAX_CHARS);
  // A degenerate label passed straight to the chunker is normalized, capped and never empty.
  const out = chunkDocumentContent({ content: "text", sourceLabel: `  padded   ${"L".repeat(300)}` });
  assert.ok(out[0].source_label.length <= SOURCE_LABEL_MAX_CHARS && out[0].source_label.length >= 1);
  assert.equal(chunkDocumentContent({ content: "text", sourceLabel: "   " })[0].source_label, "Knowledge document");
});

test("small-tail merge: a trailing fragment < 200 chars merges into the previous chunk — no text duplicated", () => {
  const big = para("BIGPARA", 1400);
  const tiny = "TINY tail fragment.";
  const out = chunk(`${big}\n\n${tiny}`);
  assertContract(out);
  assert.equal(out.length, 1, "merged");
  assert.equal(out[0].content, `${big}\n\n${tiny}`);
  assert.equal(out[0].content.split("TINY").length - 1, 1, "tail present exactly once");
});

test("small-tail merge refused when the merge would exceed the 4000 hard max", () => {
  const big = para("BIGPARA", 3980); // 3980 + 2 (separator) + 46 (tail) > 4000
  const tiny = "TINY tail fragment over the limit when merged.";
  const out = chunk(`${big}\n\n${tiny}`);
  assertContract(out);
  assert.equal(out.length, 2, "not merged — 4000 is never exceeded");
  assert.equal(out[1].content, tiny);
});

test("NO overlap / carry: every source paragraph lands in exactly ONE chunk (unlike the legacy kb-retrieval carry)", () => {
  // 30 uniquely-tokened paragraphs, sized so the legacy carry rule (< target/2
  // carries into the next chunk) WOULD duplicate many of them.
  const tokens = Array.from({ length: 30 }, (_, i) => `UNIQ${String(i).padStart(2, "0")}`);
  const doc = tokens.map((t, i) => para(t, 300 + (i % 5) * 150)).join("\n\n");
  const out = chunk(doc);
  assertContract(out);
  const all = out.map((c) => c.content).join("\u0000");
  for (const t of tokens) assert.equal(all.split(t).length - 1, 1, `${t} appears exactly once across all chunks`);
  // Also across the sentence-split path of an oversized paragraph.
  const bigSentences = Array.from({ length: 20 }, (_, i) => `OVER${String(i).padStart(2, "0")} ${"z".repeat(300)}.`);
  const out2 = chunk(bigSentences.join(" "));
  const all2 = out2.map((c) => c.content).join("\u0000");
  for (let i = 0; i < 20; i++) assert.equal(all2.split(`OVER${String(i).padStart(2, "0")}`).length - 1, 1);
});

test("property sweep: assorted inputs always satisfy the full 0068 contract", () => {
  const inputs = [
    "one line",
    `${para("a", 100)}\n\n${para("b", 4000)}\n\n${para("c", 50)}`,
    `--- M ---\n\n${"word ".repeat(2_000)}`,
    `${"Line.\n".repeat(500)}`,
    `---  ---\n\nmarker with blank label`, // degenerate marker
    `--- A ---\n--- B ---\n\nback-to-back markers`,
    `${para("x", 3999)}\n\n${para("y", 1)}`,
    `å${"ü".repeat(4_500)}`,
    `..... !!! ??? ${"p".repeat(5_000)} .`,
  ];
  for (const s of inputs) {
    const out = chunk(s);
    assertContract(out);
    assert.deepEqual(out, chunk(s), "deterministic for every input");
  }
});
