// Phase 2C — the retrieval ladder (searchKnowledgeCore / centralRetrievalForReply).
// PURE tests: the chunk matcher and document loader are INJECTED fakes built on
// a fake database that mirrors the real 0068 authority join (assignments →
// ready documents → hash-current chunks, all workspace-scoped). No database,
// no network, synthetic data only.

import { test } from "node:test";
import assert from "node:assert/strict";

const { searchKnowledgeCore, centralRetrievalForReply, ftsQueryFor, formatChunkSections, FTS_MAX_TERMS, NO_MATCH_PROMPT_NOTE } = await import("@/lib/agent-tools-core");

const WS_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const WS_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const AGENT_LAURA = "00000000-aaaa-4000-8000-000000000001";
const AGENT_NOVA = "00000000-aaaa-4000-8000-000000000002";
const RES_FAQ = "00000000-cccc-4000-8000-000000000001";
const DOC_FAQ = "00000000-dddd-4000-8000-000000000001";

const LEGACY_MARKER = "LEGACY-BLOB-ONLY-FACT osmium crowns";
const CHUNK_FACT = "Veneers cost 1200 dirhams per tooth at our clinic.";
const DOCTEXT_FACT = "Dr Anmol Batria leads endodontics and root canal treatment.";
const FOREIGN_SECRET = "FOREIGN-WORKSPACE-SECRET implant price";

/**
 * Fake chunk index implementing the SAME authority rules as the 0068 SQL:
 * universe = chunks of (assigned resources → status 'ready' documents) whose
 * content_hash equals the document's CURRENT content_hash, workspace-scoped.
 * A chunk matches when it shares a token with any OR-ed query term.
 */
function makeChunkDb() {
  const db = {
    assignments: [], // { workspace_id, agent_id, resource_id }
    documents: [],   // { workspace_id, id, resource_id, status, content_hash }
    chunks: [],      // { workspace_id, document_id, id, chunk_index, source_label, heading, content, content_hash }
    calls: [],       // every (ws, agentId, query, topK) the matcher saw
  };
  const matcher = async (ws, agentId, query, topK = 8) => {
    db.calls.push({ ws, agentId, query, topK });
    const assigned = new Set(db.assignments.filter((a) => a.workspace_id === ws && a.agent_id === agentId).map((a) => a.resource_id));
    const docs = db.documents.filter((d) => d.workspace_id === ws && assigned.has(d.resource_id) && d.status === "ready");
    const universe = db.chunks.filter((c) =>
      c.workspace_id === ws && docs.some((d) => d.id === c.document_id && d.content_hash === c.content_hash)
    );
    const terms = String(query).toLowerCase().split(/\s+or\s+/i).filter(Boolean);
    const matches = universe
      .filter((c) => terms.some((t) => c.content.toLowerCase().includes(t)))
      .slice(0, topK)
      .map((c, i) => ({
        resource_id: db.documents.find((d) => d.id === c.document_id)?.resource_id ?? "",
        document_id: c.document_id,
        chunk_id: c.id,
        chunk_index: c.chunk_index ?? 0,
        source_label: c.source_label ?? "Clinic FAQ / faq.pdf",
        heading: c.heading ?? "",
        content: c.content,
        score: 1 - i * 0.1,
      }));
    return { ok: true, searchedChunks: universe.length, matches: matches.map((m) => ({
      resourceId: m.resource_id, documentId: m.document_id, chunkId: m.chunk_id, chunkIndex: m.chunk_index,
      sourceLabel: m.source_label, heading: m.heading, content: m.content, score: m.score,
    })) };
  };
  return { db, matcher };
}

/** Loader fake for the existing Phase 1B step (assignment state + document text). */
function loaderOf(state) {
  const calls = [];
  const loader = async (ws, agentId) => {
    calls.push({ ws, agentId });
    return state;
  };
  return { loader, calls };
}

const agentA = { id: AGENT_LAURA, workspace_id: WS_A, name: "Laura", knowledge_base: LEGACY_MARKER };

function seedReadyChunk(db, over = {}) {
  db.assignments.push({ workspace_id: WS_A, agent_id: AGENT_LAURA, resource_id: RES_FAQ });
  db.documents.push({ workspace_id: WS_A, id: DOC_FAQ, resource_id: RES_FAQ, status: "ready", content_hash: "h1" });
  db.chunks.push({ workspace_id: WS_A, document_id: DOC_FAQ, id: "chunk-1", chunk_index: 0, source_label: "Clinic FAQ / faq.pdf", heading: "Prices", content: CHUNK_FACT, content_hash: "h1", ...over });
}

// ── ftsQueryFor ──────────────────────────────────────────────────────────────

test("ftsQueryFor ORs tokenized terms, drops stopwords, expands clinic abbreviations, dedupes and caps", () => {
  const q = ftsQueryFor(["What is the price of RCT?"]);
  assert.ok(!/\bthe\b/.test(q) && !/\bof\b/.test(q), "stopwords dropped");
  assert.match(q, /price OR rct/);
  assert.match(q, /root/, "alias expansion (rct → root canal treatment)");
  assert.ok(q.split(" OR ").every((t, i, a) => a.indexOf(t) === i), "deduped");
  const many = ftsQueryFor([Array.from({ length: 60 }, (_, i) => `token${i}`).join(" ")]);
  assert.equal(many.split(" OR ").length, FTS_MAX_TERMS, "term cap");
  assert.equal(ftsQueryFor(["", "   "]), "", "blank input → empty query");
});

// ── ladder step 1: chunks primary ────────────────────────────────────────────

test("chunks answer when the index is live: sourceMode central-chunks, attribution kept, legacy blob untouched", async () => {
  const { db, matcher } = makeChunkDb();
  seedReadyChunk(db);
  const { loader, calls } = loaderOf({ assigned: true, knowledge: { text: DOCTEXT_FACT, resources: 1, documents: 1, chars: 10 } });
  const r = await searchKnowledgeCore(agentA, { query: "veneers price" }, "voice", loader, matcher);
  assert.equal(r.success, true);
  assert.equal(r.found, true);
  assert.equal(r.sourceMode, "central-chunks");
  assert.match(r.text, /Veneers cost 1200 dirhams/);
  assert.match(r.text, /Clinic FAQ \/ faq\.pdf · Prices/, "source attribution header");
  assert.ok(!r.text.includes(LEGACY_MARKER), "legacy blob never enters a chunk answer");
  assert.equal(calls.length, 0, "document loader not consulted when the index answered");
  assert.ok(r.sources.length >= 1 && r.sources[0].source.includes("Clinic FAQ"));
  assert.deepEqual(db.calls[0].ws, WS_A, "matcher got the server-resolved workspace");
});

test("genuine no-match (universe > 0, zero matches): found:false, NO broadened retrieval, no fallback", async () => {
  const { db, matcher } = makeChunkDb();
  seedReadyChunk(db); // index exists, but the query matches nothing in it
  const { loader, calls } = loaderOf({ assigned: true, knowledge: { text: DOCTEXT_FACT, resources: 1, documents: 1, chars: 10 } });
  const r = await searchKnowledgeCore(agentA, { query: "wisdom teeth extraction aftercare" }, "voice", loader, matcher);
  assert.equal(r.success, true);
  assert.equal(r.found, false, "honest no-match");
  assert.equal(r.sourceMode, "central-chunks");
  assert.equal(r.text, "");
  assert.equal(calls.length, 0, "the loader (broader retrieval) is NEVER consulted on a genuine no-match");
});

// ── ladder step 2: controlled fallbacks ──────────────────────────────────────

test("universe 0 (no usable index) falls back to the existing assigned-document retrieval", async () => {
  const { matcher } = makeChunkDb(); // empty index → universe 0
  const { loader } = loaderOf({ assigned: true, knowledge: { text: `--- Clinic FAQ / doc ---\n${DOCTEXT_FACT}`, resources: 1, documents: 1, chars: 60 } });
  const r = await searchKnowledgeCore(agentA, { query: "root canal" }, "voice", loader, matcher);
  assert.equal(r.sourceMode, "central");
  assert.equal(r.found, true);
  assert.match(r.text, /Anmol Batria/);
  assert.ok(!r.text.includes(LEGACY_MARKER), "assigned agent never falls back to the legacy blob");
});

test("RPC failure falls back to the existing authorized path (never a dead tool)", async () => {
  const failing = async () => ({ ok: false, error: "rpc_failed" });
  const { loader } = loaderOf({ assigned: true, knowledge: { text: DOCTEXT_FACT, resources: 1, documents: 1, chars: 60 } });
  const r = await searchKnowledgeCore(agentA, { query: "root canal" }, "voice", loader, failing);
  assert.equal(r.sourceMode, "central");
  assert.equal(r.found, true);
  assert.match(r.text, /Anmol Batria/);
});

test("unassigned agent with no index keeps the legacy blob exactly as before", async () => {
  const { matcher } = makeChunkDb();
  const { loader } = loaderOf({ assigned: false, knowledge: null });
  const r = await searchKnowledgeCore(agentA, { query: "osmium crowns" }, "voice", loader, matcher);
  assert.equal(r.sourceMode, "legacy");
  assert.equal(r.found, true);
  assert.match(r.text, /LEGACY-BLOB-ONLY-FACT/);
});

// ── tenant isolation and staleness (the authority join) ─────────────────────

test("cross-tenant proof: workspace B's chunks are unreachable even with known UUIDs, and the matcher only ever sees server-resolved ids", async () => {
  const { db, matcher } = makeChunkDb();
  seedReadyChunk(db);
  // Workspace B has its own juicy index.
  db.assignments.push({ workspace_id: WS_B, agent_id: AGENT_NOVA, resource_id: "res-b" });
  db.documents.push({ workspace_id: WS_B, id: "doc-b", resource_id: "res-b", status: "ready", content_hash: "hb" });
  db.chunks.push({ workspace_id: WS_B, document_id: "doc-b", id: "chunk-b", chunk_index: 0, source_label: "B secrets", heading: "", content: FOREIGN_SECRET, content_hash: "hb" });
  const { loader } = loaderOf({ assigned: true, knowledge: null });
  const r = await searchKnowledgeCore(agentA, { query: "implant price secret" }, "voice", loader, matcher);
  assert.ok(!r.text.includes(FOREIGN_SECRET), "foreign workspace content never returned");
  for (const c of db.calls) {
    assert.equal(c.ws, WS_A);
    assert.equal(c.agentId, AGENT_LAURA);
  }
});

test("unassigned resources and stale/unready documents are OUTSIDE the universe (authority join)", async () => {
  const { db, matcher } = makeChunkDb();
  // Assigned resource whose document was re-edited: chunk hash is stale.
  seedReadyChunk(db, { content_hash: "old-hash" });
  // Same workspace: an UNASSIGNED resource with a juicy ready chunk.
  db.documents.push({ workspace_id: WS_A, id: "doc-unassigned", resource_id: "res-unassigned", status: "ready", content_hash: "h2" });
  db.chunks.push({ workspace_id: WS_A, document_id: "doc-unassigned", id: "chunk-2", chunk_index: 0, source_label: "x", heading: "", content: "Veneers unassigned secret", content_hash: "h2" });
  // And a processing (not ready) document of the assigned resource.
  db.documents.push({ workspace_id: WS_A, id: "doc-processing", resource_id: RES_FAQ, status: "processing", content_hash: "h3" });
  db.chunks.push({ workspace_id: WS_A, document_id: "doc-processing", id: "chunk-3", chunk_index: 0, source_label: "x", heading: "", content: "Veneers processing secret", content_hash: "h3" });
  const { loader } = loaderOf({ assigned: true, knowledge: null });
  const r = await searchKnowledgeCore(agentA, { query: "veneers" }, "voice", loader, matcher);
  // Universe is empty (stale hash + unassigned + not-ready all excluded) → step 2; nothing usable → central-empty.
  assert.equal(r.sourceMode, "central");
  assert.equal(r.found, false);
  assert.ok(!r.text.includes("secret"));
});

// ── budgets and formatting ───────────────────────────────────────────────────

test("formatChunkSections respects the budget, keeps order, always includes the first chunk", () => {
  const mk = (i, size) => ({ resourceId: "r", documentId: "d", chunkId: `c${i}`, chunkIndex: i, sourceLabel: `Src ${i}`, heading: "", content: "x".repeat(size), score: 1 });
  const big = formatChunkSections([mk(0, 10000)], 500);
  assert.equal(big.used.length, 1);
  assert.ok(big.text.length <= 500, "oversized first chunk truncated to budget");
  const three = formatChunkSections([mk(0, 200), mk(1, 200), mk(2, 5000)], 500);
  assert.equal(three.used.length, 2, "later chunk that doesn't fit is dropped");
  assert.ok(three.text.indexOf("Src 0") < three.text.indexOf("Src 1"), "order preserved");
});

// ── centralRetrievalForReply (text channels) ─────────────────────────────────

const msgs = (q) => [{ role: "user", content: q }];

test("reply retrieval: legacy agent → null (caller keeps today's path byte-for-byte)", async () => {
  const { matcher } = makeChunkDb();
  const { loader } = loaderOf({ assigned: false, knowledge: null });
  assert.equal(await centralRetrievalForReply(agentA, msgs("veneers price"), "whatsapp", loader, matcher), null);
});

test("reply retrieval: live index answers with chunks and attribution", async () => {
  const { db, matcher } = makeChunkDb();
  seedReadyChunk(db);
  const { loader, calls } = loaderOf({ assigned: true, knowledge: null });
  const r = await centralRetrievalForReply(agentA, msgs("how much do veneers cost?"), "whatsapp", loader, matcher);
  assert.equal(r.sourceMode, "central-chunks");
  assert.match(r.retrieval.text, /Veneers cost 1200 dirhams/);
  assert.match(r.retrieval.text, /Clinic FAQ/);
  assert.equal(calls.length, 0, "one retrieval per turn — no second (loader) pass when the index answered");
});

test("reply retrieval: genuine no-match injects the grounding note, never broadens", async () => {
  const { db, matcher } = makeChunkDb();
  seedReadyChunk(db);
  const { loader, calls } = loaderOf({ assigned: true, knowledge: { text: DOCTEXT_FACT, resources: 1, documents: 1, chars: 10 } });
  const r = await centralRetrievalForReply(agentA, msgs("wisdom teeth aftercare"), "sms", loader, matcher);
  assert.equal(r.sourceMode, "central-chunks");
  assert.equal(r.retrieval.text, NO_MATCH_PROMPT_NOTE);
  assert.equal(r.retrieval.chunks.length, 0);
  assert.equal(calls.length, 0, "no-match must not broaden retrieval");
  assert.ok(!r.retrieval.text.includes(DOCTEXT_FACT));
});

test("reply retrieval: assigned agent with nothing usable stays central with the grounding note (never the legacy blob)", async () => {
  const { matcher } = makeChunkDb(); // universe 0
  const { loader } = loaderOf({ assigned: true, knowledge: null });
  const r = await centralRetrievalForReply(agentA, msgs("anything at all"), "whatsapp", loader, matcher);
  assert.equal(r.sourceMode, "central");
  assert.equal(r.retrieval.text, NO_MATCH_PROMPT_NOTE);
});
