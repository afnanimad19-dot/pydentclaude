// Phase 2C — knowledge_match_chunks client (knowledge-runtime). PURE tests:
// the strict jsonb parser and the blank-identity short-circuit are exercised
// directly; the Supabase RPC binding itself is covered by source scans and by
// the injected-matcher ladder tests (knowledge-retrieval-core.test.mjs).
// No database, no network, synthetic data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { parseChunkMatchResponse, matchAgentChunks } = await import("@/lib/knowledge-runtime");

const root = path.resolve(import.meta.dirname, "..");
const src = (p) => fs.readFileSync(path.join(root, p), "utf8");

const row = (over = {}) => ({
  resource_id: "00000000-cccc-4000-8000-000000000001",
  document_id: "00000000-dddd-4000-8000-000000000001",
  chunk_id: "00000000-eeee-4000-8000-000000000001",
  chunk_index: 0,
  source_label: "Clinic FAQ / faq.pdf",
  heading: "Opening hours",
  content: "We are open Monday to Friday, 9am to 5pm.",
  score: 0.42,
  ...over,
});

test("a well-formed response parses into typed matches, in order", () => {
  const r = parseChunkMatchResponse({ searched_chunks: 7, matches: [row(), row({ chunk_id: "00000000-eeee-4000-8000-000000000002", chunk_index: 1, score: 0.1 })] });
  assert.equal(r.ok, true);
  assert.equal(r.searchedChunks, 7);
  assert.equal(r.matches.length, 2);
  assert.deepEqual(r.matches[0], {
    resourceId: "00000000-cccc-4000-8000-000000000001",
    documentId: "00000000-dddd-4000-8000-000000000001",
    chunkId: "00000000-eeee-4000-8000-000000000001",
    chunkIndex: 0,
    sourceLabel: "Clinic FAQ / faq.pdf",
    heading: "Opening hours",
    content: "We are open Monday to Friday, 9am to 5pm.",
    score: 0.42,
  });
});

test("an empty universe and an empty match list are both valid (they are SIGNALS, not errors)", () => {
  assert.deepEqual(parseChunkMatchResponse({ searched_chunks: 0, matches: [] }), { ok: true, searchedChunks: 0, matches: [] });
  assert.deepEqual(parseChunkMatchResponse({ searched_chunks: 12, matches: [] }), { ok: true, searchedChunks: 12, matches: [] });
});

test("malformed responses fail CLOSED (ok:false → caller falls back; never a fake no-match)", () => {
  const bad = [
    null,
    undefined,
    [],
    "x",
    {},
    { searched_chunks: -1, matches: [] },
    { searched_chunks: "7", matches: [] }, // numbers must be numbers
    { searched_chunks: 3 }, // matches missing
    { searched_chunks: 3, matches: {} },
    { searched_chunks: 3, matches: [null] },
    { searched_chunks: 3, matches: [row({ chunk_id: "" })] },
    { searched_chunks: 3, matches: [row({ content: "   " })] },
    { searched_chunks: 3, matches: [row({ score: "0.4" })] },
    { searched_chunks: 3, matches: [row(), ["not-an-object"]] }, // one bad row poisons the response
  ];
  for (const b of bad) {
    const r = parseChunkMatchResponse(b);
    assert.equal(r.ok, false, `expected ok:false for ${JSON.stringify(b)?.slice(0, 60)}`);
    assert.equal(r.error, "bad_response");
  }
});

test("non-string optional fields degrade to safe defaults instead of failing", () => {
  const r = parseChunkMatchResponse({ searched_chunks: 1, matches: [row({ heading: null, source_label: undefined, chunk_index: "2" })] });
  assert.equal(r.ok, true);
  assert.equal(r.matches[0].heading, "");
  assert.equal(r.matches[0].sourceLabel, "");
  assert.equal(r.matches[0].chunkIndex, 0); // strings never coerce silently
});

test("blank workspace or agent identity short-circuits to universe 0 without any RPC", async () => {
  assert.deepEqual(await matchAgentChunks("", "00000000-aaaa-4000-8000-000000000001", "hours"), { ok: true, searchedChunks: 0, matches: [] });
  assert.deepEqual(await matchAgentChunks("aaaaaaaa-0000-4000-8000-00000000000a", "", "hours"), { ok: true, searchedChunks: 0, matches: [] });
});

test("source guard: the RPC caller lives server-side, calls ONLY knowledge_match_chunks, and never logs content", () => {
  const text = src("src/lib/knowledge-runtime.ts");
  assert.match(text, /supabase\.rpc\("knowledge_match_chunks"/);
  assert.equal((text.match(/\.rpc\(/g) ?? []).length, 1, "exactly one RPC call site");
  assert.match(text, /p_top_k: Math\.max\(1, Math\.min\(/, "top-k clamped client-side too");
  assert.ok(!/console\.(log|error|warn)/.test(text), "knowledge-runtime never logs (content could leak)");
});
