// Canary P9 functional validation — PURE OFFLINE tests. The write transport is
// an in-memory fake implementing exactly the pinned 0065/0067/0068 contracts
// (P0002 on cross-workspace lookups, stale-by-hash with no write, FK-checked
// assignments, workspace-cascade delete); the read-only executor answers from
// the same state. The REAL committed chunker runs — that is the code under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { okEnv, FAKE_SENTINEL_TOKEN } from "./canary-fixtures.mjs";

const guard = await import("../scripts/canary-guard.ts");
const plan = await import("../scripts/canary-plan-lib.ts");
const preflight = await import("../scripts/canary-preflight-lib.ts");
const sentinel = await import("../scripts/canary-sentinel.ts");
const probeLib = await import("../scripts/canary-probe-lib.ts");
const lib = await import("../scripts/canary-validate-lib.ts");

const { CanaryValidateError, runCanary2bFunctionalValidation } = lib;
const validateStops = (code) => (e) => e instanceof CanaryValidateError && e.code === code;
const guardStops = (code) => (e) => e instanceof guard.CanaryError && e.code === code;
const probeStops = (code) => (e) => e instanceof probeLib.CanaryProbeError && e.code === code;

const FAKE_DIGEST = createHash("sha256").update(FAKE_SENTINEL_TOKEN.toLowerCase(), "utf8").digest("hex");
const p9Env = (extra = {}) => okEnv({ CANARY_SENTINEL_TOKEN: FAKE_SENTINEL_TOKEN, ...extra });

const MARKER_DONE = {
  "baseline-0001-0064": { m0001: true, m0014: true, m0064: true },
  "apply-0065": { resources: true, documents: true, assignments: true, apply_fn: true },
  "apply-0067": { resources_crud: true, documents_crud: true, assignments_crud: true },
  "apply-0066": { slot_minutes: true },
  "apply-0068": { chunks: true, reindex_fn: true, match_fn: true },
};
const ACL_CLEAN = [{ objtype: "f", owner: "postgres", api_role_grantees: "anon" }];

const httpError = (text) => new probeLib.CanaryProbeError("PROBE_HTTP_ERROR", `fake: HTTP 400 ${text}`);

/** In-memory canary KB implementing the pinned contracts. */
function makeFakeDb() {
  const db = {
    workspaces: new Map(), // id -> name
    resources: new Map(), // id -> { wsId, version }
    agents: new Map(), // id -> wsId
    assignments: new Set(), // "ws|agent|res"
    documents: new Map(), // id -> { wsId, resId, hash, status }
    chunks: new Map(), // docId -> rows[]
    mutations: [],
    failOn: new Map(), // context -> times
  };
  const resourceVersion = (resId) => db.resources.get(resId)?.version ?? 0;

  db.validate = async (sql, params, context) => {
    db.mutations.push({ sql, params: [...params], context });
    const remaining = db.failOn.get(context) ?? 0;
    if (remaining > 0) {
      db.failOn.set(context, remaining - 1);
      throw httpError(`injected failure at ${context}`);
    }
    if (sql === probeLib.P9_SQL_CREATE_WORKSPACE) {
      db.workspaces.set(params[0], params[1]);
      return [{ id: params[0] }];
    }
    if (sql === probeLib.P9_SQL_CREATE_RESOURCE) {
      db.resources.set(params[0], { wsId: params[1], version: 0 });
      return [{ id: params[0] }];
    }
    if (sql === probeLib.P9_SQL_CREATE_AGENT) {
      db.agents.set(params[0], params[1]);
      return [{ id: params[0] }];
    }
    if (sql === probeLib.P9_SQL_CREATE_ASSIGNMENT) {
      const [ws, agent, res] = params;
      const r = db.resources.get(res);
      if (!r || r.wsId !== ws) throw httpError("23503 violates foreign key constraint agent_knowledge_resources_resource_fk");
      db.assignments.add(`${ws}|${agent}|${res}`);
      return [];
    }
    if (sql === probeLib.P9_SQL_APPLY_DOCUMENT_CHANGES) {
      const [ws, res, , changesJson] = params;
      const r = db.resources.get(res);
      if (!r || r.wsId !== ws) throw httpError("P0002 Knowledge resource not found.");
      const results = [];
      for (const change of JSON.parse(changesJson)) {
        if (change.op === "insert") {
          const id = randomUUID();
          r.version += 1;
          db.documents.set(id, { wsId: ws, resId: res, hash: change.content_hash, status: change.status });
          results.push({ id });
        } else if (change.op === "replace") {
          const d = db.documents.get(change.id);
          if (!d || d.wsId !== ws) throw httpError("P0002 Knowledge document not found.");
          r.version += 1;
          d.hash = change.content_hash;
          results.push({ id: change.id });
        } else if (change.op === "delete") {
          const d = db.documents.get(change.id);
          if (!d || d.wsId !== ws) throw httpError("P0002 Knowledge document not found.");
          db.documents.delete(change.id);
          db.chunks.delete(change.id);
          results.push({ id: change.id });
        } else {
          throw httpError("22023 Unknown knowledge change.");
        }
      }
      return [{ result: { changed: true, results } }];
    }
    if (sql === probeLib.P9_SQL_REINDEX_DOCUMENT) {
      const [ws, docId, hash, chunksJson] = params;
      const d = db.documents.get(docId);
      if (!d || d.wsId !== ws) throw httpError("P0002 Knowledge document not found.");
      if (d.hash !== hash) return [{ result: { stale_input: true, replaced: false, chunks: 0 } }];
      const parsed = JSON.parse(chunksJson);
      db.chunks.set(
        docId,
        parsed.map((c, i) => ({
          chunk_index: i,
          content: c.content,
          source_label: c.source_label,
          heading: c.heading ?? null,
          chars: c.content.length,
          content_len: c.content.length,
          content_hash: d.hash,
          content_version: resourceVersion(d.resId),
          workspace_id: ws,
          resource_id: d.resId,
          document_id: docId,
        })),
      );
      return [{ result: { stale_input: false, replaced: true, chunks: parsed.length } }];
    }
    if (sql === probeLib.P9_SQL_MATCH_CHUNKS) {
      const [ws, agent, query] = params;
      let universe = 0;
      const matches = [];
      for (const key of db.assignments) {
        const [aWs, aAgent, aRes] = key.split("|");
        if (aWs !== ws || aAgent !== agent) continue;
        for (const [docId, d] of db.documents) {
          if (d.wsId !== ws || d.resId !== aRes || d.status !== "ready") continue;
          for (const c of db.chunks.get(docId) ?? []) {
            if (c.content_hash !== d.hash) continue;
            universe += 1;
            if (c.content.includes(query)) {
              matches.push({ resource_id: aRes, document_id: docId, chunk_id: randomUUID(), chunk_index: c.chunk_index, source_label: c.source_label, heading: c.heading, content: c.content, score: 1 });
            }
          }
        }
      }
      return [{ result: { searched_chunks: universe, matches } }];
    }
    if (sql === probeLib.P9_SQL_CLEANUP_WORKSPACE) {
      const [ws, name] = params;
      if (db.workspaces.get(ws) !== name) return [];
      db.workspaces.delete(ws);
      for (const [id, r] of [...db.resources]) if (r.wsId === ws) db.resources.delete(id);
      for (const [id, aWs] of [...db.agents]) if (aWs === ws) db.agents.delete(id);
      for (const key of [...db.assignments]) if (key.startsWith(`${ws}|`)) db.assignments.delete(key);
      for (const [id, d] of [...db.documents]) if (d.wsId === ws) { db.documents.delete(id); db.chunks.delete(id); }
      return [{ id: ws }];
    }
    throw new Error(`fake db: unexpected mutation SQL ${sql.slice(0, 60)}`);
  };

  db.readOnly = (overrides = {}) => async (sql, params) => {
    if (overrides[sql]) return structuredClone(overrides[sql]);
    if (sql === sentinel.CANARY_SENTINEL_VERIFICATION_SQL) {
      assert.deepEqual(params, [FAKE_DIGEST]);
      return [{ row_count: 1, id_ok: true, ref_ok: true, token_ok: true }];
    }
    if (sql === plan.SQL_DEFAULT_ACL_API_ROLE_GRANTS) return structuredClone(ACL_CLEAN);
    if (sql === preflight.SQL_HISTORY_TABLE) return [{ present: true }];
    if (sql === preflight.SQL_HISTORY_COUNT) return [{ rows: 0 }];
    const markerStep = Object.entries(plan.STEP_MARKER_SQL).find(([, s]) => s === sql)?.[0];
    if (markerStep) return [structuredClone(MARKER_DONE[markerStep])];
    if (sql === lib.SQL_P9_RESIDUE) {
      const hits = [...db.workspaces.entries()].filter(([, n]) => n.startsWith("CANARY-2B-VALIDATION ") || n.startsWith("A7-2B-VALIDATION "));
      // Residue means rows that predate this run; the lib only queries before mutating.
      return hits.map(([id]) => ({ id }));
    }
    if (sql === lib.SQL_P9_BASELINE_COUNTS) {
      return [{
        workspaces: db.workspaces.size,
        knowledge_resources: db.resources.size,
        knowledge_documents: db.documents.size,
        knowledge_chunks: [...db.chunks.values()].reduce((s, rows) => s + rows.length, 0),
        agent_knowledge_resources: db.assignments.size,
        agents: db.agents.size,
      }];
    }
    if (sql === lib.SQL_P9_READ_CHUNKS) {
      const [ws, doc] = params;
      return structuredClone((db.chunks.get(doc) ?? []).filter((c) => c.workspace_id === ws));
    }
    if (sql === lib.SQL_P9_READ_DOCUMENT_STATE) {
      const [ws, doc] = params;
      const d = db.documents.get(doc);
      if (!d || d.wsId !== ws) return [];
      return [{ content_hash: d.hash, status: d.status, content_version: resourceVersion(d.resId) }];
    }
    if (sql === lib.SQL_P9_FTS_PROBE) {
      const [ws, doc, token] = params;
      return [{ hits: (db.chunks.get(doc) ?? []).filter((c) => c.workspace_id === ws && c.content.includes(token)).length }];
    }
    if (sql === lib.SQL_P9_VERIFY_DOCUMENT_GONE) {
      const [ws, doc] = params;
      const d = db.documents.get(doc);
      return [{ documents: d && d.wsId === ws ? 1 : 0, chunks: (db.chunks.get(doc) ?? []).length }];
    }
    if (sql === lib.SQL_P9_VERIFY_RUN_ABSENT) {
      const [ws] = params;
      return [{
        workspaces: db.workspaces.has(ws) ? 1 : 0,
        knowledge_resources: [...db.resources.values()].filter((r) => r.wsId === ws).length,
        knowledge_documents: [...db.documents.values()].filter((d) => d.wsId === ws).length,
        knowledge_chunks: [...db.chunks.values()].flat().filter((c) => c.workspace_id === ws).length,
        agent_knowledge_resources: [...db.assignments].filter((k) => k.startsWith(`${ws}|`)).length,
        agents: [...db.agents.values()].filter((a) => a === ws).length,
      }];
    }
    if (sql === lib.SQL_P9_COUNT_WORKSPACE_STATE) {
      const [ws] = params;
      return [{
        documents: [...db.documents.values()].filter((d) => d.wsId === ws).length,
        assignments: [...db.assignments].filter((k) => k.startsWith(`${ws}|`)).length,
      }];
    }
    throw new Error(`fake db: unexpected read-only SQL ${sql.slice(0, 60)}`);
  };

  return db;
}

const run = ({ db = makeFakeDb(), env = p9Env(), readOnlyOverrides = {} } = {}) => ({
  db,
  report: runCanary2bFunctionalValidation({
    env,
    readOnly: db.readOnly(readOnlyOverrides),
    probe: { runValidationStatement: db.validate },
  }),
});

test("P9 marker prefix is the committed preflight's canary marker (residue is independently detectable)", () => {
  assert.equal(probeLib.P9_VALIDATION_MARKER_PREFIX, preflight.CANARY_VALIDATION_MARKER_PREFIX);
});

test("P9 happy path: tests A-F pass, cleanup removes everything, baseline restored", async () => {
  const { db, report } = run();
  const r = await report;
  const failed = r.checks.filter((c) => !c.ok);
  assert.deepEqual(failed, [], "no failing checks");
  assert.equal(r.ok, true);
  assert.equal(r.cleanupOk, true);
  assert.equal(db.workspaces.size, 0, "both validation workspaces removed");
  assert.equal(db.documents.size, 0);
  assert.equal(db.agents.size, 0);
  assert.equal(db.assignments.size, 0);
  // knowledge_chunks was never written directly: only the frozen statements were used.
  for (const m of db.mutations) {
    assert.ok(!m.sql.toLowerCase().includes("insert into public.knowledge_chunks"), "no direct chunk writes");
  }
});

test("P9 gate failures refuse before any mutation", async () => {
  const noToken = run({ env: okEnv() });
  await assert.rejects(noToken.report, guardStops("SENTINEL_TOKEN_MISSING"));
  assert.equal(noToken.db.mutations.length, 0);

  const notMigrated = run({ readOnlyOverrides: { [plan.STEP_MARKER_SQL["apply-0068"]]: [{ chunks: false, reindex_fn: false, match_fn: false }] } });
  await assert.rejects(notMigrated.report, validateStops("P9_NOT_MIGRATED"));
  assert.equal(notMigrated.db.mutations.length, 0);

  const drift = run({ readOnlyOverrides: { [plan.SQL_DEFAULT_ACL_API_ROLE_GRANTS]: [...ACL_CLEAN, { objtype: "r", owner: "postgres", api_role_grantees: "anon" }] } });
  await assert.rejects(drift.report, validateStops("P9_ACL_NOT_HARDENED"));
  assert.equal(drift.db.mutations.length, 0);

  const history = run({ readOnlyOverrides: { [preflight.SQL_HISTORY_COUNT]: [{ rows: 2 }] } });
  await assert.rejects(history.report, validateStops("P9_HISTORY_NOT_EMPTY"));
  assert.equal(history.db.mutations.length, 0);

  const residueDb = makeFakeDb();
  residueDb.workspaces.set(randomUUID(), "CANARY-2B-VALIDATION leftover");
  const residue = run({ db: residueDb });
  await assert.rejects(residue.report, validateStops("P9_RESIDUE"));
  assert.equal(residueDb.mutations.length, 0);
});

test("P9 mid-test transport failure: run fails, cleanup still removes the fixtures", async () => {
  const db = makeFakeDb();
  db.failOn.set("test-a-reindex", 1);
  const { report } = run({ db });
  const r = await report;
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((c) => !c.ok && c.name.includes("completed without transport error")));
  assert.equal(r.cleanupOk, true, "cleanup still ran and verified");
  assert.equal(db.workspaces.size, 0);
  assert.equal(db.documents.size, 0);
});

test("P9 partial fixture creation: failure during W2 setup still cleans both run workspaces", async () => {
  const db = makeFakeDb();
  db.failOn.set("setup-w2-resource", 1);
  const { report } = run({ db });
  const r = await report;
  assert.equal(r.ok, false);
  assert.equal(r.cleanupOk, true);
  assert.equal(db.workspaces.size, 0, "W1 and the half-created W2 are both gone");
});

test("P9 cleanup failure is reported with run ids for separately-approved recovery", async () => {
  const db = makeFakeDb();
  db.failOn.set("cleanup-w1-workspace", 1);
  const { report } = run({ db });
  const r = await report;
  assert.equal(r.ok, false);
  assert.equal(r.cleanupOk, false);
  assert.match(String(r.cleanupDetail), /cleanup transport failure/);
  assert.match(r.runIds.w1.workspaceId, /^[0-9a-f-]{36}$/i);
});

// ------------------------------------------------------------ transport parameter shapes

const mkTransport = () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => "", json: async () => [] };
  };
  return { calls, t: probeLib.createCanaryWriteProbeTransport(okEnv(), fetchImpl) };
};

test("P9 transport: statements are frozen and parameters are shape-validated before any send", async () => {
  const { calls, t } = mkTransport();
  const ws = randomUUID();
  await assert.rejects(t.runValidationStatement("delete from public.workspaces", [ws], "x"), probeStops("PROBE_SQL_NOT_ALLOWLISTED"));
  await assert.rejects(t.runValidationStatement(probeLib.P9_SQL_CREATE_WORKSPACE, [ws], "x"), probeStops("P9_PARAMS_INVALID"));
  await assert.rejects(t.runValidationStatement(probeLib.P9_SQL_CREATE_WORKSPACE, [ws, "My clinic"], "x"), probeStops("P9_PARAMS_INVALID"));
  await assert.rejects(
    t.runValidationStatement(probeLib.P9_SQL_CLEANUP_WORKSPACE, [ws, `CANARY-2B-VALIDATION ${randomUUID()}`], "x"),
    probeStops("P9_PARAMS_INVALID"),
    "a cleanup name must embed the SAME uuid as the id — it can never target another workspace",
  );
  await assert.rejects(t.runValidationStatement(probeLib.P9_SQL_REINDEX_DOCUMENT, [ws, ws, "nothex", "[]"], "x"), probeStops("P9_PARAMS_INVALID"));
  await assert.rejects(t.runValidationStatement(probeLib.P9_SQL_APPLY_DOCUMENT_CHANGES, [ws, ws, ws, "{not json"], "x"), probeStops("P9_PARAMS_INVALID"));
  await assert.rejects(
    t.runValidationStatement(probeLib.P9_SQL_MATCH_CHUNKS, [ws, ws, `probe ${guard.FORBIDDEN_PRODUCTION_REF}`], "x"),
    guardStops("PRODUCTION_REF_BLOCKED"),
  );
  assert.equal(calls.length, 0, "nothing reached the endpoint");

  await t.runValidationStatement(probeLib.P9_SQL_CREATE_WORKSPACE, [ws, `CANARY-2B-VALIDATION ${ws}`], "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].read_only, false);
  assert.deepEqual(calls[0].parameters, [ws, `CANARY-2B-VALIDATION ${ws}`]);
});

// ------------------------------------------------------------ CLI confirmation

const cli = await import("../scripts/canary-validate.ts");

test("the P9 CLI requires its exact confirmation phrase", () => {
  assert.throws(() => cli.parseValidateCliArgs([]), guardStops("INVALID_ARGS"));
  assert.throws(() => cli.parseValidateCliArgs(["--confirm-p9=nope"]), guardStops("CONFIRMATION_REQUIRED"));
  assert.throws(() => cli.parseValidateCliArgs(["--confirm=" + cli.CANARY_P9_CONFIRMATION_PHRASE]), guardStops("INVALID_ARGS"));
  cli.parseValidateCliArgs([`--confirm-p9=${cli.CANARY_P9_CONFIRMATION_PHRASE}`]);
});
