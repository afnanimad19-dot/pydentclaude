// Phase 2B A7 functional validator — PURE OFFLINE tests. Every transport is an
// injected fake; no HTTP, no A7, no Supabase, no production. The fake mirrors
// the 0065 apply and 0068 reindex semantics at the SQL-constant boundary so the
// validator's assertions and cleanup can be proven without any database.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { A7_PROJECT_REF, A7_SUPABASE_URL, FORBIDDEN_PRODUCTION_REF, A7GuardError } = await import("@/lib/a7-guard");
const { A7SentinelGuardError } = await import("@/lib/a7-sentinel-guard");
const { chunkDocumentContent, chunkSourceLabel } = await import("@/lib/knowledge-chunker");
const {
  parseEnvA7,
  A7RunnerError,
  A7_2B_VALIDATION_CONFIRMATION_PHRASE,
  A7_AUTHORIZE_CONFIRMATION_PHRASE,
  A7_LIVE_CONFIRMATION_PHRASE,
} = await import("../scripts/a7-mutate-lib.ts");
const { createFunctionalValidationTransport } = await import("../scripts/a7-live-transport.ts");
const vlib = await import("../scripts/a7-validate-2b-lib.ts");
const { runA72bFunctionalValidation, V1_CONTENT, V2_CONTENT, V1_PROBE_TOKEN, VALIDATION_MARKER_PREFIX, VALIDATION_RESOURCE_NAME, VALIDATION_DOCUMENT_FILENAME, validationContentHash } = vlib;
const { parseValidate2bCliArgs } = await import("../scripts/a7-validate-2b.ts");

const root = path.resolve(import.meta.dirname, "..");
const src = (p) => fs.readFileSync(path.join(root, p), "utf8");
const FAKE_SENTINEL = "11111111-2222-4333-8444-555555555555";
const FAKE_MGMT = "sbp_FAKE_fixture_management_token_000";
const CONFIRM = A7_2B_VALIDATION_CONFIRMATION_PHRASE;
const RUN_IDS = {
  workspaceId: "eeeeeeee-0000-4000-8000-000000000001",
  resourceId: "eeeeeeee-0000-4000-8000-000000000002",
  userId: "eeeeeeee-0000-4000-8000-000000000003",
};

const fakeEnv = () =>
  parseEnvA7(
    [
      "A7_MODE=1",
      `A7_EXPECTED_REF=${A7_PROJECT_REF}`,
      `NEXT_PUBLIC_SUPABASE_URL=${A7_SUPABASE_URL}`,
      `A7_SENTINEL_TOKEN=${FAKE_SENTINEL}`,
      `A7_SUPABASE_MGMT_TOKEN=${FAKE_MGMT}`,
    ].join("\n"),
  );

// ------------------------------------------------------------ in-memory A7 (0065 apply + 0068 reindex semantics)

function makeFakeA7(faults = {}) {
  const db = { workspaces: [], resources: [], documents: [], chunks: [], assignments: [], agents: [] };
  const calls = []; // { kind: 'sentinel'|'read'|'mutate', context, sql, parameters, auth }
  let docSeq = 0;
  let baselineReads = 0;
  const docUuid = () => `dddddddd-0000-4000-8000-${String(++docSeq).padStart(12, "0")}`;
  const counts = () => ({
    workspaces: db.workspaces.length,
    knowledge_resources: db.resources.length,
    knowledge_documents: db.documents.length,
    knowledge_chunks: db.chunks.length,
    agent_knowledge_resources: db.assignments.length,
    agents: db.agents.length,
  });
  const injected = (context) => {
    if (faults.throwOn === context) throw new Error("injected transport failure");
  };

  const executeSentinelQuery = async () => {
    calls.push({ kind: "sentinel", context: "sentinel-verification" });
    if (faults.sentinelBad) return [{ row_count: 0 }];
    return [{ row_count: 1, id_ok: true, ref_ok: true, token_ok: true }];
  };

  const executeReadOnlyQuery = async (sql, parameters, context) => {
    calls.push({ kind: "read", context, sql, parameters: [...parameters] });
    injected(context);
    switch (sql) {
      case vlib.SQL_RESIDUE_PREFLIGHT: {
        const prefix = String(parameters[0]).replace(/%$/, "");
        return db.workspaces.filter((w) => w.name.startsWith(prefix)).map((w) => ({ id: w.id }));
      }
      case vlib.SQL_BASELINE_COUNTS: {
        baselineReads++;
        const c = counts();
        if (faults.driftBaseline && baselineReads > 1) c.agents += 1;
        return [c];
      }
      case vlib.SQL_READ_CHUNKS:
        return db.chunks
          .filter((c) => c.workspace_id === parameters[0] && c.document_id === parameters[1])
          .sort((a, b) => a.chunk_index - b.chunk_index)
          .map((c) => ({ ...c, chars: c.content.length, content_len: c.content.length }));
      case vlib.SQL_READ_DOCUMENT_STATE: {
        const d = db.documents.find((x) => x.workspace_id === parameters[0] && x.id === parameters[1]);
        if (!d) return [];
        const r = db.resources.find((x) => x.id === d.resource_id && x.workspace_id === d.workspace_id);
        return [{ content_hash: d.content_hash, status: d.status, content_version: r?.content_version ?? 0 }];
      }
      case vlib.SQL_FTS_PROBE: {
        const needle = String(parameters[2]).toLowerCase();
        return [{
          hits: db.chunks.filter(
            (c) => c.workspace_id === parameters[0] && c.document_id === parameters[1] &&
              `${c.heading ?? ""} ${c.content}`.toLowerCase().includes(needle),
          ).length,
        }];
      }
      case vlib.SQL_VERIFY_DOCUMENT_GONE:
        return [{
          documents: db.documents.filter((d) => d.workspace_id === parameters[0] && d.id === parameters[1]).length,
          chunks: db.chunks.filter((c) => c.workspace_id === parameters[0] && c.document_id === parameters[1]).length,
        }];
      case vlib.SQL_VERIFY_RUN_ABSENT:
        return [{
          workspaces: db.workspaces.filter((w) => w.id === parameters[0]).length,
          knowledge_resources: db.resources.filter((r) => r.workspace_id === parameters[0]).length,
          knowledge_documents: db.documents.filter((d) => d.workspace_id === parameters[0]).length,
          knowledge_chunks: db.chunks.filter((c) => c.workspace_id === parameters[0]).length,
        }];
      default:
        throw new Error(`unknown read sql: ${sql.slice(0, 60)}`);
    }
  };

  const executeParameterizedMutation = async (sql, parameters, context, auth) => {
    calls.push({ kind: "mutate", context, sql, parameters: [...parameters], auth });
    if (auth?.eligible !== true) throw new Error("mutation reached the fake without A7MutationAuthorization");
    injected(context);
    switch (sql) {
      case vlib.SQL_CREATE_WORKSPACE:
        db.workspaces.push({ id: parameters[0], name: parameters[1] });
        return [{ id: parameters[0] }];
      case vlib.SQL_CREATE_RESOURCE:
        db.resources.push({ id: parameters[0], workspace_id: parameters[1], name: parameters[2], type: "file", content_version: 0 });
        return [{ id: parameters[0] }];
      case vlib.SQL_APPLY_DOCUMENT_CHANGES: {
        const [ws, resourceId, , changesJson] = parameters;
        const res = db.resources.find((r) => r.id === resourceId && r.workspace_id === ws);
        if (!res) throw new Error("P0002 resource");
        let changed = false;
        const results = [];
        for (const c of JSON.parse(changesJson)) {
          if (c.op === "insert") {
            const d = { id: docUuid(), workspace_id: ws, resource_id: resourceId, kind: c.kind, source_url: c.source_url, filename: c.filename, mime: c.mime, content: c.content ?? "", content_hash: c.content_hash, status: c.status ?? "ready", position: c.position ?? 0 };
            db.documents.push(d);
            changed = true;
            results.push({ op: "insert", id: d.id, applied: true });
            continue;
          }
          const d = db.documents.find((x) => x.id === c.id && x.resource_id === resourceId && x.workspace_id === ws);
          if (!d) throw new Error("P0002 document");
          if (c.op === "replace") {
            if (d.content !== (c.content ?? "")) changed = true;
            Object.assign(d, { mime: c.mime, content: c.content ?? "", content_hash: c.content_hash, status: c.status ?? "ready" });
          } else if (c.op === "delete") {
            db.documents.splice(db.documents.indexOf(d), 1);
            db.chunks = db.chunks.filter((k) => k.document_id !== d.id); // 0068 FK cascade
            changed = true;
          } else {
            throw new Error("22023 unknown op");
          }
          results.push({ op: c.op, id: d.id, applied: true });
        }
        res.content_version += changed ? 1 : 0;
        return [{ result: { resource: { ...res }, changed, results } }];
      }
      case vlib.SQL_REINDEX_DOCUMENT: {
        const [ws, documentId, hash, chunksJson] = parameters;
        const d = db.documents.find((x) => x.workspace_id === ws && x.id === documentId);
        if (!d) throw new Error("P0002 document");
        if (d.content_hash !== hash) {
          if (faults.writeOnStale) db.chunks.push({ workspace_id: ws, resource_id: d.resource_id, document_id: documentId, chunk_index: 999, content: "stale-write-bug", source_label: "x", heading: null, content_hash: hash, content_version: 0 });
          return [{ result: { stale_input: true, replaced: false, chunks: 0 } }];
        }
        const chunks = JSON.parse(chunksJson);
        chunks.forEach((c, i) => {
          if (typeof c?.content !== "string" || typeof c?.source_label !== "string" || c.chunk_index !== i) throw new Error("22023 invalid chunk set");
        });
        const res = db.resources.find((x) => x.id === d.resource_id && x.workspace_id === ws);
        db.chunks = db.chunks.filter((c) => c.document_id !== documentId);
        for (const c of chunks) {
          db.chunks.push({ workspace_id: ws, resource_id: d.resource_id, document_id: documentId, chunk_index: c.chunk_index, content: c.content, source_label: c.source_label, heading: c.heading, content_hash: d.content_hash, content_version: res?.content_version ?? 0 });
        }
        if (faults.dropChunkOnReindex) db.chunks.pop();
        return [{ result: { stale_input: false, replaced: true, chunks: chunks.length } }];
      }
      case vlib.SQL_CLEANUP_WORKSPACE: {
        if (faults.failCleanup) throw new Error("injected cleanup failure");
        const [id, name] = parameters;
        const i = db.workspaces.findIndex((w) => w.id === id && w.name === name);
        if (i < 0) return [];
        db.workspaces.splice(i, 1);
        if (!faults.leaveResidue) {
          db.resources = db.resources.filter((r) => r.workspace_id !== id);
          db.documents = db.documents.filter((d) => d.workspace_id !== id);
          db.chunks = db.chunks.filter((c) => c.workspace_id !== id);
        }
        return [{ id }];
      }
      default:
        throw new Error(`unknown mutation sql: ${sql.slice(0, 60)}`);
    }
  };

  return { db, calls, executeSentinelQuery, executeReadOnlyQuery, executeParameterizedMutation };
}

const depsFor = (fake, overrides = {}) => ({
  confirmation: CONFIRM,
  env: fakeEnv(),
  executeSentinelQuery: fake.executeSentinelQuery,
  executeReadOnlyQuery: fake.executeReadOnlyQuery,
  executeParameterizedMutation: fake.executeParameterizedMutation,
  runIds: RUN_IDS,
  ...overrides,
});

const mutations = (fake) => fake.calls.filter((c) => c.kind === "mutate");

// ------------------------------------------------------------ confirmation gates

test("exact Phase 2B confirmation accepted; wrong/missing/read-only/migration/foreign-ref phrases refused with ZERO transport calls", async () => {
  for (const bad of [
    undefined,
    "",
    "yes",
    A7_AUTHORIZE_CONFIRMATION_PHRASE, // Phase 2A read-only probe phrase
    A7_LIVE_CONFIRMATION_PHRASE, // migration-apply phrase
    CONFIRM.replace(A7_PROJECT_REF, FORBIDDEN_PRODUCTION_REF), // phrase for another project ref
    CONFIRM.toLowerCase(),
    ` ${CONFIRM}`,
  ]) {
    const fake = makeFakeA7();
    await assert.rejects(
      runA72bFunctionalValidation(depsFor(fake, { confirmation: bad })),
      (e) => e instanceof A7RunnerError && e.code === "VALIDATION_2B_CONFIRMATION_REQUIRED",
      String(bad).slice(0, 40),
    );
    assert.equal(fake.calls.length, 0, "refused before any transport use");
  }
});

test("CLI args: only --confirm=<exact 2B phrase>; everything else refused (incl. the other two known phrases)", () => {
  assert.deepEqual(parseValidate2bCliArgs([`--confirm=${CONFIRM}`]), { confirmation: CONFIRM });
  for (const [argv, code] of [
    [[], "INVALID_ARGS"],
    [["apply-0068"], "INVALID_ARGS"],
    [[`--confirm=${CONFIRM}`, "--force"], "INVALID_ARGS"],
    [[`--confirm=${A7_AUTHORIZE_CONFIRMATION_PHRASE}`], "VALIDATION_2B_CONFIRMATION_REQUIRED"],
    [[`--confirm=${A7_LIVE_CONFIRMATION_PHRASE}`], "VALIDATION_2B_CONFIRMATION_REQUIRED"],
    [["--confirm=nope"], "VALIDATION_2B_CONFIRMATION_REQUIRED"],
  ]) {
    assert.throws(() => parseValidate2bCliArgs(argv), (e) => e instanceof A7RunnerError && e.code === code, JSON.stringify(argv));
  }
});

// ------------------------------------------------------------ guard order

test("production ref in env is refused BEFORE the sentinel and before any mutation", async () => {
  const fake = makeFakeA7();
  const env = { ...fakeEnv(), NEXT_PUBLIC_SUPABASE_URL: `https://${FORBIDDEN_PRODUCTION_REF}.supabase.co` };
  await assert.rejects(runA72bFunctionalValidation(depsFor(fake, { env })), (e) => e instanceof A7GuardError);
  assert.equal(fake.calls.length, 0, "no sentinel query, no reads, no mutations");
});

test("sentinel failure blocks everything: no reads, no mutations", async () => {
  const fake = makeFakeA7({ sentinelBad: true });
  await assert.rejects(runA72bFunctionalValidation(depsFor(fake)), (e) => e instanceof A7SentinelGuardError);
  assert.deepEqual(fake.calls.map((c) => c.kind), ["sentinel"]);
});

test("residue preflight: marker workspaces REFUSE the run, report their ids, and are NEVER deleted", async () => {
  const fake = makeFakeA7();
  const leftover = "ffffffff-0000-4000-8000-000000000009";
  fake.db.workspaces.push({ id: leftover, name: `${VALIDATION_MARKER_PREFIX} ${leftover}` });
  await assert.rejects(
    runA72bFunctionalValidation(depsFor(fake)),
    (e) => e instanceof A7RunnerError && e.code === "VALIDATION_RESIDUE" && e.message.includes(leftover),
  );
  assert.equal(mutations(fake).length, 0, "residue is reported, never cleaned");
  assert.equal(fake.db.workspaces.length, 1, "the leftover row is untouched");
});

test("ordering: sentinel → residue preflight → baseline counts all precede the FIRST mutation", async () => {
  const fake = makeFakeA7();
  await runA72bFunctionalValidation(depsFor(fake));
  const kinds = fake.calls.map((c) => `${c.kind}:${c.context}`);
  const firstMutation = kinds.findIndex((k) => k.startsWith("mutate:"));
  assert.ok(firstMutation > 0);
  const before = kinds.slice(0, firstMutation);
  assert.ok(before.includes("sentinel:sentinel-verification"), "sentinel first");
  assert.ok(before.includes("read:residue-preflight"), "preflight before mutation");
  assert.ok(before.includes("read:baseline-before"), "baseline before mutation");
  assert.ok(before.indexOf("sentinel:sentinel-verification") < before.indexOf("read:residue-preflight"));
  assert.ok(before.indexOf("read:residue-preflight") < before.indexOf("read:baseline-before"));
});

// ------------------------------------------------------------ happy path

test("happy path: every check passes, cleanup succeeds, baseline restored, fake A7 is byte-identical to its start", async () => {
  const fake = makeFakeA7();
  // Pre-existing unrelated rows: must be untouched throughout.
  fake.db.workspaces.push({ id: "99999999-0000-4000-8000-000000000099", name: "Real clinic" });
  fake.db.agents.push({ id: "agent-1" });
  const before = JSON.stringify(fake.db);
  const report = await runA72bFunctionalValidation(depsFor(fake));
  const failed = report.checks.filter((c) => !c.ok);
  assert.deepEqual(failed, [], failed.map((c) => c.name).join("; "));
  assert.equal(report.ok, true);
  assert.equal(report.cleanupOk, true);
  assert.equal(report.ref, A7_PROJECT_REF);
  assert.deepEqual(report.runIds, { workspaceId: RUN_IDS.workspaceId, resourceId: RUN_IDS.resourceId, documentId: report.runIds.documentId });
  assert.equal(JSON.stringify(fake.db), before, "A7 state fully restored — unrelated rows untouched");
  // Both stale and normal reindex outcomes were exercised.
  const reindexCalls = mutations(fake).filter((c) => c.sql === vlib.SQL_REINDEX_DOCUMENT);
  assert.equal(reindexCalls.length, 4, "A + B + stale C + V2 C");
});

test("the reindex payload is EXACTLY the committed chunker's output (imported, not reimplemented)", async () => {
  const fake = makeFakeA7();
  await runA72bFunctionalValidation(depsFor(fake));
  const reindexCalls = mutations(fake).filter((c) => c.sql === vlib.SQL_REINDEX_DOCUMENT);
  const expectedV1 = chunkDocumentContent({
    content: V1_CONTENT,
    sourceLabel: chunkSourceLabel(VALIDATION_RESOURCE_NAME, { filename: VALIDATION_DOCUMENT_FILENAME, sourceUrl: null }),
  });
  assert.ok(expectedV1.length >= 3, "validation content yields multiple chunks");
  assert.deepEqual(JSON.parse(reindexCalls[0].parameters[3]), expectedV1, "Test A payload");
  assert.deepEqual(JSON.parse(reindexCalls[1].parameters[3]), expectedV1, "Test B payload (idempotent)");
  assert.equal(reindexCalls[0].parameters[2], validationContentHash(V1_CONTENT), "exact V1 hash");
  assert.equal(reindexCalls[3].parameters[2], validationContentHash(V2_CONTENT), "exact V2 hash");
  // The validator's lib source never reimplements chunking.
  const lib = src("scripts/a7-validate-2b-lib.ts");
  assert.match(lib, /from "@\/lib\/knowledge-chunker"/);
});

test("parameterization: runtime values travel ONLY in parameters — never inside the SQL text", async () => {
  const fake = makeFakeA7();
  await runA72bFunctionalValidation(depsFor(fake));
  for (const c of fake.calls.filter((x) => x.sql)) {
    assert.ok(!c.sql.includes(RUN_IDS.workspaceId), "no workspace uuid in SQL");
    assert.ok(!c.sql.includes("Synthetic v1"), "no validation content in SQL");
    assert.ok(!c.sql.includes(VALIDATION_MARKER_PREFIX), "marker travels as a parameter");
    assert.match(c.sql, /\$\d|count\(\*\)/, "fixed parameterized constants only");
  }
  // Every statement with runtime scope binds at least $1.
  for (const c of mutations(fake)) assert.ok(c.parameters.length >= 1);
});

test("every mutation carries A7MutationAuthorization; the real transport refuses without it", async () => {
  const fake = makeFakeA7();
  await runA72bFunctionalValidation(depsFor(fake));
  for (const c of mutations(fake)) assert.equal(c.auth?.eligible, true, c.context);
  // Transport-level gate, with a fake fetch that must never be reached.
  let fetched = 0;
  const transport = createFunctionalValidationTransport(fakeEnv(), async () => { fetched++; return { ok: true, status: 200, text: async () => "", json: async () => [] }; });
  await assert.rejects(
    transport.executeParameterizedMutation("select 1", [], "unauthorized", undefined),
    (e) => e instanceof A7RunnerError && e.code === "LIVE_CONFIRMATION_REQUIRED",
  );
  assert.equal(fetched, 0, "no HTTP without authorization");
  // With authorization the body is parameterized and read_only:false; reads hard-code read_only:true.
  const bodies = [];
  const t2 = createFunctionalValidationTransport(fakeEnv(), async (url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => "", json: async () => [] }; });
  await t2.executeParameterizedMutation("select $1", ["v"], "ok", { eligible: true, ref: A7_PROJECT_REF, sentinel: { id: 1, projectRef: A7_PROJECT_REF } });
  await t2.executeReadOnlyQuery("select 1", [], "r");
  assert.deepEqual(bodies[0], { query: "select $1", parameters: ["v"], read_only: false });
  assert.deepEqual(bodies[1], { query: "select 1", parameters: [], read_only: true });
});

// ------------------------------------------------------------ the assertions actually detect defects

test("Test A detects a lost chunk; Test C detects a write-on-stale bug (the checks are real)", async () => {
  const dropped = makeFakeA7({ dropChunkOnReindex: true });
  const r1 = await runA72bFunctionalValidation(depsFor(dropped));
  assert.equal(r1.ok, false);
  assert.ok(r1.checks.some((c) => !c.ok && c.name.startsWith("A: exactly n persisted rows")), "missing row detected");
  assert.equal(r1.cleanupOk, true, "cleanup still restores everything");

  const staleBug = makeFakeA7({ writeOnStale: true });
  const r2 = await runA72bFunctionalValidation(depsFor(staleBug));
  assert.equal(r2.ok, false);
  assert.ok(r2.checks.some((c) => !c.ok && c.name === "C: persisted chunk state unchanged by the stale attempt"), "stale write detected");
});

test("Test C stale semantics: the stale call returns stale_input and the V1-chunks-still-present window is NOT a failure", async () => {
  const fake = makeFakeA7();
  const report = await runA72bFunctionalValidation(depsFor(fake));
  for (const name of ["C: stale_input=true", "C: replaced=false", "C: chunks=0 from the stale operation", "C: persisted chunk state unchanged by the stale attempt", "C: final set corresponds only to V2 content", "C: final set carries the V2 content_hash"]) {
    assert.equal(report.checks.find((c) => c.name === name)?.ok, true, name);
  }
});

test("Test D: delete goes through knowledge_apply_document_changes and the cascade check passes; chunks are never deleted directly", async () => {
  const fake = makeFakeA7();
  const report = await runA72bFunctionalValidation(depsFor(fake));
  assert.equal(report.checks.find((c) => c.name === "D: validation document absent after delete")?.ok, true);
  assert.equal(report.checks.find((c) => c.name === "D: validation chunks removed by the foreign-key cascade")?.ok, true);
  const deleteOps = mutations(fake).filter((c) => c.sql === vlib.SQL_APPLY_DOCUMENT_CHANGES && c.parameters[3].includes('"delete"'));
  assert.equal(deleteOps.length, 1);
});

// ------------------------------------------------------------ cleanup

test("cleanup runs from finally after an injected mid-test failure, with exact-id-AND-exact-name predicate", async () => {
  const fake = makeFakeA7({ throwOn: "test-b-reindex" });
  const report = await runA72bFunctionalValidation(depsFor(fake));
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((c) => !c.ok && c.name === "validation sequence completed without transport error"));
  const cleanup = mutations(fake).filter((c) => c.sql === vlib.SQL_CLEANUP_WORKSPACE);
  assert.equal(cleanup.length, 1, "cleanup executed exactly once, from finally");
  assert.deepEqual(cleanup[0].parameters, [RUN_IDS.workspaceId, `${VALIDATION_MARKER_PREFIX} ${RUN_IDS.workspaceId}`]);
  assert.equal(report.cleanupOk, true);
  assert.equal(fake.db.workspaces.length, 0, "validation rows gone");
});

test("cleanup SQL is exact-match only: id = $1 AND name = $2, no LIKE, no prefix deletion anywhere", () => {
  assert.match(vlib.SQL_CLEANUP_WORKSPACE, /where id = \$1::uuid and name = \$2/);
  assert.doesNotMatch(vlib.SQL_CLEANUP_WORKSPACE, /like/i);
  // The ONLY statement using LIKE is the read-only residue DETECTION.
  const lib = src("scripts/a7-validate-2b-lib.ts");
  const likeUses = [...lib.matchAll(/like \$\d/gi)];
  assert.equal(likeUses.length, 1, "one LIKE in the module: the preflight SELECT");
  assert.match(vlib.SQL_RESIDUE_PREFLIGHT, /^select /);
  // No delete statement other than the exact-match workspace cleanup.
  const deletes = [...lib.matchAll(/delete from [a-z_.]+/gi)].map((m) => m[0].toLowerCase());
  assert.deepEqual(deletes, ["delete from public.workspaces"]);
});

test("cleanup failure: report says cleanup failed with run ids only; CLI prints A7 VALIDATION CLEANUP FAILED", async () => {
  const fake = makeFakeA7({ failCleanup: true });
  const report = await runA72bFunctionalValidation(depsFor(fake));
  assert.equal(report.cleanupOk, false);
  assert.equal(report.ok, false);
  assert.ok(report.cleanupDetail && report.cleanupDetail.startsWith("cleanup transport failure:"));
  assert.equal(report.runIds.workspaceId, RUN_IDS.workspaceId, "run ids available for recovery");
  const cli = src("scripts/a7-validate-2b.ts");
  assert.match(cli, /A7 VALIDATION CLEANUP FAILED/);
  assert.match(cli, /No broader cleanup was attempted/);
});

test("restoration verification detects residue and baseline drift", async () => {
  const residue = makeFakeA7({ leaveResidue: true });
  const r1 = await runA72bFunctionalValidation(depsFor(residue));
  assert.equal(r1.cleanupOk, false);
  assert.ok(r1.cleanupDetail.includes("run rows remain"));
  assert.equal(r1.checks.find((c) => c.name === "cleanup: current-run rows absent")?.ok, false);

  const drift = makeFakeA7({ driftBaseline: true });
  const r2 = await runA72bFunctionalValidation(depsFor(drift));
  assert.equal(r2.cleanupOk, false);
  assert.equal(r2.checks.find((c) => c.name === "cleanup: baseline counts restored (nothing unrelated disturbed)")?.ok, false);
});

// ------------------------------------------------------------ output + source discipline

test("no sensitive output: check names/details and error messages never carry content, tokens, or digests", async () => {
  const collected = [];
  for (const faults of [{}, { throwOn: "test-a-reindex" }, { failCleanup: true }]) {
    const fake = makeFakeA7(faults);
    const report = await runA72bFunctionalValidation(depsFor(fake));
    for (const c of report.checks) collected.push(`${c.name} ${c.detail ?? ""}`);
    if (report.cleanupDetail) collected.push(report.cleanupDetail);
  }
  const all = collected.join("\n");
  assert.ok(!all.includes("Synthetic v1"), "no validation document content");
  assert.ok(!all.includes(V1_CONTENT.slice(0, 40)));
  assert.ok(!all.includes(FAKE_SENTINEL), "no sentinel token");
  assert.ok(!all.includes(FAKE_MGMT), "no management token");
  assert.doesNotMatch(all, /[0-9a-f]{64}/, "no SHA-256 digests");
});

test("validator library is network-free and in scope: no fetch/HTTP, no a7_guard SQL, no knowledge_match_chunks, no direct chunk writes, no backfill", () => {
  const lib = src("scripts/a7-validate-2b-lib.ts").replace(/^\s*\/\/[^\n]*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(lib, /fetch\(|https?:\/\/|XMLHttpRequest|node:http/);
  assert.doesNotMatch(lib, /a7_guard/, "the sentinel schema is never referenced by validation SQL");
  assert.doesNotMatch(lib, /knowledge_match_chunks/);
  assert.doesNotMatch(lib, /(insert into|update) public\.knowledge_chunks/i, "chunks written only via the 0068 RPC");
  assert.doesNotMatch(lib, /delete from public\.knowledge_(chunks|documents|resources)/i, "cascades + apply RPC only");
  // Mutation inserts exist ONLY for the two validation-owned parent rows.
  const inserts = [...src("scripts/a7-validate-2b-lib.ts").matchAll(/insert into ([a-z_.]+)/gi)].map((m) => m[1].toLowerCase());
  assert.deepEqual(inserts.sort(), ["public.knowledge_resources", "public.workspaces"]);
  // No historical/backfill mechanism: the only document-selecting SQL is bound to $-parameters.
  for (const sql of [vlib.SQL_READ_CHUNKS, vlib.SQL_READ_DOCUMENT_STATE, vlib.SQL_FTS_PROBE, vlib.SQL_VERIFY_DOCUMENT_GONE, vlib.SQL_VERIFY_RUN_ABSENT]) {
    assert.match(sql, /\$1/, "scoped to validation ids");
  }
});

test("confirmation phrase: distinct from both existing phrases, names the A7 ref, follows the runner convention", () => {
  assert.equal(CONFIRM, `I-UNDERSTAND-THIS-CREATES-AND-DELETES-TEMPORARY-DATA-IN-THE-A7-VALIDATION-DATABASE-${A7_PROJECT_REF}`);
  assert.notEqual(CONFIRM, A7_AUTHORIZE_CONFIRMATION_PHRASE);
  assert.notEqual(CONFIRM, A7_LIVE_CONFIRMATION_PHRASE);
  assert.ok(!CONFIRM.includes(FORBIDDEN_PRODUCTION_REF));
});

test("validation content is deterministic and fit for purpose: marker section, probe token once, multiple chunks, V1 ≠ V2", () => {
  assert.equal(V1_CONTENT, vlib.V1_CONTENT);
  assert.notEqual(validationContentHash(V1_CONTENT), validationContentHash(V2_CONTENT));
  assert.equal(V1_CONTENT.split(V1_PROBE_TOKEN).length - 1, 1, "probe token exactly once");
  assert.match(V1_CONTENT, /^--- A7 2B validation section v1 ---$/m);
  const chunks = vlib.validationChunks(V1_CONTENT);
  assert.ok(chunks.length >= 3);
  chunks.forEach((c, i) => {
    assert.equal(c.chunk_index, i);
    assert.ok(c.content.length >= 1 && c.content.length <= 4000);
    assert.ok(c.source_label.length >= 1 && c.source_label.length <= 200);
  });
});
