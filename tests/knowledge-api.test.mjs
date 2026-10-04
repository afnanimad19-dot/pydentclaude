// Central Knowledge Base APIs (Phase A4 + A4.1): authorization, workspace
// isolation, CRUD, ingestion, content_version, atomic duplicate / document
// writes, migration-missing. Requests run through the REAL route wrapper +
// service against an in-memory store that mirrors the 0065 constraints and
// functions. No database, network, parser or AI. Synthetic data only.
//
// The fake's all-or-nothing behaviour (snapshot + restore) only models the
// CONTRACT the service relies on — one atomic call per operation. It does not
// prove PostgreSQL transaction semantics; that is the later non-production
// migration execution gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { withKnowledge } = await import("@/lib/knowledge-route");
const S = await import("@/lib/knowledge-service");
const K = await import("@/lib/knowledge");
const { KnowledgeMigrationMissing } = S;

const root = path.resolve(import.meta.dirname, "..");
const src = (p) => fs.readFileSync(path.join(root, p), "utf8");

const WS_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const WS_B = "bbbbbbbb-0000-4000-8000-00000000000b";
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const SECRET = "CONFIDENTIAL-KNOWLEDGE-BODY";

// ------------------------------------------------------------ in-memory store (0065 semantics)

function makeStore() {
  const db = { resources: [], documents: [], assignments: [], agents: [] };
  const calls = [];
  const faults = {};
  let missing = false;
  const restore = (snap) => { for (const k of Object.keys(db)) db[k] = snap[k]; };
  const docKey = (d) => (d.kind === "file" ? `f:${d.filename.trim().toLowerCase()}` : `u:${d.source_url}`);
  const pgError = (code, hint) => Object.assign(new Error(code), { pg: code, hint });
  const mapError = (e, map) => { if (e.pg && map[e.pg]) return map[e.pg](e.hint); throw e; };
  let clock = 0;
  const ts = () => new Date(Date.UTC(2026, 9, 1, 0, 0, clock++)).toISOString();
  const guard = () => { if (missing) throw new KnowledgeMigrationMissing(); };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const store = {
    async listResources(ws) { guard(); return clone(db.resources.filter((r) => r.workspace_id === ws)); },
    async getResource(ws, id) { guard(); const r = db.resources.find((x) => x.workspace_id === ws && x.id === id); return r ? clone(r) : null; },
    async insertResource(ws, row) {
      guard();
      if (db.resources.some((r) => r.workspace_id === ws && r.name.trim().toLowerCase() === row.name.trim().toLowerCase())) return { conflict: "name" };
      const r = { id: uuid(), workspace_id: ws, next_refresh_at: null, last_refreshed_at: null, last_error: null, content_version: 0, created_at: ts(), updated_at: ts(), ...row };
      db.resources.push(r);
      return { row: clone(r) };
    },
    async updateResource(ws, id, patch) {
      guard();
      calls.push("updateResource");
      const r = db.resources.find((x) => x.workspace_id === ws && x.id === id);
      if (!r) return null;
      if (patch.name && db.resources.some((x) => x !== r && x.workspace_id === ws && x.name.trim().toLowerCase() === patch.name.trim().toLowerCase())) return { conflict: "name" };
      Object.assign(r, patch, { updated_at: ts() });
      return { row: clone(r) };
    },
    async deleteResource(ws, id) {
      guard();
      const i = db.resources.findIndex((x) => x.workspace_id === ws && x.id === id);
      if (i < 0) return "not_found";
      if (db.assignments.some((a) => a.resource_id === id)) return "assigned"; // NO ACTION FK
      db.resources.splice(i, 1);
      db.documents = db.documents.filter((d) => d.resource_id !== id); // cascade
      return "deleted";
    },
    async listDocuments(ws, rid, { withContent }) {
      guard();
      return clone(db.documents.filter((d) => d.workspace_id === ws && d.resource_id === rid).sort((a, b) => a.position - b.position)).map((d) => (withContent ? d : { ...d, content: "" }));
    },
    async listDocumentStats(ws) { guard(); return db.documents.filter((d) => d.workspace_id === ws).map((d) => ({ resource_id: d.resource_id, char_count: d.content.length })); },
    // knowledge_apply_document_changes: one transaction (snapshot + restore on any error).
    async applyDocumentChanges(ws, rid, userId, changes, meta) {
      guard();
      calls.push("applyDocumentChanges");
      const snapshot = clone(db);
      try {
        const res = db.resources.find((x) => x.workspace_id === ws && x.id === rid);
        if (!res) throw pgError("P0002", "resource");
        let changed = false;
        const results = [];
        changes.forEach((c, i) => {
          if (faults.applyAfter !== undefined && i >= faults.applyAfter) throw new Error("injected database failure");
          if (c.op === "insert") {
            const row = c.doc;
            if (res.type !== row.kind) throw pgError("23503");
            if (db.documents.filter((d) => d.resource_id === rid).length >= 50) throw pgError("23514-limit");
            if (db.documents.some((d) => d.resource_id === rid && docKey(d) === docKey(row))) throw pgError("23505");
            if (row.content.length > 200000) throw pgError("23514");
            const d = { id: uuid(), workspace_id: ws, resource_id: rid, created_at: ts(), updated_at: ts(), ...row, char_count: row.content.length };
            db.documents.push(d);
            changed = true;
            results.push({ op: "insert", id: d.id, applied: true });
            return;
          }
          const d = db.documents.find((x) => x.workspace_id === ws && x.resource_id === rid && x.id === c.id);
          if (!d) {
            if (c.optional) return results.push({ op: c.op, id: c.id, applied: false });
            throw pgError("P0002", "document");
          }
          if (c.op === "replace") {
            if (d.content !== c.doc.content || d.status !== c.doc.status) changed = true;
            Object.assign(d, c.doc, { updated_at: ts(), char_count: c.doc.content.length });
          } else if (c.op === "touch") {
            if ("fetched_at" in c) d.fetched_at = c.fetched_at;
            if ("error" in c) d.error = c.error;
          } else if (c.op === "delete") {
            db.documents.splice(db.documents.indexOf(d), 1);
            changed = true;
          } else throw pgError("22023");
          results.push({ op: c.op, id: d.id, applied: true });
        });
        if (faults.beforeVersion) throw new Error("injected failure before the version update");
        res.status = K.deriveResourceStatus(db.documents.filter((d) => d.resource_id === rid));
        res.content_version += changed ? 1 : 0; // database-side increment
        res.updated_by = userId;
        if ("last_error" in meta) res.last_error = meta.last_error;
        if ("last_refreshed_at" in meta) res.last_refreshed_at = meta.last_refreshed_at;
        res.updated_at = ts();
        return { row: clone(res), changed, results };
      } catch (e) {
        restore(snapshot);
        return mapError(e, { "P0002": (h) => ({ notFound: h }), "23514-limit": () => ({ limit: true }), "23505": () => ({ conflict: true }) });
      }
    },
    // knowledge_duplicate_resource: one transaction.
    async duplicateResource(ws, sourceId, name, userId) {
      guard();
      calls.push("duplicateResource");
      const snapshot = clone(db);
      try {
        const src = db.resources.find((x) => x.workspace_id === ws && x.id === sourceId);
        if (!src) throw pgError("P0002", "resource");
        if (db.resources.some((r) => r.workspace_id === ws && r.name.trim().toLowerCase() === name.trim().toLowerCase())) throw pgError("23505");
        const dst = {
          id: uuid(), workspace_id: ws, name: name.trim(), description: src.description, type: src.type, status: "empty",
          refresh_enabled: src.refresh_enabled, refresh_interval_hours: src.refresh_interval_hours, next_refresh_at: null, last_refreshed_at: null, last_error: null,
          content_version: 0, created_by: userId, updated_by: userId, created_at: ts(), updated_at: ts(),
        };
        db.resources.push(dst);
        const docs = db.documents.filter((d) => d.workspace_id === ws && d.resource_id === src.id).sort((a, b) => a.position - b.position);
        docs.forEach((d, i) => {
          if (faults.duplicateAfter !== undefined && i >= faults.duplicateAfter) throw new Error("injected database failure");
          db.documents.push({ ...clone(d), id: uuid(), resource_id: dst.id, position: i, created_at: ts(), updated_at: ts() });
        });
        dst.status = K.deriveResourceStatus(db.documents.filter((d) => d.resource_id === dst.id));
        dst.content_version = docs.length ? 1 : 0;
        return { row: clone(dst), documents: docs.length };
      } catch (e) {
        restore(snapshot);
        return mapError(e, { "P0002": () => ({ notFound: true }), "23505": () => ({ conflict: "name" }) });
      }
    },
    async listAssignments(ws, ids) {
      guard();
      return db.assignments
        .filter((a) => a.workspace_id === ws && (!ids || ids.includes(a.resource_id)))
        .map((a) => ({ resource_id: a.resource_id, agent_id: a.agent_id, agent_name: db.agents.find((g) => g.id === a.agent_id)?.name ?? "" }));
    },
  };
  return { store, db, calls, faults, setMissing: (v) => { missing = v; } };
}

// ------------------------------------------------------------ harness

const ROLES = { owner: "owner", manager: "manager", doctor: "doctor", agent: "agent" };
function world() {
  const s = makeStore();
  const ingest = { extract: async () => ({ ok: true, text: "default text" }), sites: {} };
  const logs = [];
  const deps = (who = "owner", ws = WS_A, opts = {}) => ({
    authorize: async () => {
      if (who === "anon") return { ok: false, status: 401, error: "Sign in first." };
      if (who === "forged") return { ok: false, status: 401, error: "Invalid or expired session." };
      if (who === "outsider") return { ok: false, status: 403, error: "You are not a member of this workspace." };
      return { ok: true, userId: `user-${who}`, workspaceId: ws, role: ROLES[who], isAdmin: who === "owner" };
    },
    serviceRoleConfigured: () => opts.noServiceRole !== true,
    store: s.store,
    ingest: () => ({
      extract: (f) => ingest.extract(f),
      importSite: async (url) => ingest.sites[url] ?? { ok: false, status: 502, error: "Could not load the page.", code: "fetch_failed" },
    }),
    now: () => new Date("2026-10-01T12:00:00Z"),
    log: (l) => logs.push(l),
  });
  const call = async (p) => {
    const res = await p;
    return { status: res.status, body: await res.json() };
  };
  // The same (mode, operation, service function) pairs as the route files.
  const api = {
    list: (d, q = {}) => call(withKnowledge(d, "read", "list", ({ ws, store }) => S.listResources(store, ws, q))),
    create: (d, body) => call(withKnowledge(d, "write", "create", ({ ws, userId, store }) => S.createResource(store, ws, userId, body))),
    detail: (d, id) => call(withKnowledge(d, "read", "detail", ({ ws, store }) => S.getResourceDetail(store, ws, id))),
    patch: (d, id, body) => call(withKnowledge(d, "write", "update", ({ ws, userId, store }) => S.updateResource(store, ws, userId, id, body))),
    del: (d, id) => call(withKnowledge(d, "write", "delete", ({ ws, store }) => S.deleteResource(store, ws, id))),
    dup: (d, id) => call(withKnowledge(d, "write", "duplicate", ({ ws, userId, store }) => S.duplicateResource(store, ws, userId, id))),
    upload: (d, id, file) => call(withKnowledge(d, "write", "upload", ({ ws, userId, store, extract, now }) => S.uploadFile(store, ws, userId, id, file, extract, now))),
    url: (d, id, body) => call(withKnowledge(d, "write", "url_add", ({ ws, userId, store, importSite, now }) => S.addUrl(store, ws, userId, id, body, importSite, now))),
    refresh: (d, id) => call(withKnowledge(d, "write", "refresh", ({ ws, userId, store, importSite, now }) => S.refreshResource(store, ws, userId, id, importSite, now))),
    delDoc: (d, id, docId) => call(withKnowledge(d, "write", "document_delete", ({ ws, userId, store }) => S.deleteDocument(store, ws, userId, id, docId))),
  };
  const file = (name, text = "x") => ({ buf: Buffer.from(text), name, mime: "text/plain" });
  return { ...s, ingest, deps, api, logs, file };
}

async function seed(w, ws = WS_A) {
  const fileRes = (await w.api.create(w.deps("owner", ws), { name: `Pricing ${ws.slice(0, 4)}`, type: "file" })).body.resource;
  const urlRes = (await w.api.create(w.deps("owner", ws), { name: `Website ${ws.slice(0, 4)}`, type: "url" })).body.resource;
  w.ingest.extract = async () => ({ ok: true, text: `${SECRET} Cleaning AED 300.` });
  const up = await w.api.upload(w.deps("owner", ws), fileRes.id, w.file("prices.pdf"));
  return { fileRes, urlRes, docId: up.body.documentId };
}

// ------------------------------------------------------------ authentication / authorization

test("anonymous and forged sessions → 401; a non-member → 403 (every route)", async () => {
  const w = world();
  const { fileRes } = await seed(w);
  for (const who of ["anon", "forged", "outsider"]) {
    const d = w.deps(who);
    const results = [
      await w.api.list(d), await w.api.create(d, { name: "X", type: "file" }), await w.api.detail(d, fileRes.id),
      await w.api.patch(d, fileRes.id, { name: "Y" }), await w.api.del(d, fileRes.id), await w.api.dup(d, fileRes.id),
      await w.api.upload(d, fileRes.id, w.file("a.txt")), await w.api.url(d, fileRes.id, { url: "https://example.com" }),
      await w.api.refresh(d, fileRes.id), await w.api.delDoc(d, fileRes.id, fileRes.id),
    ];
    for (const r of results) {
      assert.equal(r.status, who === "outsider" ? 403 : 401, who);
      assert.equal(r.body.ok, false);
    }
  }
  assert.equal(w.db.resources.length, 2, "nothing changed");
});

test("roles: owner/manager may mutate; doctor/agent may read but every mutation is 403", async () => {
  const w = world();
  const { fileRes, urlRes, docId } = await seed(w);
  for (const who of ["doctor", "agent"]) {
    const d = w.deps(who);
    assert.equal((await w.api.list(d)).status, 200, `${who} list`);
    assert.equal((await w.api.detail(d, fileRes.id)).status, 200, `${who} detail`);
    for (const r of [
      await w.api.create(d, { name: "Z", type: "file" }), await w.api.patch(d, fileRes.id, { name: "Z" }), await w.api.del(d, fileRes.id),
      await w.api.dup(d, fileRes.id), await w.api.upload(d, fileRes.id, w.file("z.txt")), await w.api.url(d, urlRes.id, { url: "https://example.com" }),
      await w.api.refresh(d, urlRes.id), await w.api.delDoc(d, fileRes.id, docId),
    ]) {
      assert.equal(r.status, 403, who);
      assert.equal(r.body.code, "forbidden_role");
    }
  }
  assert.equal((await w.api.create(w.deps("manager"), { name: "By manager", type: "file" })).status, 201);
  assert.equal((await w.api.patch(w.deps("manager"), fileRes.id, { description: "edited" })).status, 200);
  assert.equal((await w.api.create(w.deps("owner"), { name: "By owner", type: "url" })).status, 201);
});

// ------------------------------------------------------------ workspace isolation

test("foreign-workspace resources and documents are 404 on every route, with nothing revealed or changed", async () => {
  const w = world();
  const { fileRes: foreignFile, urlRes: foreignUrl, docId: foreignDoc } = await seed(w, WS_B);
  const before = JSON.stringify(w.db);
  const d = w.deps("owner", WS_A);
  const checks = [
    await w.api.detail(d, foreignFile.id), await w.api.patch(d, foreignFile.id, { name: "Hijack" }), await w.api.del(d, foreignFile.id),
    await w.api.dup(d, foreignFile.id), await w.api.upload(d, foreignFile.id, w.file("prices.pdf")), await w.api.url(d, foreignUrl.id, { url: "https://example.com" }),
    await w.api.refresh(d, foreignUrl.id), await w.api.delDoc(d, foreignFile.id, foreignDoc),
  ];
  for (const r of checks) {
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "resource_not_found");
    assert.ok(!JSON.stringify(r.body).includes(SECRET) && !JSON.stringify(r.body).includes("Pricing bbbb"));
  }
  assert.equal(JSON.stringify(w.db), before);
  // A malformed id is also a plain 404.
  assert.equal((await w.api.detail(d, "not-a-uuid")).status, 404);
  // The list only ever shows the session workspace.
  assert.deepEqual((await w.api.list(d)).body.resources, []);
});

test("a document of another resource / workspace can't be deleted through this resource", async () => {
  const w = world();
  const a = await seed(w, WS_A);
  const b = await seed(w, WS_B);
  const other = (await w.api.create(w.deps("owner"), { name: "Second", type: "file" })).body.resource;
  assert.equal((await w.api.delDoc(w.deps("owner"), other.id, a.docId)).body.code, "document_not_found", "wrong resource");
  assert.equal((await w.api.delDoc(w.deps("owner"), a.fileRes.id, b.docId)).body.code, "document_not_found", "wrong workspace");
  assert.equal(w.db.documents.length, 2);
});

test("client-supplied workspace / ownership / version / status fields are refused; the session decides", async () => {
  const w = world();
  for (const field of ["workspace_id", "workspaceId", "ws", "created_by", "updated_by", "content_version", "status", "id"]) {
    const r = await w.api.create(w.deps("owner", WS_A), { name: `N ${field}`, type: "file", [field]: field === "content_version" ? 99 : WS_B });
    assert.equal(r.status, 400, field);
    assert.equal(r.body.code, "field_not_allowed", field);
  }
  const ok = await w.api.create(w.deps("owner", WS_A), { name: "Mine", type: "file" });
  assert.equal(w.db.resources.find((r) => r.id === ok.body.resource.id).workspace_id, WS_A);
  assert.equal(w.db.resources.find((r) => r.id === ok.body.resource.id).created_by, "user-owner");
  assert.equal((await w.api.patch(w.deps("owner"), ok.body.resource.id, { workspace_id: WS_B })).body.code, "field_not_allowed");
  assert.equal((await w.api.patch(w.deps("owner"), ok.body.resource.id, { content_version: 7 })).body.code, "field_not_allowed");
});

// ------------------------------------------------------------ CRUD

test("create: validated by A2, 201 with the resource; duplicate name (case-insensitive) → 409", async () => {
  const w = world();
  const r = await w.api.create(w.deps("owner"), { name: "  LHDM   Services ", description: " Doctors ", type: "url", refreshEnabled: true, refreshIntervalHours: 24 });
  assert.equal(r.status, 201);
  assert.equal(r.body.resource.name, "LHDM Services");
  assert.equal(r.body.resource.status, "empty");
  assert.equal(r.body.resource.contentVersion, 0);
  assert.equal(r.body.resource.refreshIntervalHours, 24);
  assert.equal((await w.api.create(w.deps("owner"), { name: "lhdm services", type: "file" })).status, 409);
  assert.equal((await w.api.create(w.deps("owner"), { name: "", type: "file" })).body.code, "name_required");
  assert.equal((await w.api.create(w.deps("owner"), { name: "x".repeat(81), type: "file" })).body.code, "name_too_long");
  assert.equal((await w.api.create(w.deps("owner"), { name: "T", type: "text" })).body.code, "type_invalid");
  assert.equal((await w.api.create(w.deps("owner"), null)).body.code, "invalid_body");
  // The same name may exist in another workspace.
  assert.equal((await w.api.create(w.deps("owner", WS_B), { name: "LHDM Services", type: "url" })).status, 201);
});

test("list: summaries with counts and assigned agents; q / type / status filters", async () => {
  const w = world();
  const { fileRes, urlRes } = await seed(w);
  w.db.agents.push({ id: "agent-1", name: "Laura" }, { id: "agent-2", name: "Tina" });
  w.db.assignments.push({ workspace_id: WS_A, agent_id: "agent-2", resource_id: fileRes.id }, { workspace_id: WS_A, agent_id: "agent-1", resource_id: fileRes.id });
  const all = (await w.api.list(w.deps("agent"))).body.resources;
  const f = all.find((r) => r.id === fileRes.id);
  assert.equal(f.documentCount, 1);
  assert.equal(f.charCount, `${SECRET} Cleaning AED 300.`.length);
  assert.equal(f.assignedAgentCount, 2);
  assert.deepEqual(f.assignedAgents.map((a) => a.name), ["Laura", "Tina"]);
  assert.equal(f.status, "ready");
  assert.ok(!JSON.stringify(all).includes(SECRET), "no document content in the list");
  assert.deepEqual((await w.api.list(w.deps("owner"), { type: "url" })).body.resources.map((r) => r.id), [urlRes.id]);
  assert.deepEqual((await w.api.list(w.deps("owner"), { status: "empty" })).body.resources.map((r) => r.id), [urlRes.id]);
  assert.deepEqual((await w.api.list(w.deps("owner"), { q: "pric" })).body.resources.map((r) => r.id), [fileRes.id]);
  assert.equal((await w.api.list(w.deps("owner"), { type: "pdf" })).status, 400);
  assert.equal((await w.api.list(w.deps("owner"), { status: "done" })).status, 400);
});

test("detail: metadata, documents with a 300-character preview (not the full content), assigned agents", async () => {
  const w = world();
  const { fileRes } = await seed(w);
  w.ingest.extract = async () => ({ ok: true, text: "P".repeat(5000) });
  await w.api.upload(w.deps("owner"), fileRes.id, w.file("long.txt"));
  const r = await w.api.detail(w.deps("doctor"), fileRes.id);
  assert.equal(r.status, 200);
  const long = r.body.documents.find((d) => d.filename === "long.txt");
  assert.equal(long.preview.length, 300);
  assert.equal(long.chars, 5000);
  assert.ok(!("content" in long), "full content never returned");
  assert.deepEqual(r.body.assignedAgents, []);
});

test("patch: name / description / refresh only; type change refused; name conflict 409", async () => {
  const w = world();
  const { fileRes, urlRes } = await seed(w);
  const p = await w.api.patch(w.deps("owner"), urlRes.id, { name: "Clinic site", description: "main", refreshEnabled: true, refreshIntervalHours: 12 });
  assert.equal(p.status, 200);
  assert.equal(p.body.resource.name, "Clinic site");
  assert.equal(p.body.resource.refreshEnabled, true);
  assert.equal((await w.api.patch(w.deps("owner"), fileRes.id, { type: "url" })).body.code, "type_immutable");
  assert.equal((await w.api.patch(w.deps("owner"), fileRes.id, { refreshEnabled: true, refreshIntervalHours: 6 })).body.code, "refresh_not_supported");
  assert.equal((await w.api.patch(w.deps("owner"), fileRes.id, { name: "CLINIC SITE" })).status, 409);
});

test("delete: unassigned → deleted with its documents; assigned → 409 listing the agents; the DB FK is the final word", async () => {
  const w = world();
  const { fileRes, urlRes } = await seed(w);
  w.db.agents.push({ id: "agent-1", name: "Laura" }, { id: "agent-2", name: "Tina" });
  w.db.assignments.push({ workspace_id: WS_A, agent_id: "agent-1", resource_id: fileRes.id }, { workspace_id: WS_A, agent_id: "agent-2", resource_id: fileRes.id });
  const blocked = await w.api.del(w.deps("owner"), fileRes.id);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "resource_assigned");
  assert.equal(blocked.body.count, 2);
  assert.deepEqual(blocked.body.agents.map((a) => a.agentName), ["Laura", "Tina"]);
  assert.ok(w.db.resources.some((r) => r.id === fileRes.id));
  // Race: no assignment visible to the pre-check, but the FK refuses.
  const realList = w.store.listAssignments;
  let first = true;
  w.store.listAssignments = async (...a) => (first ? ((first = false), []) : realList(...a));
  assert.equal((await w.api.del(w.deps("owner"), fileRes.id)).status, 409);
  w.store.listAssignments = realList;
  // Unassigned: deleted, documents cascade.
  const ok = await w.api.del(w.deps("manager"), urlRes.id);
  assert.equal(ok.status, 200);
  assert.ok(!w.db.resources.some((r) => r.id === urlRes.id));
});

// ------------------------------------------------------------ duplicate

async function seedDup(w) {
  const { fileRes } = await seed(w);
  for (const [n, t] of [["b.txt", "Bravo"], ["c.txt", "Charlie"]]) {
    w.ingest.extract = async () => ({ ok: true, text: t });
    await w.api.upload(w.deps("owner"), fileRes.id, w.file(n));
  }
  w.db.agents.push({ id: "agent-1", name: "Laura" });
  w.db.assignments.push({ workspace_id: WS_A, agent_id: "agent-1", resource_id: fileRes.id });
  return fileRes;
}

test("duplicate: owner and manager → 201 copy with new ids, same order, collision-safe name, zero assignments; source unchanged", async () => {
  const w = world();
  const src = await seedDup(w);
  await w.api.create(w.deps("owner"), { name: `${src.name} Copy`, type: "file" });
  const srcDocs = JSON.stringify(w.db.documents.filter((d) => d.resource_id === src.id));
  const srcRow = JSON.stringify(w.db.resources.find((r) => r.id === src.id));
  const r = await w.api.dup(w.deps("owner"), src.id);
  assert.equal(r.status, 201);
  assert.equal(r.body.ok, true);
  assert.notEqual(r.body.resource.id, src.id, "new resource id");
  assert.equal(r.body.resource.name, `${src.name} Copy 2`, "collision-safe name from A2 copyName");
  assert.equal(r.body.duplicatedFrom, src.id);
  assert.equal(r.body.copiedDocuments, 3);
  assert.equal(r.body.resource.assignedAgentCount, 0);
  assert.deepEqual(r.body.assignedAgents, []);
  assert.equal(r.body.resource.contentVersion, 1);
  assert.equal(r.body.resource.status, "ready");
  const copies = w.db.documents.filter((d) => d.resource_id === r.body.resource.id).sort((a, b) => a.position - b.position);
  const originals = w.db.documents.filter((d) => d.resource_id === src.id).sort((a, b) => a.position - b.position);
  assert.deepEqual(copies.map((d) => d.filename), ["prices.pdf", "b.txt", "c.txt"], "order preserved");
  assert.deepEqual(copies.map((d) => d.position), [0, 1, 2]);
  for (const c of copies) assert.ok(!originals.some((o) => o.id === c.id), "new document ids");
  assert.deepEqual(copies.map((d) => [d.content, d.content_hash]), originals.map((d) => [d.content, d.content_hash]), "content + hash copied");
  assert.equal(w.db.assignments.filter((a) => a.resource_id === r.body.resource.id).length, 0, "assignments not copied");
  assert.equal(JSON.stringify(w.db.documents.filter((d) => d.resource_id === src.id)), srcDocs, "source documents unchanged");
  assert.equal(JSON.stringify(w.db.resources.find((x) => x.id === src.id)), srcRow, "source resource unchanged");
  assert.ok(!JSON.stringify(r.body).includes("duplicate_requires_atomic_rpc"));
  // Manager may duplicate too; the next copy name continues the sequence.
  const m = await w.api.dup(w.deps("manager"), src.id);
  assert.equal(m.status, 201);
  assert.equal(m.body.resource.name, `${src.name} Copy 3`);
});

test("duplicate: doctor/agent → 403; foreign workspace → 404; nothing written", async () => {
  const w = world();
  const src = await seedDup(w);
  const before = JSON.stringify(w.db);
  for (const who of ["doctor", "agent"]) {
    const r = await w.api.dup(w.deps(who), src.id);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "forbidden_role");
  }
  const foreign = await w.api.dup(w.deps("owner", WS_B), src.id);
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.code, "resource_not_found");
  // Even if the service pre-check were bypassed, the database function refuses another workspace.
  assert.deepEqual(await w.store.duplicateResource(WS_B, src.id, "Stolen Copy", "user-x"), { notFound: true });
  assert.equal(JSON.stringify(w.db), before);
});

test("duplicate: a database failure mid-copy leaves NO partial resource or documents; a name race re-plans", async () => {
  const w = world();
  const src = await seedDup(w);
  const before = JSON.stringify(w.db);
  w.faults.duplicateAfter = 2; // fails after copying 2 of 3 documents
  const r = await w.api.dup(w.deps("owner"), src.id);
  assert.equal(r.status, 500);
  assert.equal(r.body.code, "internal_error");
  assert.equal(JSON.stringify(w.db), before, "rolled back: no copy resource, no copied documents");
  delete w.faults.duplicateAfter;
  // Name taken between planning and the database call → re-planned, never a partial copy.
  const real = w.store.duplicateResource;
  let raced = false;
  w.store.duplicateResource = async (ws, id, name, user) => {
    if (!raced) {
      raced = true;
      await w.api.create(w.deps("owner"), { name, type: "file" });
    }
    return real(ws, id, name, user);
  };
  const ok = await w.api.dup(w.deps("owner"), src.id);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.resource.name, `${src.name} Copy 2`);
  w.store.duplicateResource = real;
  // Empty source → copy with version 0 and status empty.
  const empty = (await w.api.create(w.deps("owner"), { name: "Empty", type: "url" })).body.resource;
  const e = await w.api.dup(w.deps("owner"), empty.id);
  assert.equal(e.status, 201);
  assert.equal(e.body.resource.contentVersion, 0);
  assert.equal(e.body.resource.status, "empty");
});

// ------------------------------------------------------------ files

test("file upload: insert → 201; same name (case-insensitive) replaces in place, keeps the id, bumps version ONCE", async () => {
  const w = world();
  const { fileRes, docId } = await seed(w);
  const v0 = w.db.resources.find((r) => r.id === fileRes.id).content_version;
  assert.equal(v0, 1, "first upload bumped once");
  w.ingest.extract = async () => ({ ok: true, text: "Cleaning AED 350." });
  const r = await w.api.upload(w.deps("manager"), fileRes.id, w.file("PRICES.PDF"));
  assert.equal(r.status, 200);
  assert.equal(r.body.action, "replaced");
  assert.equal(r.body.documentId, docId);
  assert.equal(r.body.resource.contentVersion, 2);
  const docs = w.db.documents.filter((d) => d.resource_id === fileRes.id);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].content, "Cleaning AED 350.");
  assert.equal(docs[0].filename, "prices.pdf", "original casing kept");
  assert.equal(docs[0].content_hash, await K.contentHash("Cleaning AED 350."), "server-computed hash");
});

test("unchanged re-upload: no write, no version bump", async () => {
  const w = world();
  const { fileRes } = await seed(w);
  const r = await w.api.upload(w.deps("owner"), fileRes.id, w.file("prices.pdf"));
  assert.equal(r.body.action, "unchanged");
  assert.equal(r.body.resource.contentVersion, 1);
});

test("failed extraction: a new file is rejected with the extractor's status; a replacement keeps the old content", async () => {
  const w = world();
  const { fileRes } = await seed(w);
  w.ingest.extract = async () => ({ ok: false, status: 415, error: "Unsupported file type." });
  const fresh = await w.api.upload(w.deps("owner"), fileRes.id, w.file("new.bin"));
  assert.equal(fresh.status, 415);
  assert.equal(fresh.body.code, "extraction_failed");
  const repl = await w.api.upload(w.deps("owner"), fileRes.id, w.file("prices.pdf"));
  assert.equal(repl.status, 415);
  assert.equal(repl.body.kept, true);
  const doc = w.db.documents.find((d) => d.filename === "prices.pdf");
  assert.match(doc.content, /Cleaning AED 300/, "old good content untouched");
  assert.equal(doc.error, "Unsupported file type.");
  assert.equal(w.db.resources.find((r) => r.id === fileRes.id).content_version, 1, "no bump");
  assert.equal(w.db.documents.length, 1);
});

test("50-document cap → 413; resource-type mismatch → 400; truncation reported; upload size cap → 413; no file → 400", async () => {
  const w = world();
  const { fileRes, urlRes } = await seed(w);
  for (let i = 1; i < 50; i++) {
    w.ingest.extract = async () => ({ ok: true, text: `doc ${i}` });
    assert.equal((await w.api.upload(w.deps("owner"), fileRes.id, w.file(`f${i}.txt`))).status, 201);
  }
  const over = await w.api.upload(w.deps("owner"), fileRes.id, w.file("f51.txt"));
  assert.equal(over.status, 413);
  assert.equal(over.body.code, "document_limit");
  assert.equal((await w.api.upload(w.deps("owner"), urlRes.id, w.file("a.txt"))).body.code, "type_mismatch");
  const w2 = world();
  const s2 = await seed(w2);
  w2.ingest.extract = async () => ({ ok: true, text: "y".repeat(250_000) });
  const big = await w2.api.upload(w2.deps("owner"), s2.fileRes.id, w2.file("big.txt"));
  assert.equal(big.status, 201);
  assert.equal(big.body.truncated, true);
  assert.equal(w2.db.documents.find((d) => d.filename === "big.txt").content.length, 200_000);
  assert.equal((await w2.api.upload(w2.deps("owner"), s2.fileRes.id, { buf: Buffer.alloc(10 * 1024 * 1024 + 1), name: "huge.pdf", mime: "" })).status, 413);
  assert.equal((await w2.api.upload(w2.deps("owner"), s2.fileRes.id, null)).body.code, "file_required");
});

// ------------------------------------------------------------ URLs

const site = (text) => ({ ok: true, text });

test("URL add: safe public URL → document (server-fetched, server-hashed); same URL → refresh in place", async () => {
  const w = world();
  const { urlRes } = await seed(w);
  w.ingest.sites["https://example.com/"] = site("--- Website page: https://example.com/ ---\nWelcome v1");
  const a = await w.api.url(w.deps("owner"), urlRes.id, { url: "example.com" });
  assert.equal(a.status, 201);
  assert.equal(a.body.resource.contentVersion, 1);
  const doc = w.db.documents.find((d) => d.id === a.body.documentId);
  assert.equal(doc.source_url, "https://example.com/");
  assert.equal(doc.content_hash, await K.contentHash(doc.content));
  w.ingest.sites["https://example.com/"] = site("--- Website page: https://example.com/ ---\nWelcome v2");
  const again = await w.api.url(w.deps("owner"), urlRes.id, { url: "https://EXAMPLE.com/#x" });
  assert.equal(again.body.action, "replaced");
  assert.equal(again.body.documentId, a.body.documentId);
  assert.equal(again.body.resource.contentVersion, 2);
  const unchanged = await w.api.url(w.deps("owner"), urlRes.id, { url: "https://example.com/" });
  assert.equal(unchanged.body.action, "unchanged");
  assert.equal(unchanged.body.resource.contentVersion, 2);
});

test("URL add: malformed / non-http / client-supplied content refused; SSRF refusals pass through; nothing stored", async () => {
  const w = world();
  const { urlRes } = await seed(w);
  for (const url of ["", "ftp://example.com/x", "javascript:alert(1)", 42]) {
    assert.equal((await w.api.url(w.deps("owner"), urlRes.id, { url })).body.code, "source_url_required", String(url));
  }
  assert.equal((await w.api.url(w.deps("owner"), urlRes.id, { url: "https://example.com", content: "trust me" })).body.code, "field_not_allowed");
  // Private / internal / redirect-to-private: the A3 importer refuses with 400 + code (SSRF boundary).
  w.ingest.sites["http://10.0.0.5/"] = { ok: false, status: 400, error: "That address is on a private or internal network and can't be imported.", code: "private_address" };
  w.ingest.sites["https://redirects.example.com/"] = { ok: false, status: 400, error: "That website resolves to a private or internal network address and can't be imported.", code: "private_address" };
  for (const url of ["http://10.0.0.5/", "https://redirects.example.com/"]) {
    const r = await w.api.url(w.deps("owner"), urlRes.id, { url });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "private_address");
  }
  assert.equal(w.db.documents.filter((d) => d.resource_id === urlRes.id).length, 0);
  assert.equal((await w.api.url(w.deps("owner"), urlRes.id, null)).body.code, "invalid_body");
});

test("URL add into a File resource → type_mismatch; 50-document cap → 413", async () => {
  const w = world();
  const { fileRes, urlRes } = await seed(w);
  assert.equal((await w.api.url(w.deps("owner"), fileRes.id, { url: "https://example.com" })).body.code, "type_mismatch");
  for (let i = 0; i < 50; i++) {
    w.ingest.sites[`https://example.com/p${i}`] = site(`page ${i}`);
    assert.equal((await w.api.url(w.deps("owner"), urlRes.id, { url: `https://example.com/p${i}` })).status, 201);
  }
  w.ingest.sites["https://example.com/p50"] = site("page 50");
  const over = await w.api.url(w.deps("owner"), urlRes.id, { url: "https://example.com/p50" });
  assert.equal(over.status, 413);
  assert.equal(over.body.code, "document_limit");
});

// ------------------------------------------------------------ refresh

test("refresh: changed → replace + ONE version bump for the whole operation; unchanged → none; failures keep good content", async () => {
  const w = world();
  const { urlRes } = await seed(w);
  for (const p of ["a", "b", "c"]) {
    w.ingest.sites[`https://example.com/${p}`] = site(`${p} v1`);
    await w.api.url(w.deps("owner"), urlRes.id, { url: `https://example.com/${p}` });
  }
  const v = w.db.resources.find((r) => r.id === urlRes.id).content_version;
  assert.equal(v, 3);
  // a changes, b unchanged, c fails (and keeps v1).
  w.ingest.sites["https://example.com/a"] = site("a v2");
  w.ingest.sites["https://example.com/c"] = { ok: false, status: 400, error: "blocked", code: "private_address" };
  const r = await w.api.refresh(w.deps("manager"), urlRes.id);
  assert.equal(r.status, 200);
  assert.equal(r.body.changed, true);
  assert.equal(r.body.refreshed, 2);
  assert.equal(r.body.failed, 1);
  assert.deepEqual(r.body.results.map((x) => x.outcome), ["replaced", "unchanged", "kept_previous"]);
  assert.equal(r.body.resource.contentVersion, 4, "one bump for the operation even with several documents");
  assert.equal(r.body.resource.lastRefreshedAt, "2026-10-01T12:00:00.000Z");
  assert.match(r.body.resource.lastError, /1 of 3 addresses could not be refreshed: blocked/);
  assert.equal(w.db.documents.find((d) => d.source_url === "https://example.com/c").content, "c v1");
  // Nothing changed at all → no bump, last_error cleared when all succeed.
  w.ingest.sites["https://example.com/c"] = site("c v1");
  const again = await w.api.refresh(w.deps("owner"), urlRes.id);
  assert.equal(again.body.changed, false);
  assert.equal(again.body.resource.contentVersion, 4);
  assert.equal(again.body.resource.lastError, null);
});

test("refresh: File resource → type_mismatch; empty URL resource → nothing_to_refresh; time budget respected", async () => {
  const w = world();
  const { fileRes, urlRes } = await seed(w);
  assert.equal((await w.api.refresh(w.deps("owner"), fileRes.id)).body.code, "type_mismatch");
  assert.equal((await w.api.refresh(w.deps("owner"), urlRes.id)).body.code, "nothing_to_refresh");
  // Time budget: a clock that jumps past the budget skips the remaining documents.
  for (const p of ["x", "y"]) {
    w.ingest.sites[`https://example.com/${p}`] = site(p);
    await w.api.url(w.deps("owner"), urlRes.id, { url: `https://example.com/${p}` });
  }
  let t = 0;
  const out = await S.refreshResource(w.store, WS_A, "u", urlRes.id, async (u) => { t += 50_000; return site(`${u} new`); }, () => new Date(1_000_000 + t), { budgetMs: 45_000 });
  assert.deepEqual(out.body.results.map((x) => x.outcome), ["replaced", "skipped"]);
});

// ------------------------------------------------------------ document delete

test("document delete: removes only that document and bumps content_version once", async () => {
  const w = world();
  const { fileRes, docId } = await seed(w);
  w.ingest.extract = async () => ({ ok: true, text: "second" });
  await w.api.upload(w.deps("owner"), fileRes.id, w.file("second.txt"));
  const v = w.db.resources.find((r) => r.id === fileRes.id).content_version;
  const r = await w.api.delDoc(w.deps("manager"), fileRes.id, docId);
  assert.equal(r.status, 200);
  assert.equal(r.body.resource.contentVersion, v + 1);
  assert.deepEqual(w.db.documents.map((d) => d.filename), ["second.txt"]);
  assert.equal((await w.api.delDoc(w.deps("owner"), fileRes.id, docId)).status, 404, "already gone");
  await w.api.delDoc(w.deps("owner"), fileRes.id, w.db.documents[0].id);
  assert.equal(w.db.resources.find((x) => x.id === fileRes.id).status, "empty");
});

// ------------------------------------------------------------ content_version + atomicity (A4.1)

const version = (w, id) => w.db.resources.find((r) => r.id === id).content_version;
const mutating = (w) => w.calls.filter((c) => c !== "updateResource");

test("content_version matrix: insert +1, changed replace +1, unchanged 0, delete +1, URL changed +1 / unchanged 0 / failed 0", async () => {
  const w = world();
  const { fileRes, urlRes, docId } = await seed(w);
  assert.equal(version(w, fileRes.id), 1, "new document +1");
  w.ingest.extract = async () => ({ ok: true, text: "changed" });
  await w.api.upload(w.deps("owner"), fileRes.id, w.file("prices.pdf"));
  assert.equal(version(w, fileRes.id), 2, "changed replacement +1");
  await w.api.upload(w.deps("owner"), fileRes.id, w.file("prices.pdf"));
  assert.equal(version(w, fileRes.id), 2, "unchanged replacement +0");
  w.ingest.extract = async () => ({ ok: false, status: 422, error: "unreadable" });
  await w.api.upload(w.deps("owner"), fileRes.id, w.file("prices.pdf"));
  assert.equal(version(w, fileRes.id), 2, "failed extraction +0");
  await w.api.delDoc(w.deps("owner"), fileRes.id, docId);
  assert.equal(version(w, fileRes.id), 3, "document delete +1");
  w.ingest.sites["https://example.com/"] = site("v1");
  await w.api.url(w.deps("owner"), urlRes.id, { url: "https://example.com/" });
  assert.equal(version(w, urlRes.id), 1, "new URL +1");
  w.ingest.sites["https://example.com/"] = site("v2");
  await w.api.url(w.deps("owner"), urlRes.id, { url: "https://example.com/" });
  assert.equal(version(w, urlRes.id), 2, "changed URL +1");
  await w.api.url(w.deps("owner"), urlRes.id, { url: "https://example.com/" });
  assert.equal(version(w, urlRes.id), 2, "unchanged URL +0");
  w.ingest.sites["https://example.com/"] = { ok: false, status: 502, error: "down", code: "fetch_failed" };
  const failed = await w.api.url(w.deps("owner"), urlRes.id, { url: "https://example.com/" });
  assert.equal(failed.body.kept, true);
  assert.equal(version(w, urlRes.id), 2, "failed URL +0");
  assert.equal(w.db.documents.find((d) => d.resource_id === urlRes.id).content, "v2", "last good content kept");
  // Metadata edits never touch the version.
  await w.api.patch(w.deps("owner"), urlRes.id, { description: "x" });
  assert.equal(version(w, urlRes.id), 2);
});

test("multi-document refresh: several changes → ALL applied in ONE atomic call with exactly ONE increment", async () => {
  const w = world();
  const { urlRes } = await seed(w);
  for (const p of ["a", "b", "c", "d"]) {
    w.ingest.sites[`https://example.com/${p}`] = site(`${p} v1`);
    await w.api.url(w.deps("owner"), urlRes.id, { url: `https://example.com/${p}` });
  }
  const v = version(w, urlRes.id);
  for (const p of ["a", "b", "c"]) w.ingest.sites[`https://example.com/${p}`] = site(`${p} v2`);
  w.calls.length = 0;
  const r = await w.api.refresh(w.deps("owner"), urlRes.id);
  assert.deepEqual(r.body.results.map((x) => x.outcome), ["replaced", "replaced", "replaced", "unchanged"]);
  assert.equal(version(w, urlRes.id), v + 1, "three changed documents, one increment");
  assert.deepEqual(mutating(w), ["applyDocumentChanges"], "one persistence call for the whole refresh");
  // A database failure part-way through the refresh write → nothing applied (no partial refresh).
  for (const p of ["a", "b", "c", "d"]) w.ingest.sites[`https://example.com/${p}`] = site(`${p} v3`);
  const before = JSON.stringify(w.db);
  w.faults.applyAfter = 2;
  const failed = await w.api.refresh(w.deps("owner"), urlRes.id);
  assert.equal(failed.status, 500);
  assert.equal(JSON.stringify(w.db), before, "no document changed, version unchanged");
  delete w.faults.applyAfter;
});

test("refresh: a document deleted while pages were fetched is skipped (reported), never recreated", async () => {
  const w = world();
  const { urlRes } = await seed(w);
  for (const p of ["a", "b"]) {
    w.ingest.sites[`https://example.com/${p}`] = site(`${p} v1`);
    await w.api.url(w.deps("owner"), urlRes.id, { url: `https://example.com/${p}` });
  }
  const b = w.db.documents.find((d) => d.source_url === "https://example.com/b");
  w.ingest.sites["https://example.com/a"] = site("a v2");
  w.ingest.sites["https://example.com/b"] = site("b v2");
  const realImport = w.ingest.sites;
  let fetched = 0;
  const out = await S.refreshResource(w.store, WS_A, "u", urlRes.id, async (u) => {
    if (++fetched === 2) await w.api.delDoc(w.deps("owner"), urlRes.id, b.id); // concurrent delete
    return realImport[u];
  }, () => new Date("2026-10-01T12:00:00Z"));
  assert.deepEqual(out.body.results.map((x) => x.outcome), ["replaced", "removed"]);
  assert.ok(!w.db.documents.some((d) => d.id === b.id), "not recreated");
});

test("atomic contract: each document operation makes exactly ONE persistence call; a failure inside it changes nothing", async () => {
  const w = world();
  const { fileRes, urlRes, docId } = await seed(w);
  const ops = [
    ["upload insert", async () => { w.ingest.extract = async () => ({ ok: true, text: "n" }); return w.api.upload(w.deps("owner"), fileRes.id, w.file("n.txt")); }],
    ["upload replace", async () => { w.ingest.extract = async () => ({ ok: true, text: "r" }); return w.api.upload(w.deps("owner"), fileRes.id, w.file("prices.pdf")); }],
    ["url add", async () => { w.ingest.sites["https://example.com/z"] = site("z"); return w.api.url(w.deps("owner"), urlRes.id, { url: "https://example.com/z" }); }],
    ["document delete", async () => w.api.delDoc(w.deps("owner"), fileRes.id, docId)],
    ["duplicate", async () => w.api.dup(w.deps("owner"), fileRes.id)],
  ];
  for (const [name, run] of ops) {
    // 1) Injected failure after the document write but before the version update → full rollback.
    w.faults.beforeVersion = true;
    if (name === "duplicate") w.faults.duplicateAfter = 0; // fails on the first copied document
    const before = JSON.stringify(w.db);
    w.calls.length = 0;
    const failed = await run();
    assert.equal(failed.status, 500, name);
    assert.equal(JSON.stringify(w.db), before, `${name}: no changed document with a stale version`);
    assert.equal(mutating(w).length, 1, `${name}: one persistence call`);
    delete w.faults.beforeVersion;
    delete w.faults.duplicateAfter;
    // 2) Success: still exactly one call.
    w.calls.length = 0;
    const r = await run();
    assert.ok(r.status === 200 || r.status === 201, `${name} ${r.status}`);
    assert.equal(mutating(w).length, 1, `${name}: one persistence call`);
  }
});

// ------------------------------------------------------------ fail closed

test("migration 0065 missing → 503 knowledge_migration_missing on every route (never empty, 404 or 500)", async () => {
  const w = world();
  const { fileRes, urlRes, docId } = await seed(w);
  w.setMissing(true);
  const d = w.deps("owner");
  for (const r of [
    await w.api.list(d), await w.api.create(d, { name: "New", type: "file" }), await w.api.detail(d, fileRes.id), await w.api.patch(d, fileRes.id, { name: "N" }),
    await w.api.del(d, fileRes.id), await w.api.dup(d, fileRes.id), await w.api.upload(d, fileRes.id, w.file("a.txt")),
    await w.api.url(d, urlRes.id, { url: "https://example.com" }), await w.api.refresh(d, urlRes.id), await w.api.delDoc(d, fileRes.id, docId),
  ]) {
    assert.equal(r.status, 503);
    assert.equal(r.body.code, "knowledge_migration_missing");
  }
  assert.equal((await w.api.list(w.deps("doctor"))).status, 503, "reads too");
});

test("missing service role → 503; unexpected store error → generic 500 without internals; logs carry no content", async () => {
  const w = world();
  const { fileRes } = await seed(w);
  assert.equal((await w.api.list(w.deps("owner", WS_A, { noServiceRole: true }))).body.code, "service_unavailable");
  w.store.getResource = async () => { throw new Error(`relation secret_table syntax error near ${SECRET}`); };
  const r = await w.api.detail(w.deps("owner"), fileRes.id);
  assert.equal(r.status, 500);
  assert.equal(r.body.code, "internal_error");
  assert.ok(!JSON.stringify(r.body).includes("secret_table") && !JSON.stringify(r.body).includes(SECRET));
  assert.ok(w.logs.length > 0);
  for (const line of w.logs) {
    assert.ok(!line.includes(SECRET) && !line.includes("Cleaning AED"), line);
    assert.match(line, /^\[knowledge\] op=[a-z_]+ ws=[0-9a-f-]+ status=\d{3}/);
  }
});

// ------------------------------------------------------------ static wiring

test("route files bind each operation to the right access mode and service function", () => {
  const B = "src/app/api/knowledge/resources";
  const expect = [
    [`${B}/route.ts`, /export async function GET[\s\S]*?"read", "list"[\s\S]*?listResources\(store, ws/],
    [`${B}/route.ts`, /export async function POST[\s\S]*?"write", "create"[\s\S]*?createResource\(store, ws, userId, body\)/],
    [`${B}/[id]/route.ts`, /export async function GET[\s\S]*?"read", "detail"[\s\S]*?getResourceDetail\(store, ws, id\)/],
    [`${B}/[id]/route.ts`, /export async function PATCH[\s\S]*?"write", "update"[\s\S]*?updateResource\(store, ws, userId, id, body\)/],
    [`${B}/[id]/route.ts`, /export async function DELETE[\s\S]*?"write", "delete"[\s\S]*?deleteResource\(store, ws, id\)/],
    [`${B}/[id]/duplicate/route.ts`, /"write", "duplicate"[\s\S]*?duplicateResource\(store, ws, userId, id\)/],
    [`${B}/[id]/files/route.ts`, /"write", "upload"[\s\S]*?uploadFile\(store, ws, userId, id, file, extract, now\)/],
    [`${B}/[id]/urls/route.ts`, /"write", "url_add"[\s\S]*?addUrl\(store, ws, userId, id, body, importSite, now\)/],
    [`${B}/[id]/refresh/route.ts`, /"write", "refresh"[\s\S]*?refreshResource\(store, ws, userId, id, importSite, now\)/],
    [`${B}/[id]/documents/[docId]/route.ts`, /export async function DELETE[\s\S]*?"write", "document_delete"[\s\S]*?deleteDocument\(store, ws, userId, id, docId\)/],
  ];
  for (const [f, re] of expect) assert.match(src(f), re, f);
  for (const f of fs.readdirSync(path.join(root, B), { recursive: true }).filter((x) => String(x).endsWith("route.ts"))) {
    const s = src(path.join(B, String(f)));
    assert.match(s, /withKnowledge\(knowledgeDeps\(req\)/, String(f));
    assert.doesNotMatch(s, /supabase|searchParams\.get\("ws"\)|workspace_id|headers\.get/, `${f}: no direct DB / client workspace`);
  }
});

test("server store: every query is scoped by workspace_id; document writes only via the atomic functions; migration-missing mapped", () => {
  const s = src("src/lib/knowledge-server.ts");
  const queries = s.match(/supabase\s*\.from\([A-Z]+\)[^;]*/g) ?? [];
  assert.ok(queries.length >= 7);
  for (const q of queries) {
    if (/\.insert\(/.test(q)) assert.match(q, /workspace_id: ws/, q.slice(0, 80));
    else assert.match(q, /\.eq\("workspace_id", ws\)/, q.slice(0, 80));
  }
  // knowledge_documents is only READ directly; every write is one RPC call.
  for (const q of queries.filter((x) => /\.from\(DOCS\)/.test(x))) assert.doesNotMatch(q, /\.(insert|update|delete|upsert)\(/, q.slice(0, 80));
  const rpcs = [...s.matchAll(/supabase\.rpc\("([a-z_]+)", \{([^}]*)\}/g)];
  assert.deepEqual(rpcs.map((m) => m[1]).sort(), ["knowledge_apply_document_changes", "knowledge_duplicate_resource"]);
  for (const m of rpcs) assert.match(m[2], /p_workspace_id: ws,/, `${m[1]} gets the SESSION workspace`);
  // The application never computes or writes content_version / status.
  const code = (f) => src(f).replace(/^\s*\/\/[^\n]*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const f of ["src/lib/knowledge-server.ts", "src/lib/knowledge-service.ts"]) {
    // (the row TYPE declares `content_version: number`; no value is ever assigned)
    assert.doesNotMatch(code(f), /content_version\s*(=|:(?!\s*number\b))|content_version \+|contentVersion \+ 1/, f);
  }
  assert.doesNotMatch(code("src/lib/knowledge-service.ts"), /store\.(insertDocument|updateDocument|deleteDocument)|syncResource|expectedVersion/);
  assert.match(s, /throw new KnowledgeMigrationMissing\(\)/);
  assert.match(s, /error\.code === "42P01" \|\| error\.code === "PGRST205" \|\| error\.code === "42883" \|\| error\.code === "PGRST202"/);
  assert.doesNotMatch(s, /console\./);
  assert.doesNotMatch(src("src/lib/knowledge-service.ts"), /console\./);
});

test("no Central KB runtime integration: agent runtime files don't reference it; A1–A3 untouched", () => {
  for (const f of [
    "src/lib/livekit.ts", "src/app/api/livekit/agent-config/route.ts", "src/lib/agent-tools-core.ts", "src/app/api/agents/tool-exec/route.ts",
    "livekit-agent/agent.py", "src/lib/builder-tools.ts", "src/app/api/builder-tools/[agentId]/[tool]/route.ts", "src/app/api/vapi/assistants/route.ts",
    "src/lib/agent-reply.ts", "src/app/api/chat/route.ts", "src/app/api/whatsapp/webhook/route.ts", "src/app/api/sms/webhook/route.ts",
    "src/components/dashboard/agents-shared.tsx", "src/lib/db.ts", "src/lib/agent-management.ts", "src/lib/kb-retrieval.ts",
  ]) {
    assert.doesNotMatch(src(f), /knowledge-service|knowledge-server|knowledge-route|\/api\/knowledge|knowledge_resources|knowledge_documents/, f);
  }
});
