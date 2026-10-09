// Phase 2B indexing service: after a successful CHANGED ready-document write
// (uploadFile / addUrl / refreshResource), the document is chunked and handed
// to the store's reindexDocument (knowledge_reindex_document, migration 0068).
// The fake store mirrors the 0068 semantics at the store boundary — workspace
// scoping, the stale-hash rejection (no write), ordinal validation, the
// transactional chunk-set swap, the delete cascade — and records every call.
// No database, no network; indexing is proven ADDITIVE: no outcome or throw
// ever changes the ingestion response.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const S = await import("@/lib/knowledge-service");
const K = await import("@/lib/knowledge");
const { chunkDocumentContent, chunkSourceLabel } = await import("@/lib/knowledge-chunker");

const root = path.resolve(import.meta.dirname, "..");
const src = (p) => fs.readFileSync(path.join(root, p), "utf8");

const WS_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const WS_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const NOW = () => new Date("2026-10-01T12:00:00Z");
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

// ------------------------------------------------------------ fake store (0065 apply + 0068 reindex semantics)

function makeWorld() {
  const db = { resources: [], documents: [], chunks: [] };
  const reindexes = []; // every reindexDocument call: { ws, documentId, contentHash, chunks, outcome }
  const faults = {}; // beforeReindex(db) hook, throwOnReindex, unavailable
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const docKey = (d) => (d.kind === "file" ? `f:${d.filename.trim().toLowerCase()}` : `u:${d.source_url}`);
  const store = {
    async listResources(ws) { return clone(db.resources.filter((r) => r.workspace_id === ws)); },
    async getResource(ws, id) { const r = db.resources.find((x) => x.workspace_id === ws && x.id === id); return r ? clone(r) : null; },
    async listDocuments(ws, rid, { withContent }) {
      return clone(db.documents.filter((d) => d.workspace_id === ws && d.resource_id === rid).sort((a, b) => a.position - b.position))
        .map((d) => (withContent ? d : { ...d, content: "" }));
    },
    async listAssignments() { return []; },
    async applyDocumentChanges(ws, rid, userId, changes, meta) {
      const res = db.resources.find((x) => x.workspace_id === ws && x.id === rid);
      if (!res) return { notFound: "resource" };
      let changed = false;
      const results = [];
      for (const c of changes) {
        if (c.op === "insert") {
          if (db.documents.some((d) => d.resource_id === rid && docKey(d) === docKey(c.doc))) return { conflict: true };
          const d = { id: uuid(), workspace_id: ws, resource_id: rid, created_at: "t", updated_at: "t", ...c.doc, char_count: c.doc.content.length };
          db.documents.push(d);
          changed = true;
          results.push({ op: "insert", id: d.id, applied: true });
          continue;
        }
        const d = db.documents.find((x) => x.workspace_id === ws && x.resource_id === rid && x.id === c.id);
        if (!d) {
          if (c.optional) { results.push({ op: c.op, id: c.id, applied: false }); continue; }
          return { notFound: "document" };
        }
        if (c.op === "replace") { if (d.content !== c.doc.content) changed = true; Object.assign(d, c.doc, { char_count: c.doc.content.length }); }
        else if (c.op === "touch") { if ("fetched_at" in c) d.fetched_at = c.fetched_at; if ("error" in c) d.error = c.error; }
        else if (c.op === "delete") {
          db.documents.splice(db.documents.indexOf(d), 1);
          db.chunks = db.chunks.filter((k) => k.document_id !== d.id); // 0068 FK cascade
          changed = true;
        }
        results.push({ op: c.op, id: d.id, applied: true });
      }
      res.status = K.deriveResourceStatus(db.documents.filter((d) => d.resource_id === rid));
      res.content_version += changed ? 1 : 0;
      if ("last_error" in meta) res.last_error = meta.last_error;
      if ("last_refreshed_at" in meta) res.last_refreshed_at = meta.last_refreshed_at;
      return { row: clone(res), changed, results };
    },
    async duplicateResource(ws, sourceId, name, userId) {
      const srcRes = db.resources.find((x) => x.workspace_id === ws && x.id === sourceId);
      if (!srcRes) return { notFound: true };
      const dst = { ...clone(srcRes), id: uuid(), name, content_version: 0, created_by: userId, updated_by: userId };
      db.resources.push(dst);
      const docs = db.documents.filter((d) => d.workspace_id === ws && d.resource_id === sourceId);
      // 0065 copies documents (content + hash); NOTHING copies chunks.
      docs.forEach((d, i) => db.documents.push({ ...clone(d), id: uuid(), resource_id: dst.id, position: i }));
      dst.content_version = docs.length ? 1 : 0;
      return { row: clone(dst), documents: docs.length };
    },
    // knowledge_reindex_document (0068) at the store boundary.
    async reindexDocument(ws, documentId, contentHash, chunks) {
      const call = { ws, documentId, contentHash, chunks: clone(chunks), outcome: null };
      reindexes.push(call);
      if (faults.throwOnReindex) { call.outcome = "threw"; throw new Error("injected reindex failure"); }
      if (faults.unavailable) { call.outcome = "unavailable"; return { outcome: "unavailable" }; }
      if (faults.beforeReindex) faults.beforeReindex(db); // a racing newer write commits first
      const d = db.documents.find((x) => x.workspace_id === ws && x.id === documentId);
      if (!d) { call.outcome = "not_found"; return { outcome: "not_found" }; }
      if (d.content_hash !== contentHash) { call.outcome = "stale_input"; return { outcome: "stale_input" }; }
      // 22023: object rows with string content/source_label and ordinals exactly 0..n-1.
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        assert.ok(c && typeof c === "object" && typeof c.content === "string" && typeof c.source_label === "string" && c.chunk_index === i, "0068 would raise 22023");
      }
      db.chunks = db.chunks.filter((c) => c.document_id !== documentId);
      chunks.forEach((c) => db.chunks.push({ ...clone(c), workspace_id: ws, resource_id: d.resource_id, document_id: documentId, content_hash: d.content_hash }));
      call.outcome = "replaced";
      return { outcome: "replaced", chunks: chunks.length };
    },
  };
  const addResource = (type, name, ws = WS_A) => {
    const r = { id: uuid(), workspace_id: ws, name, description: "", type, status: "empty", refresh_enabled: false, refresh_interval_hours: null, next_refresh_at: null, last_refreshed_at: null, last_error: null, content_version: 0, created_by: "u", updated_by: "u", created_at: "t", updated_at: "t" };
    db.resources.push(r);
    return r;
  };
  const file = (name, text) => ({ buf: Buffer.from(text), name, mime: "text/plain" });
  const extractOf = (text) => async () => ({ ok: true, text });
  const sites = {};
  const importSite = async (url) => sites[url] ?? { ok: false, status: 502, error: "down", code: "fetch_failed" };
  return { db, reindexes, faults, store, addResource, file, extractOf, sites, importSite };
}

const TEXT_V1 = "Cleaning costs AED 300.\n\nWhitening costs AED 900.";
const TEXT_V2 = "Cleaning costs AED 350.\n\nWhitening costs AED 950.";

// ------------------------------------------------------------ changed/current writes index; everything else doesn't

test("uploadFile insert: ONE reindex with the session ws, the new document id and the EXACT plan content/hash", async () => {
  const w = makeWorld();
  const r = w.addResource("file", "Pricing");
  const res = await S.uploadFile(w.store, WS_A, "u", r.id, w.file("prices.pdf", "x"), w.extractOf(TEXT_V1), NOW);
  assert.equal(res.status, 201);
  assert.equal(res.body.action, "inserted");
  assert.equal(w.reindexes.length, 1);
  const call = w.reindexes[0];
  assert.equal(call.ws, WS_A, "session workspace, never anything else");
  assert.equal(call.documentId, res.body.documentId);
  const expectedHash = await K.contentHash(TEXT_V1);
  assert.equal(call.contentHash, expectedHash, "hash of the exact content that was chunked");
  const doc = w.db.documents.find((d) => d.id === res.body.documentId);
  assert.equal(doc.content_hash, expectedHash, "same hash the atomic write persisted");
  assert.equal(call.outcome, "replaced");
  assert.ok(w.db.chunks.length >= 1);
  for (const c of w.db.chunks) assert.equal(c.content_hash, doc.content_hash, "chunks stamped CURRENT (retrieval join key)");
  // The chunk set is exactly what the pure chunker produces for that content.
  assert.deepEqual(call.chunks, chunkDocumentContent({ content: TEXT_V1, sourceLabel: chunkSourceLabel("Pricing", { filename: "prices.pdf", sourceUrl: null }) }));
  // No new public response fields (indexing is internal/logging-only).
  assert.deepEqual(Object.keys(res.body).sort(), ["action", "documentId", "ok", "resource", "truncated"]);
});

test("uploadFile changed replace: reindex with the NEW hash; the old chunk set is swapped out", async () => {
  const w = makeWorld();
  const r = w.addResource("file", "Pricing");
  const first = await S.uploadFile(w.store, WS_A, "u", r.id, w.file("prices.pdf", "x"), w.extractOf(TEXT_V1), NOW);
  const res = await S.uploadFile(w.store, WS_A, "u", r.id, w.file("prices.pdf", "x"), w.extractOf(TEXT_V2), NOW);
  assert.equal(res.status, 200);
  assert.equal(res.body.action, "replaced");
  assert.equal(res.body.documentId, first.body.documentId, "same document id");
  assert.equal(w.reindexes.length, 2);
  assert.equal(w.reindexes[1].contentHash, await K.contentHash(TEXT_V2));
  assert.ok(w.db.chunks.every((c) => c.content.includes("350") || c.content.includes("950")), "old chunks gone, new set only");
});

test("unchanged / kept / error-status writes: ZERO reindex calls", async () => {
  const w = makeWorld();
  const r = w.addResource("file", "Pricing");
  await S.uploadFile(w.store, WS_A, "u", r.id, w.file("prices.pdf", "x"), w.extractOf(TEXT_V1), NOW);
  w.reindexes.length = 0;
  // Identical content → plan "unchanged" → nothing to index.
  const same = await S.uploadFile(w.store, WS_A, "u", r.id, w.file("prices.pdf", "x"), w.extractOf(TEXT_V1), NOW);
  assert.equal(same.body.action, "unchanged");
  assert.equal(w.reindexes.length, 0, "unchanged → zero");
  // Failed extraction → "kept" (error recorded, content untouched) → nothing to index.
  const kept = await S.uploadFile(w.store, WS_A, "u", r.id, w.file("prices.pdf", "x"), async () => ({ ok: false, status: 422, error: "unreadable" }), NOW);
  assert.equal(kept.status, 422);
  assert.equal(w.reindexes.length, 0, "kept → zero");
  const beforeChunks = JSON.stringify(w.db.chunks);
  assert.equal(JSON.stringify(w.db.chunks), beforeChunks, "existing chunks untouched");
});

test("addUrl insert: reindex with the Central Knowledge source label and the exact 0068 payload shape", async () => {
  const w = makeWorld();
  const r = w.addResource("url", "Website");
  w.sites["https://example.com/pricing"] = { ok: true, text: TEXT_V1 };
  const res = await S.addUrl(w.store, WS_A, "u", r.id, { url: "https://example.com/pricing" }, w.importSite, NOW);
  assert.equal(res.status, 201);
  assert.equal(w.reindexes.length, 1);
  const { chunks } = w.reindexes[0];
  chunks.forEach((c, i) => {
    assert.deepEqual(Object.keys(c).sort(), ["chunk_index", "content", "heading", "source_label"], "exactly the RPC element keys");
    assert.equal(c.chunk_index, i, "ordinals exactly 0..n-1 in order");
    assert.equal(c.source_label, "Website / https://example.com/pricing", "Resource / url convention");
  });
});

test("refreshResource: indexes ONLY the replaced documents — unchanged and failed fetches are skipped", async () => {
  const w = makeWorld();
  const r = w.addResource("url", "Website");
  for (const p of ["a", "b", "c"]) {
    w.sites[`https://example.com/${p}`] = { ok: true, text: `${p} v1` };
    await S.addUrl(w.store, WS_A, "u", r.id, { url: `https://example.com/${p}` }, w.importSite, NOW);
  }
  w.reindexes.length = 0;
  w.sites["https://example.com/a"] = { ok: true, text: "a v2" }; // changed
  // b unchanged; c fails:
  w.sites["https://example.com/c"] = { ok: false, status: 502, error: "down", code: "fetch_failed" };
  const res = await S.refreshResource(w.store, WS_A, "u", r.id, w.importSite, NOW);
  assert.deepEqual(res.body.results.map((x) => x.outcome), ["replaced", "unchanged", "kept_previous"]);
  assert.equal(w.reindexes.length, 1, "one reindex for the one replaced document");
  const docA = w.db.documents.find((d) => d.source_url === "https://example.com/a");
  assert.equal(w.reindexes[0].documentId, docA.id);
  assert.equal(w.reindexes[0].contentHash, await K.contentHash("a v2"));
  assert.equal(w.reindexes[0].outcome, "replaced");
});

test("refresh: a document deleted while pages were fetched (replace not applied) is NOT indexed", async () => {
  const w = makeWorld();
  const r = w.addResource("url", "Website");
  for (const p of ["a", "b"]) {
    w.sites[`https://example.com/${p}`] = { ok: true, text: `${p} v1` };
    await S.addUrl(w.store, WS_A, "u", r.id, { url: `https://example.com/${p}` }, w.importSite, NOW);
  }
  const docB = w.db.documents.find((d) => d.source_url === "https://example.com/b");
  w.reindexes.length = 0;
  w.sites["https://example.com/a"] = { ok: true, text: "a v2" };
  w.sites["https://example.com/b"] = { ok: true, text: "b v2" };
  let fetched = 0;
  const res = await S.refreshResource(w.store, WS_A, "u", r.id, async (u) => {
    if (++fetched === 2) await S.deleteDocument(w.store, WS_A, "u", r.id, docB.id); // concurrent delete
    return w.importSite(u);
  }, NOW);
  assert.deepEqual(res.body.results.map((x) => x.outcome), ["replaced", "removed"]);
  assert.deepEqual(w.reindexes.map((x) => x.documentId), [w.db.documents.find((d) => d.source_url === "https://example.com/a").id], "only the applied replace indexed");
});

test("deleteDocument: zero reindex calls — the 0068 FK cascade removes the chunks", async () => {
  const w = makeWorld();
  const r = w.addResource("file", "Pricing");
  const up = await S.uploadFile(w.store, WS_A, "u", r.id, w.file("prices.pdf", "x"), w.extractOf(TEXT_V1), NOW);
  assert.ok(w.db.chunks.length >= 1);
  w.reindexes.length = 0;
  const res = await S.deleteDocument(w.store, WS_A, "u", r.id, up.body.documentId);
  assert.equal(res.status, 200);
  assert.equal(w.reindexes.length, 0);
  assert.equal(w.db.chunks.length, 0, "cascade removed the chunks");
});

test("duplicateResource: zero Phase 2B reindex calls — copied documents wait for the Phase 2C backfill", async () => {
  const w = makeWorld();
  const r = w.addResource("file", "Pricing");
  await S.uploadFile(w.store, WS_A, "u", r.id, w.file("prices.pdf", "x"), w.extractOf(TEXT_V1), NOW);
  const before = w.db.chunks.length;
  w.reindexes.length = 0;
  const res = await S.duplicateResource(w.store, WS_A, "u", r.id);
  assert.equal(res.status, 201);
  assert.equal(res.body.copiedDocuments, 1);
  assert.equal(w.reindexes.length, 0, "duplication never indexes");
  assert.equal(w.db.chunks.length, before, "the copy has NO chunks (historical/unindexed until 2C)");
});

test("no historical indexing: a pre-existing unindexed document is never touched by another document's write", async () => {
  const w = makeWorld();
  const r = w.addResource("file", "Pricing");
  // Historical document: ready content + hash, but NO chunks (pre-2B data).
  const legacy = { id: uuid(), workspace_id: WS_A, resource_id: r.id, kind: "file", source_url: null, filename: "old.pdf", mime: "text/plain", content: "legacy content", content_hash: await K.contentHash("legacy content"), char_count: 14, fetched_at: null, status: "ready", error: null, position: 0, created_at: "t", updated_at: "t" };
  w.db.documents.push(legacy);
  await S.uploadFile(w.store, WS_A, "u", r.id, w.file("new.pdf", "x"), w.extractOf(TEXT_V1), NOW);
  assert.equal(w.reindexes.length, 1);
  assert.notEqual(w.reindexes[0].documentId, legacy.id, "only the NEW document was indexed");
  assert.ok(!w.db.chunks.some((c) => c.document_id === legacy.id), "the historical document stays unindexed (Phase 2C)");
});

// ------------------------------------------------------------ stale input, failures, idempotency

test("stale input (a newer write raced in): the database rejects by hash, NOTHING is written, ingestion is unaffected", async () => {
  const w = makeWorld();
  const r = w.addResource("file", "Pricing");
  // Between the atomic apply and the reindex, a newer write commits (modeled
  // inside the locked region: the row's hash no longer matches the plan's).
  w.faults.beforeReindex = (db) => {
    for (const d of db.documents) { d.content = "newer racing content"; d.content_hash = "racing-hash"; }
  };
  const res = await S.uploadFile(w.store, WS_A, "u", r.id, w.file("prices.pdf", "x"), w.extractOf(TEXT_V1), NOW);
  assert.equal(res.status, 201, "ingestion response unchanged");
  assert.equal(w.reindexes.length, 1, "no retry for correctness — the newer write indexes its own content");
  assert.equal(w.reindexes[0].outcome, "stale_input");
  assert.equal(w.db.chunks.length, 0, "stale chunks were NOT written");
});

test("reindex throw and 'unavailable' (0068 not installed): ingestion still succeeds, byte-identical response", async () => {
  for (const fault of ["throwOnReindex", "unavailable"]) {
    const w = makeWorld();
    const r = w.addResource("file", "Pricing");
    w.faults[fault] = true;
    const res = await S.uploadFile(w.store, WS_A, "u", r.id, w.file("prices.pdf", "x"), w.extractOf(TEXT_V1), NOW);
    assert.equal(res.status, 201, fault);
    assert.ok(w.db.documents.length === 1 && w.db.documents[0].status === "ready", `${fault}: the document write stands`);
    assert.equal(w.db.chunks.length, 0, `${fault}: no chunks — excluded from retrieval by the hash join until re-indexed`);
    // The response body is identical to a run where indexing worked.
    const ok = makeWorld();
    const r2 = ok.addResource("file", "Pricing");
    const good = await S.uploadFile(ok.store, WS_A, "u", r2.id, ok.file("prices.pdf", "x"), ok.extractOf(TEXT_V1), NOW);
    assert.deepEqual(Object.keys(res.body).sort(), Object.keys(good.body).sort(), fault);
    assert.equal(res.body.action, good.body.action, fault);
  }
});

test("idempotency: re-sending the same chunk set is a harmless exact replacement; unchanged re-ingestion never re-indexes", async () => {
  const w = makeWorld();
  const r = w.addResource("file", "Pricing");
  await S.uploadFile(w.store, WS_A, "u", r.id, w.file("prices.pdf", "x"), w.extractOf(TEXT_V1), NOW);
  const doc = w.db.documents[0];
  const after1 = JSON.parse(JSON.stringify(w.db.chunks));
  // A blind retry with identical arguments (e.g. a repeated job) is safe.
  const again = await w.store.reindexDocument(WS_A, doc.id, doc.content_hash, w.reindexes[0].chunks);
  assert.deepEqual(again, { outcome: "replaced", chunks: after1.length });
  assert.deepEqual(w.db.chunks, after1, "deterministic chunker + wholesale swap ⇒ identical state");
  // Re-ingesting identical content doesn't even reach the RPC.
  w.reindexes.length = 0;
  await S.uploadFile(w.store, WS_A, "u", r.id, w.file("prices.pdf", "x"), w.extractOf(TEXT_V1), NOW);
  assert.equal(w.reindexes.length, 0);
});

test("empty chunk set: a valid replacement that clears the document's chunks (replaced, chunks 0)", async () => {
  const w = makeWorld();
  const r = w.addResource("file", "Pricing");
  await S.uploadFile(w.store, WS_A, "u", r.id, w.file("prices.pdf", "x"), w.extractOf(TEXT_V1), NOW);
  const doc = w.db.documents[0];
  assert.ok(w.db.chunks.length >= 1);
  const res = await w.store.reindexDocument(WS_A, doc.id, doc.content_hash, []);
  assert.deepEqual(res, { outcome: "replaced", chunks: 0 });
  assert.equal(w.db.chunks.length, 0);
});

test("workspace scoping: another workspace's document is not_found and nothing is written", async () => {
  const w = makeWorld();
  const rA = w.addResource("file", "Pricing", WS_A);
  await S.uploadFile(w.store, WS_A, "u", rA.id, w.file("prices.pdf", "x"), w.extractOf(TEXT_V1), NOW);
  const doc = w.db.documents[0];
  const before = JSON.stringify(w.db.chunks);
  const res = await w.store.reindexDocument(WS_B, doc.id, doc.content_hash, []);
  assert.deepEqual(res, { outcome: "not_found" }, "WS_B cannot touch a WS_A document");
  assert.equal(JSON.stringify(w.db.chunks), before);
  // Every service-driven reindex carried the session workspace.
  for (const call of w.reindexes.filter((x) => x.outcome !== "not_found")) assert.equal(call.ws, WS_A);
});

// ------------------------------------------------------------ source-level contract (real binding + service wiring)

test("knowledge-server binds the 0068 RPC exactly and maps every failure to an outcome (never a throw, never content in logs)", () => {
  const s = src("src/lib/knowledge-server.ts");
  const m = s.match(/supabase\.rpc\("knowledge_reindex_document", \{([\s\S]*?)\}\)/);
  assert.ok(m, "calls knowledge_reindex_document");
  for (const p of ["p_workspace_id: ws", "p_document_id: documentId", "p_content_hash: contentHash", "p_chunks:"]) {
    assert.ok(m[1].includes(p), p);
  }
  const body = s.slice(s.indexOf("async reindexDocument"));
  assert.match(body, /"P0002"[\s\S]*?outcome: "not_found"/, "P0002 → not_found");
  assert.match(body, /isMissingTable\(error\)[\s\S]*?outcome: "unavailable"/, "missing 0068 → unavailable, NOT KnowledgeMigrationMissing");
  assert.match(body, /stale_input[\s\S]*?outcome: "stale_input"/);
  assert.match(body, /catch[\s\S]*?outcome: "error"/, "a throw becomes an outcome");
  assert.doesNotMatch(body.slice(0, body.indexOf("\n  },")), /throw/, "reindexDocument never throws");
});

test("service wiring: reindex goes ONLY through the guarded helper; no RPC name, no locking, no retry loops in the service", () => {
  const s = src("src/lib/knowledge-service.ts");
  const code = s.replace(/^\s*\/\/[^\n]*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""); // comments DESCRIBE the rules; scan code only
  assert.doesNotMatch(code, /knowledge_reindex_document|supabase/, "the service never names the RPC or the client — store only");
  const callers = s.match(/indexDocumentChunks\(/g) ?? [];
  assert.equal(callers.length, 4, "one definition + uploadFile + addUrl + refreshResource");
  const helper = s.slice(s.indexOf("async function indexDocumentChunks"), s.indexOf("function applyFailure"));
  assert.match(helper, /try\s*\{[\s\S]*store\.reindexDocument[\s\S]*\}\s*catch/, "every reindex is inside try/catch");
  assert.doesNotMatch(code, /for update|advisory|pg_try|setTimeout|retry/i, "no application-side locking or retries — 0068 is the authority");
  // deleteDocument / duplicateResource / assignment code paths never index.
  const after = (name) => {
    const start = s.indexOf(`export async function ${name}`);
    return s.slice(start, s.indexOf("\nexport", start + 1)); // this function only, up to the next export of any kind
  };
  for (const fn of ["deleteDocument", "duplicateResource", "assignAgent"]) {
    assert.doesNotMatch(after(fn), /indexDocumentChunks|reindexDocument/, `${fn} never indexes`);
  }
});
