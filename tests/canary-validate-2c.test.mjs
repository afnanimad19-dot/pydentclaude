// Canary 2C retrieval integration validation — PURE OFFLINE tests. The write
// transport is the P9 in-memory fake extended to store document CONTENT (the
// Leg B loader reads it); the fake PostgREST client emulates websearch
// semantics (OR groups of AND terms) over the same state; the REAL Phase 2C
// application functions run (searchKnowledgeCore, centralRetrievalForReply,
// ftsQueryFor) with the REAL CLI adapters (buildCanaryMatcher /
// buildCanaryLoader). No database, no network, synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { okEnv, FAKE_SENTINEL_TOKEN } from "./canary-fixtures.mjs";

const guard = await import("../scripts/canary-guard.ts");
const plan = await import("../scripts/canary-plan-lib.ts");
const preflight = await import("../scripts/canary-preflight-lib.ts");
const sentinel = await import("../scripts/canary-sentinel.ts");
const probeLib = await import("../scripts/canary-probe-lib.ts");
const p9lib = await import("../scripts/canary-validate-lib.ts");
const lib = await import("../scripts/canary-validate-2c-lib.ts");
const kbc = await import("../scripts/canary-kb-client.ts");
const cli = await import("../scripts/canary-validate-2c.ts");
const app = await import("@/lib/agent-tools-core");

const { runCanary2cRetrievalValidation, Canary2cError } = lib;
const root = path.resolve(import.meta.dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const c2cStops = (code) => (e) => e instanceof Canary2cError && e.code === code;
const guardStops = (code) => (e) => e instanceof guard.CanaryError && e.code === code;

const FAKE_DIGEST = createHash("sha256").update(FAKE_SENTINEL_TOKEN.toLowerCase(), "utf8").digest("hex");
const c2cEnv = (extra = {}) => okEnv({ CANARY_SENTINEL_TOKEN: FAKE_SENTINEL_TOKEN, ...extra });

const MARKER_DONE = {
  "baseline-0001-0064": { m0001: true, m0014: true, m0064: true },
  "apply-0065": { resources: true, documents: true, assignments: true, apply_fn: true },
  "apply-0067": { resources_crud: true, documents_crud: true, assignments_crud: true },
  "apply-0066": { slot_minutes: true },
  "apply-0068": { chunks: true, reindex_fn: true, match_fn: true },
};
const ACL_CLEAN = [{ objtype: "f", owner: "postgres", api_role_grantees: "anon" }];
const httpError = (text) => new probeLib.CanaryProbeError("PROBE_HTTP_ERROR", `fake: HTTP 400 ${text}`);

/** websearch emulation shared by the SQL fake and the PostgREST fake:
 *  OR-separated groups; within a group every term must appear. */
function websearchMatches(content, query) {
  const groups = String(query).toLowerCase().split(/\s+or\s+/i).map((g) => g.trim().split(/\s+/).filter(Boolean)).filter((g) => g.length);
  const lower = content.toLowerCase();
  return groups.some((terms) => terms.every((t) => lower.includes(t)));
}

/** In-memory canary KB (P9's fake + document content, for the Leg B loader). */
function makeFakeDb() {
  const db = {
    workspaces: new Map(),
    resources: new Map(), // id -> { wsId, version, name }
    agents: new Map(),
    assignments: new Set(), // "ws|agent|res"
    documents: new Map(), // id -> { wsId, resId, hash, status, content, filename }
    chunks: new Map(), // docId -> rows[]
    mutations: [],
    failOn: new Map(),
  };
  const resourceVersion = (resId) => db.resources.get(resId)?.version ?? 0;
  const authoritative = (ws, agentId) => {
    const rows = [];
    for (const key of db.assignments) {
      const [aWs, aAgent, aRes] = key.split("|");
      if (aWs !== ws || aAgent !== agentId) continue;
      for (const [docId, d] of db.documents) {
        if (d.wsId !== ws || d.resId !== aRes || d.status !== "ready") continue;
        for (const c of db.chunks.get(docId) ?? []) {
          if (c.content_hash !== d.hash) continue;
          rows.push({ docId, res: aRes, c });
        }
      }
    }
    return rows;
  };

  db.validate = async (sql, params, context) => {
    db.mutations.push({ sql, params: [...params], context });
    const remaining = db.failOn.get(context) ?? 0;
    if (remaining > 0) {
      db.failOn.set(context, remaining - 1);
      throw httpError(`injected failure at ${context}`);
    }
    if (sql === probeLib.P9_SQL_CREATE_WORKSPACE) { db.workspaces.set(params[0], params[1]); return [{ id: params[0] }]; }
    if (sql === probeLib.P9_SQL_CREATE_RESOURCE) { db.resources.set(params[0], { wsId: params[1], version: 0, name: params[2] }); return [{ id: params[0] }]; }
    if (sql === probeLib.P9_SQL_CREATE_AGENT) { db.agents.set(params[0], params[1]); return [{ id: params[0] }]; }
    if (sql === probeLib.P9_SQL_CREATE_ASSIGNMENT) {
      const [ws, agent, res] = params;
      const r = db.resources.get(res);
      if (!r || r.wsId !== ws) throw httpError("23503 violates foreign key constraint");
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
          db.documents.set(id, { wsId: ws, resId: res, hash: change.content_hash, status: change.status, content: change.content, filename: change.filename });
          results.push({ id });
        } else if (change.op === "replace") {
          const d = db.documents.get(change.id);
          if (!d || d.wsId !== ws) throw httpError("P0002 Knowledge document not found.");
          r.version += 1;
          d.hash = change.content_hash;
          d.content = change.content;
          results.push({ id: change.id });
        } else if (change.op === "delete") {
          const d = db.documents.get(change.id);
          if (!d || d.wsId !== ws) throw httpError("P0002 Knowledge document not found.");
          db.documents.delete(change.id);
          db.chunks.delete(change.id);
          results.push({ id: change.id });
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
      db.chunks.set(docId, parsed.map((c, i) => ({
        chunk_index: i, content: c.content, source_label: c.source_label, heading: c.heading ?? null,
        content_hash: d.hash, content_version: resourceVersion(d.resId), workspace_id: ws, resource_id: d.resId, document_id: docId,
      })));
      return [{ result: { stale_input: false, replaced: true, chunks: parsed.length } }];
    }
    if (sql === probeLib.P9_SQL_MATCH_CHUNKS) {
      const [ws, agent, query] = params;
      const universe = authoritative(ws, agent);
      const matches = universe
        .filter(({ c }) => websearchMatches(c.content, query))
        .slice(0, 8)
        .map(({ docId, res, c }, i) => ({
          resource_id: res, document_id: docId, chunk_id: randomUUID(), chunk_index: c.chunk_index,
          source_label: c.source_label, heading: c.heading, content: c.content, score: 1 - i * 0.05,
        }));
      return [{ result: { searched_chunks: universe.length, matches } }];
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
    if (sql === p9lib.SQL_P9_RESIDUE) {
      return [...db.workspaces.entries()]
        .filter(([, n]) => n.startsWith("CANARY-2B-VALIDATION ") || n.startsWith("A7-2B-VALIDATION "))
        .map(([id]) => ({ id }));
    }
    if (sql === p9lib.SQL_P9_BASELINE_COUNTS) {
      return [{
        workspaces: db.workspaces.size,
        knowledge_resources: db.resources.size,
        knowledge_documents: db.documents.size,
        knowledge_chunks: [...db.chunks.values()].reduce((s, rows) => s + rows.length, 0),
        agent_knowledge_resources: db.assignments.size,
        agents: db.agents.size,
      }];
    }
    if (sql === p9lib.SQL_P9_VERIFY_RUN_ABSENT) {
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
    throw new Error(`fake db: unexpected read-only SQL ${sql.slice(0, 60)}`);
  };

  /** Fake PostgREST client over the SAME state — fed to the REAL CLI adapters. */
  db.kbClient = {
    async rpcMatchChunks({ ws, agentId, query, topK }) {
      const universe = authoritative(ws, agentId);
      const matches = universe
        .filter(({ c }) => websearchMatches(c.content, query))
        .slice(0, topK)
        .map(({ docId, res, c }, i) => ({
          resource_id: res, document_id: docId, chunk_id: randomUUID(), chunk_index: c.chunk_index,
          source_label: c.source_label, heading: c.heading ?? "", content: c.content, score: 1 - i * 0.05,
        }));
      return { data: { searched_chunks: universe.length, matches }, error: null };
    },
    async selectAssignments(ws, agentId) {
      return [...db.assignments]
        .map((k) => k.split("|"))
        .filter(([aWs, aAgent]) => aWs === ws && aAgent === agentId)
        .map(([, , res], i) => ({ resource_id: res, position: i }));
    },
    async selectResources(ws, ids) {
      return [...db.resources.entries()].filter(([id, r]) => r.wsId === ws && ids.includes(id)).map(([id, r]) => ({ id, name: r.name }));
    },
    async selectReadyDocuments(ws, ids) {
      return [...db.documents.entries()]
        .filter(([, d]) => d.wsId === ws && ids.includes(d.resId) && d.status === "ready")
        .map(([id, d], i) => ({ id, resource_id: d.resId, filename: d.filename, source_url: null, content: d.content, position: i }));
    },
  };

  return db;
}

const run = ({ db = makeFakeDb(), env = c2cEnv(), readOnlyOverrides = {} } = {}) => ({
  db,
  report: runCanary2cRetrievalValidation({
    env,
    readOnly: db.readOnly(readOnlyOverrides),
    probe: { runValidationStatement: db.validate },
    matcher: cli.buildCanaryMatcher(db.kbClient),
    loader: cli.buildCanaryLoader(db.kbClient),
    app: { searchCore: app.searchKnowledgeCore, replyRetrieval: app.centralRetrievalForReply, ftsQuery: app.ftsQueryFor },
  }),
});

test("2C happy path: the full Step 70 matrix passes, cleanup removes everything, baseline restored", async () => {
  const { db, report } = run();
  const r = await report;
  assert.deepEqual(r.checks.filter((c) => !c.ok), [], "no failing checks");
  assert.equal(r.ok, true);
  assert.equal(r.cleanupOk, true);
  assert.equal(r.logLeaks, 0);
  assert.equal(db.workspaces.size, 0);
  assert.equal(db.documents.size, 0);
  assert.equal(db.agents.size, 0);
  assert.equal(db.assignments.size, 0);
  // Only the eight frozen P9 statements ever reached the transport.
  const allowed = new Set([
    probeLib.P9_SQL_CREATE_WORKSPACE, probeLib.P9_SQL_CREATE_RESOURCE, probeLib.P9_SQL_CREATE_AGENT,
    probeLib.P9_SQL_CREATE_ASSIGNMENT, probeLib.P9_SQL_APPLY_DOCUMENT_CHANGES, probeLib.P9_SQL_REINDEX_DOCUMENT,
    probeLib.P9_SQL_MATCH_CHUNKS, probeLib.P9_SQL_CLEANUP_WORKSPACE,
  ]);
  for (const m of db.mutations) assert.ok(allowed.has(m.sql), `unexpected SQL: ${m.sql.slice(0, 50)}`);
});

test("2C gates refuse before any mutation (sentinel, markers, residue)", async () => {
  const noToken = run({ env: okEnv() });
  await assert.rejects(noToken.report, guardStops("SENTINEL_TOKEN_MISSING"));
  assert.equal(noToken.db.mutations.length, 0);

  const notMigrated = run({ readOnlyOverrides: { [plan.STEP_MARKER_SQL["apply-0068"]]: [{ chunks: false, reindex_fn: false, match_fn: false }] } });
  await assert.rejects(notMigrated.report, c2cStops("C2C_GATE_FAILED"));
  assert.equal(notMigrated.db.mutations.length, 0);

  const residueDb = makeFakeDb();
  residueDb.workspaces.set(randomUUID(), "CANARY-2B-VALIDATION leftover");
  const residue = run({ db: residueDb });
  await assert.rejects(residue.report, c2cStops("C2C_RESIDUE"));
  assert.equal(residueDb.mutations.length, 0);
});

test("2C mid-test transport failure: run fails, cleanup still removes both fixture worlds", async () => {
  const db = makeFakeDb();
  db.failOn.set("test-2-match", 1);
  const r = await run({ db }).report;
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((c) => !c.ok && c.name.includes("completed without transport error")));
  assert.equal(r.cleanupOk, true, "cleanup still ran and verified");
  assert.equal(db.workspaces.size, 0);
  assert.equal(db.documents.size, 0);
});

test("2C partial fixture creation: failure during W2 setup still cleans both run workspaces", async () => {
  const db = makeFakeDb();
  db.failOn.set("setup-index-db", 1);
  const r = await run({ db }).report;
  assert.equal(r.ok, false);
  assert.equal(r.cleanupOk, true);
  assert.equal(db.workspaces.size, 0, "W1 and the half-created W2 are both gone");
});

test("2C cleanup failure is reported with run ids for separately-approved recovery", async () => {
  const db = makeFakeDb();
  db.failOn.set("cleanup-w1-workspace", 1);
  const r = await run({ db }).report;
  assert.equal(r.ok, false);
  assert.equal(r.cleanupOk, false);
  assert.match(String(r.cleanupDetail), /cleanup transport failure/);
  assert.match(r.runIds.w1, /^[0-9a-f-]{36}$/i);
});

// ------------------------------------------------------------ kb-client unit tests

const keyRows = [{ name: "anon", api_key: "fake-anon" }, { name: "service_role", api_key: "sb_secret_FAKE_2c_key" }];
const res = (body, { ok = true, status = 200, url } = {}) => ({ ok, status, url, json: async () => body });

test("fetchCanaryServiceRoleKey: proxy-side endpoint, reveal=true, strict parsing, status mapping", async () => {
  const calls = [];
  const key = await kbc.fetchCanaryServiceRoleKey(async (url, init) => { calls.push({ url, init }); return res(keyRows); });
  assert.equal(key, "sb_secret_FAKE_2c_key");
  assert.equal(calls[0].url, `https://api.supabase.com/v1/projects/${guard.CANARY_PROJECT_REF}/api-keys?reveal=true`);
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(!("Authorization" in (calls[0].init.headers ?? {})), "the Management call sends no credential (the proxy injects it)");
  await assert.rejects(kbc.fetchCanaryServiceRoleKey(async () => res([], { ok: false, status: 403 })), guardStops("AUTH_REJECTED"));
  await assert.rejects(kbc.fetchCanaryServiceRoleKey(async () => res([], { ok: false, status: 500 })), guardStops("TRANSPORT_HTTP_ERROR"));
  await assert.rejects(kbc.fetchCanaryServiceRoleKey(async () => res([{ name: "anon", api_key: "x" }])), guardStops("RESULT_MALFORMED"));
});

test("createCanaryKbClient: origin pinned, redirects refused, origin changes rejected, key never in errors", async () => {
  const calls = [];
  const client = kbc.createCanaryKbClient("sb_secret_FAKE_2c_key", async (url, init) => {
    calls.push({ url, init });
    return res({ searched_chunks: 0, matches: [] });
  });
  await client.rpcMatchChunks({ ws: randomUUID(), agentId: randomUUID(), query: "x", topK: 8 });
  assert.ok(calls[0].url.startsWith(`https://${guard.CANARY_PROJECT_REF}.supabase.co/rest/v1/`), calls[0].url);
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.apikey, "sb_secret_FAKE_2c_key");

  const moved = kbc.createCanaryKbClient("sb_secret_FAKE_2c_key", async () => res([], { url: "https://evil.example/rest/v1/x" }));
  await assert.rejects(moved.selectAssignments(randomUUID(), randomUUID()), guardStops("ENDPOINT_MISMATCH"));

  const failing = kbc.createCanaryKbClient("sb_secret_FAKE_2c_key", async () => res({}, { ok: false, status: 401 }));
  const r = await failing.rpcMatchChunks({ ws: randomUUID(), agentId: randomUUID(), query: "x", topK: 8 });
  assert.equal(r.error.message, "rpc HTTP 401", "status only — no body, no key");
  await assert.rejects(
    kbc.createCanaryKbClient("k", async () => res([])).selectResources(randomUUID(), [`x${guard.FORBIDDEN_PRODUCTION_REF}`]),
    guardStops("PRODUCTION_REF_BLOCKED"),
  );
});

test("the 2C CLI requires its exact confirmation phrase", () => {
  assert.throws(() => cli.parse2cCliArgs([]), guardStops("INVALID_ARGS"));
  assert.throws(() => cli.parse2cCliArgs(["--confirm-2c=nope"]), guardStops("CONFIRMATION_REQUIRED"));
  assert.throws(() => cli.parse2cCliArgs(["--confirm-p9=" + cli.CANARY_2C_CONFIRMATION_PHRASE]), guardStops("INVALID_ARGS"));
  cli.parse2cCliArgs([`--confirm-2c=${cli.CANARY_2C_CONFIRMATION_PHRASE}`]);
});

test("the 2C lib performs no network I/O and value-imports no app module that builds a database client", () => {
  const src = read("scripts/canary-validate-2c-lib.ts");
  assert.doesNotMatch(src, /\bfetch\s*\(|globalThis\.fetch|node:https?/);
  assert.doesNotMatch(src, /^import \{[^}]*\} from "@\/lib\/knowledge-runtime"/m, "knowledge-runtime only as import type");
  assert.doesNotMatch(src, /^import \{[^}]*\} from "@\/lib\/agent-tools-core"/m, "agent-tools-core only as import type");
  assert.match(src, /import type \{[^}]*ChunkMatcher/);
});

// ------------------------------------------------------------ Step 72C: env-supplied sb_secret_ key

const GOOD_KEY = "sb_secret_FAKE2cKey_0123456789";

test("72C guard: the exact env name with an sb_secret_ value is the ONE sanctioned local credential", () => {
  assert.deepEqual(guard.findLocalSupabaseCredentials({ CANARY_SUPABASE_SERVICE_KEY: GOOD_KEY }), []);
  const r = guard.checkCanaryEnvironment(c2cEnv({ CANARY_SUPABASE_SERVICE_KEY: GOOD_KEY }));
  assert.equal(r.ok, true);
});

test("72C guard: near-miss names and wrong-shaped values still refuse", () => {
  for (const env of [
    { MY_CANARY_SUPABASE_SERVICE_KEY: GOOD_KEY },
    { CANARY_SUPABASE_SERVICE_KEY2: GOOD_KEY },
    { SUPABASE_SERVICE_ROLE_KEY: GOOD_KEY },
    { CANARY_SUPABASE_SERVICE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake.fake" }, // a JWT is not sanctioned
    // Clearly synthetic (uppercase, non-hex) so GitHub push protection cannot
    // mistake it for a real sbp_ token; the guard regex still flags it.
    { CANARY_SUPABASE_SERVICE_KEY: "sbp_FAKEFIXTUREVALUE" },
    { CANARY_SUPABASE_SERVICE_KEY: "postgresql://postgres:supersecretpw@db.example/db" },
    { CANARY_SUPABASE_SERVICE_KEY: "sb_secret_x" }, // too short
  ]) {
    assert.ok(guard.findLocalSupabaseCredentials(env).length >= 1, JSON.stringify(Object.keys(env)));
  }
});

test("72C guard: production-ref rejection still precedes and overrides everything", () => {
  const r = guard.checkCanaryEnvironment(c2cEnv({ CANARY_SUPABASE_SERVICE_KEY: GOOD_KEY, SOME_URL: `https://${guard.FORBIDDEN_PRODUCTION_REF}.supabase.co` }));
  assert.deepEqual([r.ok, r.code], [false, "PRODUCTION_REF_BLOCKED"]);
  // Even a shape-valid key whose VALUE embeds the production ref refuses.
  const r2 = guard.checkCanaryEnvironment(c2cEnv({ CANARY_SUPABASE_SERVICE_KEY: `sb_secret_${guard.FORBIDDEN_PRODUCTION_REF}x` }));
  assert.deepEqual([r2.ok, r2.code], [false, "PRODUCTION_REF_BLOCKED"]);
});

test("72C guard: the scrubber redacts sb_secret_ values, bare or Bearer-prefixed", () => {
  const out = guard.scrubCanaryText(`failed with apikey ${GOOD_KEY} and Authorization Bearer ${GOOD_KEY}.`);
  assert.ok(!out.includes(GOOD_KEY));
  assert.match(out, /\[redacted\]/);
});

test("72C CLI: the env key is preferred and NO Management-API key fetch happens", async () => {
  let fetched = 0;
  const key = await cli.resolveCanaryServiceKey(c2cEnv({ CANARY_SUPABASE_SERVICE_KEY: GOOD_KEY }), async () => { fetched++; return "unused"; });
  assert.equal(key, GOOD_KEY);
  assert.equal(fetched, 0, "api-keys endpoint never consulted when the env key is present");
});

test("72C CLI: a malformed env key refuses outright — never a silent fallback", async () => {
  let fetched = 0;
  await assert.rejects(
    cli.resolveCanaryServiceKey(c2cEnv({ CANARY_SUPABASE_SERVICE_KEY: "not-a-secret" }), async () => { fetched++; return "unused"; }),
    guardStops("INVALID_ARGS"),
  );
  assert.equal(fetched, 0);
});

test("72C CLI: NEXT_PUBLIC exposure of the key value refuses", async () => {
  await assert.rejects(
    cli.resolveCanaryServiceKey(c2cEnv({ CANARY_SUPABASE_SERVICE_KEY: GOOD_KEY, NEXT_PUBLIC_DEBUG_BLOB: `x ${GOOD_KEY} y` }), async () => "unused"),
    guardStops("SENTINEL_TOKEN_EXPOSED"),
  );
});

test("72C CLI: absent env key keeps the Management-API fallback", async () => {
  assert.equal(await cli.resolveCanaryServiceKey(c2cEnv(), async () => "fetched-key"), "fetched-key");
});

test("72C end-to-end: the full offline run passes with the env key configured", async () => {
  const { db, report } = run({ env: c2cEnv({ CANARY_SUPABASE_SERVICE_KEY: GOOD_KEY }) });
  const r = await report;
  assert.deepEqual(r.checks.filter((c) => !c.ok), []);
  assert.equal(r.ok, true);
  assert.equal(db.workspaces.size, 0);
});

// ------------------------------------------------------------ Step 72C.8: proxy-injected auth mode

test("72C.8 proxy client: NO credential headers, all pins retained", async () => {
  const calls = [];
  const client = kbc.createProxyInjectedCanaryKbClient(async (url, init) => {
    calls.push({ url, init });
    return res({ searched_chunks: 0, matches: [] });
  });
  await client.rpcMatchChunks({ ws: randomUUID(), agentId: randomUUID(), query: "x", topK: 8 });
  await client.selectAssignments(randomUUID(), randomUUID());
  for (const c of calls) {
    const headers = c.init.headers ?? {};
    assert.ok(!("apikey" in headers), "no apikey header from application code");
    assert.ok(!("Authorization" in headers) && !("authorization" in headers), "no Authorization header from application code");
    assert.ok(c.url.startsWith(`https://${guard.CANARY_PROJECT_REF}.supabase.co/rest/v1/`), c.url);
    assert.equal(c.init.redirect, "error");
  }
  // Origin-change and forbidden-ref protections are the shared core:
  const moved = kbc.createProxyInjectedCanaryKbClient(async () => res([], { url: "https://evil.example/rest/v1/x" }));
  await assert.rejects(moved.selectAssignments(randomUUID(), randomUUID()), guardStops("ENDPOINT_MISMATCH"));
  await assert.rejects(
    kbc.createProxyInjectedCanaryKbClient(async () => res([])).selectResources(randomUUID(), [`x${guard.FORBIDDEN_PRODUCTION_REF}`]),
    guardStops("PRODUCTION_REF_BLOCKED"),
  );
});

test("72C.8 mode resolution: explicit proxy/env/managed, 72C-compatible default, garbage refused", () => {
  assert.equal(cli.resolveKbAuthMode(c2cEnv({ CANARY_KB_AUTH: "proxy" })), "proxy");
  assert.equal(cli.resolveKbAuthMode(c2cEnv({ CANARY_KB_AUTH: "env", CANARY_SUPABASE_SERVICE_KEY: GOOD_KEY })), "env");
  assert.equal(cli.resolveKbAuthMode(c2cEnv({ CANARY_KB_AUTH: "managed" })), "managed");
  assert.equal(cli.resolveKbAuthMode(c2cEnv({ CANARY_SUPABASE_SERVICE_KEY: GOOD_KEY })), "env", "unset keeps 72C preference");
  assert.equal(cli.resolveKbAuthMode(c2cEnv()), "managed", "unset without key keeps the managed fallback");
  assert.throws(() => cli.resolveKbAuthMode(c2cEnv({ CANARY_KB_AUTH: "yolo" })), guardStops("INVALID_ARGS"));
});

test("72C.8 proxy mode: no credential retrieval and the env key is ignored even when present", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers ?? {} });
    return res({ searched_chunks: 0, matches: [] });
  };
  const { mode, kb } = await cli.buildCanaryKb(c2cEnv({ CANARY_KB_AUTH: "proxy", CANARY_SUPABASE_SERVICE_KEY: GOOD_KEY }), fetchImpl);
  assert.equal(mode, "proxy");
  await kb.rpcMatchChunks({ ws: randomUUID(), agentId: randomUUID(), query: "x", topK: 4 });
  assert.ok(seen.every((c) => !c.url.includes("api-keys")), "the Management api-keys endpoint is never consulted");
  assert.ok(seen.every((c) => !JSON.stringify(c.headers).includes(GOOD_KEY)), "the env key never reaches a request");
});

test("72C.8 env mode without a key refuses outright (no managed fallback)", async () => {
  await assert.rejects(cli.buildCanaryKb(c2cEnv({ CANARY_KB_AUTH: "env" }), async () => res([])), guardStops("INVALID_ARGS"));
});

test("72C.8 managed mode still fetches via the Management API and builds a key-holding client", async () => {
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(url);
    if (url.includes("api-keys")) return res(keyRows);
    assert.equal((init.headers ?? {}).apikey, "sb_secret_FAKE_2c_key", "managed mode still sends the fetched key");
    return res({ searched_chunks: 0, matches: [] });
  };
  const { mode, kb } = await cli.buildCanaryKb(c2cEnv({ CANARY_KB_AUTH: "managed" }), fetchImpl);
  assert.equal(mode, "managed");
  await kb.rpcMatchChunks({ ws: randomUUID(), agentId: randomUUID(), query: "x", topK: 4 });
  assert.ok(urls[0].includes("api-keys"));
});

test("72C.8 end-to-end: the REAL ladder answers through the proxy client with zero credential headers", async () => {
  const WS = randomUUID();
  const AGENT = randomUUID();
  const chunk = { resource_id: randomUUID(), document_id: randomUUID(), chunk_id: randomUUID(), chunk_index: 0, source_label: "Proxy FAQ / p.txt", heading: "Prices", content: "canaryproxyretrieval veneers cost 900.", score: 0.9 };
  const headersSeen = [];
  const kb = kbc.createProxyInjectedCanaryKbClient(async (url, init) => {
    headersSeen.push(init.headers ?? {});
    assert.ok(url.includes("/rest/v1/rpc/knowledge_match_chunks"));
    return res({ searched_chunks: 3, matches: [chunk] });
  });
  const matcher = cli.buildCanaryMatcher(kb);
  const r = await app.searchKnowledgeCore(
    { id: AGENT, workspace_id: WS, name: "Proxy agent", knowledge_base: "LEGACY" },
    { query: "canaryproxyretrieval" },
    "canary-2c",
    async () => ({ assigned: true, knowledge: null }),
    matcher,
  );
  assert.equal(r.sourceMode, "central-chunks");
  assert.match(r.text, /canaryproxyretrieval/);
  assert.ok(headersSeen.every((h) => !("apikey" in h) && !("Authorization" in h)));
});
