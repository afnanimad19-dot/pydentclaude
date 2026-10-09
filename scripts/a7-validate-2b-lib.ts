// Pydent A7 — Phase 2B FUNCTIONAL validation logic. NETWORK-FREE module.
//
// Proves, against the real 0068 contract in the isolated A7 project, that the
// COMMITTED Phase 2B chunker output is accepted and persisted exactly by
// knowledge_reindex_document, using TEMPORARY validation-owned rows only:
//
//   1 temporary workspaces row ("A7-2B-VALIDATION <run uuid>")
//     → 1 temporary knowledge_resources row
//       → 1 temporary knowledge_documents row (via knowledge_apply_document_changes)
//         → temporary knowledge_chunks rows (via knowledge_reindex_document ONLY)
//
// TEST A  normal index: chunker payload persisted exactly (ordinals, content,
//         labels, headings, chars, 1..4000, hash = document hash, version =
//         resource version, FTS probe responds, exactly n rows).
// TEST B  idempotent reindex: same input → equivalent persisted set.
// TEST C  stale input: document moved to V2 via the authoritative apply
//         function; a reindex with the OLD V1 hash is rejected with NO write
//         (the still-present V1 chunks are stale-by-hash — EXPECTED); then V2
//         indexes correctly.
// TEST D  delete/cascade: deleting the document via the apply function removes
//         its chunks through the 0068 foreign key.
//
// Safety invariants of this module:
//   * Every SQL text is a fixed constant; every runtime value (UUIDs, content,
//     hashes, chunk JSON, the marker name) travels as a BOUND PARAMETER.
//   * Every statement that touches data is scoped to the CURRENT RUN's
//     validation ids; knowledge_chunks is never written directly (RPC + FK
//     cascade only); a7_guard is never referenced.
//   * Mutation is unreachable before: exact 2B confirmation → checkA7Config
//     (production blocked before any network) → pinned-ref re-assertion →
//     sentinel authorization → residue preflight (read-only; residue REFUSES,
//     never cleans) → baseline counts.
//   * Cleanup runs in `finally` once setup has begun and deletes ONLY the
//     current run's workspace by exact id AND exact name (cascades remove the
//     rest). No LIKE/prefix deletion, no historical cleanup, no retries into
//     broader scopes. Restoration is verified against the baseline counts.
//   * Output discipline: check names, PASS/FAIL, failure codes, validation-run
//     UUIDs and scrubbed transport text only. Never tokens, digests, document
//     content, or unrelated A7 row data.

import { createHash, randomUUID } from "node:crypto";
import { A7_PROJECT_REF, FORBIDDEN_PRODUCTION_REF, checkA7Config, A7GuardError } from "@/lib/a7-guard";
import {
  authorizeA7Mutation,
  type A7MutationAuthorization,
  type SentinelQueryExecutor,
} from "@/lib/a7-sentinel-guard";
import { chunkDocumentContent, chunkSourceLabel, type KnowledgeChunk } from "@/lib/knowledge-chunker";
import { A7_2B_VALIDATION_CONFIRMATION_PHRASE, A7RunnerError } from "./a7-mutate-lib";

export { A7_2B_VALIDATION_CONFIRMATION_PHRASE };

// ------------------------------------------------------------ validation data
// Deterministic, synthetic, ASCII-only. Multiple paragraphs, one section
// marker, and a unique FTS probe token per version; large enough that the
// committed chunker produces several chunks.

export const VALIDATION_MARKER_PREFIX = "A7-2B-VALIDATION";
export const VALIDATION_RESOURCE_NAME = "A7 2B validation resource";
export const VALIDATION_DOCUMENT_FILENAME = "a7-2b-validation.txt";
export const V1_PROBE_TOKEN = "a7zebravalidation";
export const V2_PROBE_TOKEN = "a7yakvalidation";

function buildValidationContent(version: "v1" | "v2", probe: string): string {
  const filler = (tag: string): string =>
    Array.from({ length: 12 }, (_, i) => `Synthetic ${version} ${tag} validation sentence ${i} ${"word ".repeat(18)}end.`).join(" ");
  return [
    `Pydent A7 Phase 2B ${version} preamble paragraph before any marker. ${filler("pre")}`,
    `--- A7 2B validation section ${version} ---`,
    `Probe paragraph containing the unique token ${probe} exactly once for the generated-FTS check.`,
    filler("alpha"),
    filler("beta"),
    filler("gamma"),
  ].join("\n\n");
}

export const V1_CONTENT = buildValidationContent("v1", V1_PROBE_TOKEN);
export const V2_CONTENT = buildValidationContent("v2", V2_PROBE_TOKEN);

/** SHA-256 hex of the exact content — same semantics as lib/knowledge.ts contentHash(). */
export const validationContentHash = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

/** The committed Phase 2B chunker, applied exactly as the indexing service does. */
export const validationChunks = (content: string): KnowledgeChunk[] =>
  chunkDocumentContent({
    content,
    sourceLabel: chunkSourceLabel(VALIDATION_RESOURCE_NAME, { filename: VALIDATION_DOCUMENT_FILENAME, sourceUrl: null }),
  });

// ------------------------------------------------------------ fixed SQL
// Constants only. $n placeholders carry every runtime value. No statement
// reaches outside the bound validation ids except the input-free count
// baselines and the marker-prefix residue DETECTION (read-only).

export const SQL_RESIDUE_PREFLIGHT =
  "select id::text as id from public.workspaces where name like $1 order by id";

export const SQL_BASELINE_COUNTS =
  "select" +
  " (select count(*)::int from public.workspaces) as workspaces," +
  " (select count(*)::int from public.knowledge_resources) as knowledge_resources," +
  " (select count(*)::int from public.knowledge_documents) as knowledge_documents," +
  " (select count(*)::int from public.knowledge_chunks) as knowledge_chunks," +
  " (select count(*)::int from public.agent_knowledge_resources) as agent_knowledge_resources," +
  " (select count(*)::int from public.agents) as agents";

export const SQL_CREATE_WORKSPACE =
  "insert into public.workspaces (id, name) values ($1::uuid, $2) returning id::text as id";

export const SQL_CREATE_RESOURCE =
  "insert into public.knowledge_resources (id, workspace_id, name, type, status)" +
  " values ($1::uuid, $2::uuid, $3, 'file', 'empty') returning id::text as id";

/** The authoritative 0065 document-write function — used for insert, replace (Test C) and delete (Test D). */
export const SQL_APPLY_DOCUMENT_CHANGES =
  "select public.knowledge_apply_document_changes($1::uuid, $2::uuid, $3::uuid, $4::jsonb, '{}'::jsonb) as result";

/** The 0068 function under test. */
export const SQL_REINDEX_DOCUMENT =
  "select public.knowledge_reindex_document($1::uuid, $2::uuid, $3, $4::jsonb) as result";

export const SQL_READ_CHUNKS =
  "select chunk_index, content, source_label, heading, chars, char_length(content) as content_len," +
  " content_hash, content_version, workspace_id::text as workspace_id, resource_id::text as resource_id," +
  " document_id::text as document_id" +
  " from public.knowledge_chunks where workspace_id = $1::uuid and document_id = $2::uuid order by chunk_index, id";

export const SQL_READ_DOCUMENT_STATE =
  "select d.content_hash, d.status, r.content_version" +
  " from public.knowledge_documents d" +
  " join public.knowledge_resources r on r.id = d.resource_id and r.workspace_id = d.workspace_id" +
  " where d.workspace_id = $1::uuid and d.id = $2::uuid";

export const SQL_FTS_PROBE =
  "select count(*)::int as hits from public.knowledge_chunks" +
  " where workspace_id = $1::uuid and document_id = $2::uuid and fts @@ websearch_to_tsquery('simple', $3)";

export const SQL_VERIFY_DOCUMENT_GONE =
  "select (select count(*)::int from public.knowledge_documents where workspace_id = $1::uuid and id = $2::uuid) as documents," +
  " (select count(*)::int from public.knowledge_chunks where workspace_id = $1::uuid and document_id = $2::uuid) as chunks";

/**
 * CURRENT-RUN cleanup: exact workspace id AND exact workspace name, both bound.
 * Never a LIKE/prefix match — residue from other runs is detected (read-only)
 * and reported, never deleted here. The 0014/0065/0068 cascades remove the
 * validation resource, document and chunks with the workspace row.
 */
export const SQL_CLEANUP_WORKSPACE =
  "delete from public.workspaces where id = $1::uuid and name = $2 returning id::text as id";

export const SQL_VERIFY_RUN_ABSENT =
  "select (select count(*)::int from public.workspaces where id = $1::uuid) as workspaces," +
  " (select count(*)::int from public.knowledge_resources where workspace_id = $1::uuid) as knowledge_resources," +
  " (select count(*)::int from public.knowledge_documents where workspace_id = $1::uuid) as knowledge_documents," +
  " (select count(*)::int from public.knowledge_chunks where workspace_id = $1::uuid) as knowledge_chunks";

// ------------------------------------------------------------ result shapes

export type ValidationCheck = { readonly name: string; readonly ok: boolean; readonly detail?: string };

export type A72bValidationReport = {
  readonly ok: boolean; // every check passed AND cleanup/restoration succeeded
  readonly ref: string;
  readonly checks: ValidationCheck[];
  readonly cleanupOk: boolean;
  /** Failing cleanup/restoration label + scrubbed transport text — never content. */
  readonly cleanupDetail?: string;
  /** Validator-owned run identifiers (safe to print; needed for manual recovery). */
  readonly runIds: { workspaceId: string; resourceId: string; documentId: string | null };
};

export type A72bValidationDeps = {
  /** Must be exactly A7_2B_VALIDATION_CONFIRMATION_PHRASE or everything is refused. */
  readonly confirmation: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly executeSentinelQuery: SentinelQueryExecutor;
  readonly executeReadOnlyQuery: (sql: string, parameters: readonly string[], context: string) => Promise<unknown>;
  readonly executeParameterizedMutation: (
    sql: string,
    parameters: readonly string[],
    context: string,
    auth: A7MutationAuthorization,
  ) => Promise<unknown>;
  /** Test-only override for the run's generated ids; the CLI passes nothing. */
  readonly runIds?: { workspaceId: string; resourceId: string; userId: string };
};

// ------------------------------------------------------------ row helpers

type Row = Record<string, unknown>;

const rowsOf = (v: unknown): Row[] =>
  Array.isArray(v) ? v.filter((r): r is Row => typeof r === "object" && r !== null) : [];

const oneRow = (v: unknown, what: string): Row => {
  const rows = rowsOf(v);
  if (rows.length !== 1) throw new A7RunnerError("VALIDATION_FAILED", `${what}: expected one row`);
  return rows[0];
};

const asInt = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : NaN;
};

/** jsonb function results may arrive as objects or as JSON text; accept both. */
const asJson = (v: unknown): Row => {
  if (typeof v === "string") {
    try {
      const parsed: unknown = JSON.parse(v);
      return typeof parsed === "object" && parsed !== null ? (parsed as Row) : {};
    } catch {
      return {};
    }
  }
  return typeof v === "object" && v !== null ? (v as Row) : {};
};

/** Failure text that is safe to report: fixed runner/guard messages (already scrubbed) or an error name. */
const safeMessage = (e: unknown): string =>
  e instanceof A7RunnerError || (e instanceof Error && (e.name === "A7GuardError" || e.name === "A7SentinelGuardError"))
    ? e.message
    : e instanceof Error
      ? `unexpected ${e.name}`
      : "unexpected error";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Comparable view of a persisted chunk row (drops row ids — stability of UUIDs is NOT required). */
const comparable = (r: Row) => ({
  chunk_index: asInt(r.chunk_index),
  content: String(r.content),
  source_label: String(r.source_label),
  heading: r.heading === null ? null : String(r.heading),
  content_hash: String(r.content_hash),
});

// ------------------------------------------------------------ the validation

const BASELINE_TABLES = [
  "workspaces",
  "knowledge_resources",
  "knowledge_documents",
  "knowledge_chunks",
  "agent_knowledge_resources",
  "agents",
] as const;

/**
 * Enforced order (mutation unreachable before 1–6):
 *   1. exact Phase 2B confirmation (the read-only and migration phrases are
 *      exact-mismatches and therefore refused);
 *   2. checkA7Config over .env.a7 (production blocked BEFORE any network);
 *   3. pinned-ref re-assertion (belt and braces, as in runLiveStep);
 *   4. sentinel authorization (one read-only query) → the mutation capability;
 *   5. residue preflight: any marker-named workspace REFUSES the run — nothing
 *      is ever cleaned here;
 *   6. baseline counts;
 *   7. setup + TESTS A–D (validation-owned rows only);
 *   8. finally: current-run cleanup + absence + baseline restoration.
 */
export async function runA72bFunctionalValidation(deps: A72bValidationDeps): Promise<A72bValidationReport> {
  // 1. Deliberate-confirmation gate, before any other work. Exact match only.
  if (deps.confirmation !== A7_2B_VALIDATION_CONFIRMATION_PHRASE) {
    throw new A7RunnerError("VALIDATION_2B_CONFIRMATION_REQUIRED");
  }

  // 2.–3. Identity guard; production refused before any network use.
  const identity = checkA7Config(deps.env);
  if (!identity.ok) throw new A7GuardError(identity.code, identity.reason);
  const ref: string = identity.ref;
  if (ref !== A7_PROJECT_REF || ref === (FORBIDDEN_PRODUCTION_REF as string)) {
    throw new A7GuardError("REF_MISMATCH", "functional validation target is not the pinned A7 project");
  }

  // 4. Sentinel authorization — the value every mutation call must carry.
  const auth = await authorizeA7Mutation(deps.executeSentinelQuery, deps.env);

  const read = (sql: string, parameters: readonly string[], context: string) =>
    deps.executeReadOnlyQuery(sql, parameters, context);
  const mutate = (sql: string, parameters: readonly string[], context: string) =>
    deps.executeParameterizedMutation(sql, parameters, context, auth);

  // 5. Residue preflight (read-only). Residue → REFUSE; never delete it here.
  const residue = rowsOf(await read(SQL_RESIDUE_PREFLIGHT, [`${VALIDATION_MARKER_PREFIX} %`], "residue-preflight"));
  if (residue.length > 0) {
    throw new A7RunnerError("VALIDATION_RESIDUE", residue.map((r) => String(r.id)).join(", ").slice(0, 300));
  }

  // 6. Baseline counts, before the first mutation.
  const baseline = oneRow(await read(SQL_BASELINE_COUNTS, [], "baseline-before"), "baseline-before");

  // Current-run identifiers (retained in-process; the ONLY rows this run owns).
  const workspaceId = deps.runIds?.workspaceId ?? randomUUID();
  const resourceId = deps.runIds?.resourceId ?? randomUUID();
  const userId = deps.runIds?.userId ?? randomUUID();
  const workspaceName = `${VALIDATION_MARKER_PREFIX} ${workspaceId}`;
  const runIds = { workspaceId, resourceId, documentId: null as string | null };

  const checks: ValidationCheck[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  let cleanupOk = true;
  let cleanupDetail: string | undefined;
  let mutated = false;

  const hashV1 = validationContentHash(V1_CONTENT);
  const hashV2 = validationContentHash(V2_CONTENT);
  const chunksV1 = validationChunks(V1_CONTENT);
  const chunksV2 = validationChunks(V2_CONTENT);

  const applyChanges = async (changes: readonly Row[], context: string): Promise<Row> =>
    asJson(oneRow(await mutate(SQL_APPLY_DOCUMENT_CHANGES, [workspaceId, resourceId, userId, JSON.stringify(changes)], context), context).result);

  const reindex = async (hash: string, chunks: readonly KnowledgeChunk[], context: string): Promise<Row> =>
    asJson(oneRow(await mutate(SQL_REINDEX_DOCUMENT, [workspaceId, runIds.documentId ?? "", hash, JSON.stringify(chunks)], context), context).result);

  const readChunks = async (context: string): Promise<Row[]> =>
    rowsOf(await read(SQL_READ_CHUNKS, [workspaceId, runIds.documentId ?? ""], context));

  try {
    // ---------------- setup: workspace → resource → ready document ----------
    mutated = true;
    await mutate(SQL_CREATE_WORKSPACE, [workspaceId, workspaceName], "setup-create-workspace");
    await mutate(SQL_CREATE_RESOURCE, [resourceId, workspaceId, VALIDATION_RESOURCE_NAME], "setup-create-resource");
    const inserted = await applyChanges(
      [{
        op: "insert", kind: "file", source_url: null, filename: VALIDATION_DOCUMENT_FILENAME, mime: "text/plain",
        content: V1_CONTENT, content_hash: hashV1, fetched_at: null, status: "ready", error: null, position: 0,
      }],
      "setup-insert-document",
    );
    const insertResult = rowsOf(inserted.results)[0];
    const documentId = String(insertResult?.id ?? "");
    runIds.documentId = UUID_RE.test(documentId) ? documentId : null;
    add("setup: ready document created via knowledge_apply_document_changes", inserted.changed === true && runIds.documentId !== null);
    if (runIds.documentId === null) throw new A7RunnerError("VALIDATION_FAILED", "setup produced no validation document id");
    add("setup: validation content produces multiple chunks", chunksV1.length >= 3, `chunks=${chunksV1.length}`);

    // ---------------- TEST A: normal index ---------------------------------
    const a = await reindex(hashV1, chunksV1, "test-a-reindex");
    add("A: stale_input=false", a.stale_input === false);
    add("A: replaced=true", a.replaced === true);
    add("A: returned chunk count matches the chunker", asInt(a.chunks) === chunksV1.length);
    const docState = oneRow(await read(SQL_READ_DOCUMENT_STATE, [workspaceId, runIds.documentId], "test-a-document-state"), "test-a-document-state");
    add("A: document hash is the V1 hash", String(docState.content_hash) === hashV1);
    const rowsA = await readChunks("test-a-read-chunks");
    add("A: exactly n persisted rows for the validation document", rowsA.length === chunksV1.length);
    add("A: workspace_id exact on every row", rowsA.every((r) => String(r.workspace_id) === workspaceId));
    add("A: resource_id exact on every row", rowsA.every((r) => String(r.resource_id) === resourceId));
    add("A: document_id exact on every row", rowsA.every((r) => String(r.document_id) === runIds.documentId));
    add("A: chunk_index exactly 0..n-1 in order", rowsA.every((r, i) => asInt(r.chunk_index) === i));
    add("A: content exactly equals chunker output", rowsA.every((r, i) => String(r.content) === chunksV1[i]?.content));
    add("A: source_label exactly equals chunker output", rowsA.every((r, i) => String(r.source_label) === chunksV1[i]?.source_label));
    add("A: heading exactly equals chunker output", rowsA.every((r, i) => (r.heading === null ? null : String(r.heading)) === (chunksV1[i]?.heading ?? null)));
    add("A: generated chars equals char_length(content)", rowsA.every((r) => asInt(r.chars) === asInt(r.content_len)));
    add("A: every chunk is 1..4000 chars", rowsA.every((r) => asInt(r.content_len) >= 1 && asInt(r.content_len) <= 4000));
    add("A: chunk content_hash equals the CURRENT document content_hash", rowsA.every((r) => String(r.content_hash) === String(docState.content_hash)));
    add("A: chunk content_version equals the CURRENT resource content_version", rowsA.every((r) => asInt(r.content_version) === asInt(docState.content_version)));
    const expectedHits = chunksV1.filter((c) => c.content.includes(V1_PROBE_TOKEN)).length;
    const probe = oneRow(await read(SQL_FTS_PROBE, [workspaceId, runIds.documentId, V1_PROBE_TOKEN], "test-a-fts-probe"), "test-a-fts-probe");
    add("A: generated FTS responds to the validation probe token", asInt(probe.hits) === expectedHits && expectedHits >= 1, `hits=${String(probe.hits)} expected=${expectedHits}`);

    // ---------------- TEST B: idempotent reindex ----------------------------
    const b = await reindex(hashV1, chunksV1, "test-b-reindex");
    add("B: stale_input=false", b.stale_input === false);
    add("B: replaced=true", b.replaced === true);
    add("B: same chunk count", asInt(b.chunks) === chunksV1.length);
    const rowsB = await readChunks("test-b-read-chunks");
    add("B: persisted set is exactly equivalent (no duplicates, no extra rows)",
      rowsB.length === rowsA.length && JSON.stringify(rowsB.map(comparable)) === JSON.stringify(rowsA.map(comparable)));

    // ---------------- TEST C: stale input -----------------------------------
    const replaced = await applyChanges(
      [{
        op: "replace", id: runIds.documentId, mime: "text/plain", content: V2_CONTENT, content_hash: hashV2,
        fetched_at: null, status: "ready", error: null, optional: false,
      }],
      "test-c-replace-document",
    );
    add("C: document moved to V2 via knowledge_apply_document_changes", replaced.changed === true);
    const beforeStale = (await readChunks("test-c-read-before-stale")).map(comparable);
    const stale = await reindex(hashV1, chunksV1, "test-c-stale-reindex");
    add("C: stale_input=true", stale.stale_input === true);
    add("C: replaced=false", stale.replaced === false);
    add("C: chunks=0 from the stale operation", asInt(stale.chunks) === 0);
    const afterStale = (await readChunks("test-c-read-after-stale")).map(comparable);
    // The V1 chunks may legitimately still exist here (stale-by-hash) — the
    // requirement is that the STALE ATTEMPT wrote nothing at all.
    add("C: persisted chunk state unchanged by the stale attempt", JSON.stringify(afterStale) === JSON.stringify(beforeStale));
    const c2 = await reindex(hashV2, chunksV2, "test-c-reindex-v2");
    add("C: V2 reindex replaced", c2.replaced === true && c2.stale_input === false && asInt(c2.chunks) === chunksV2.length);
    const rowsC = await readChunks("test-c-read-chunks-v2");
    add("C: final set corresponds only to V2 content", rowsC.length === chunksV2.length && rowsC.every((r, i) => String(r.content) === chunksV2[i]?.content));
    add("C: final set carries the V2 content_hash", rowsC.every((r) => String(r.content_hash) === hashV2));

    // ---------------- TEST D: delete / cascade ------------------------------
    await applyChanges([{ op: "delete", id: runIds.documentId, optional: false }], "test-d-delete-document");
    const gone = oneRow(await read(SQL_VERIFY_DOCUMENT_GONE, [workspaceId, runIds.documentId], "test-d-verify-cascade"), "test-d-verify-cascade");
    add("D: validation document absent after delete", asInt(gone.documents) === 0);
    add("D: validation chunks removed by the foreign-key cascade", asInt(gone.chunks) === 0);
  } catch (e) {
    add("validation sequence completed without transport error", false, safeMessage(e));
  } finally {
    if (mutated) {
      try {
        // Current-run cleanup: exact id AND exact name; cascades do the rest.
        await mutate(SQL_CLEANUP_WORKSPACE, [workspaceId, workspaceName], "cleanup-delete-run-workspace");
        const absent = oneRow(await read(SQL_VERIFY_RUN_ABSENT, [workspaceId], "cleanup-verify-run-absent"), "cleanup-verify-run-absent");
        const residueLeft = ["workspaces", "knowledge_resources", "knowledge_documents", "knowledge_chunks"]
          .filter((t) => asInt(absent[t]) !== 0);
        if (residueLeft.length > 0) {
          cleanupOk = false;
          cleanupDetail = `run rows remain in: ${residueLeft.join(", ")}`;
        }
        const after = oneRow(await read(SQL_BASELINE_COUNTS, [], "baseline-after"), "baseline-after");
        const drifted = BASELINE_TABLES.filter((t) => asInt(after[t]) !== asInt(baseline[t]));
        add("cleanup: current-run rows absent", residueLeft.length === 0, residueLeft.join(", ") || undefined);
        add("cleanup: baseline counts restored (nothing unrelated disturbed)", drifted.length === 0, drifted.join(", ") || undefined);
        if (drifted.length > 0) {
          cleanupOk = false;
          cleanupDetail = cleanupDetail ?? `baseline drift in: ${drifted.join(", ")}`;
        }
      } catch (e) {
        cleanupOk = false;
        cleanupDetail = `cleanup transport failure: ${safeMessage(e)}`;
        add("cleanup: completed", false, cleanupDetail);
      }
    }
  }

  return { ok: cleanupOk && checks.every((c) => c.ok), ref, checks, cleanupOk, cleanupDetail, runIds };
}
