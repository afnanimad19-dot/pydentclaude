// Pydent Phase 2B CANARY functional validation (P9) — NETWORK-FREE module.
//
// Proves, against the real migrated canary, that the Central Knowledge Base
// behaves exactly as the reviewed A7 Phase 2B validator established, using
// TEMPORARY validation-owned rows only, across TWO isolated workspaces:
//
//   per workspace: 1 workspaces row ("CANARY-2B-VALIDATION <workspace uuid>")
//     -> 1 knowledge_resources row -> 1 agents row -> 1 agent_knowledge_resources row
//       -> 1 knowledge_documents row (via knowledge_apply_document_changes)
//         -> knowledge_chunks rows (via knowledge_reindex_document ONLY)
//
// TESTS A-D are the A7 validator's tests, semantics unchanged (run in W1):
//   A  normal index: chunker payload persisted exactly (ordinals, content,
//      labels, headings, chars, 1..4000, hash = document hash, version =
//      resource version, FTS probe responds, exactly n rows).
//   B  idempotent reindex: same input -> equivalent persisted set.
//   C  stale input: document moved to V2 via the authoritative apply function;
//      a reindex with the OLD V1 hash is rejected with NO write; V2 indexes.
//   D  delete/cascade: deleting the document removes its chunks via the FK.
// TEST E  cross-workspace isolation (IDENTICAL content indexed in W2):
//      knowledge_match_chunks(W1, agent1) sees only W1 rows; (W1, agent2) has
//      universe 0; (W2, agent2) sees only W2 rows; workspace-scoped reads and
//      FTS probes across the (W1, doc2) pair return nothing.
// TEST F  negative contracts, exactly as the pinned functions define them
//      (raise P0002 / FK violation, NO write):
//      reindex(W1, doc2) fails; apply_changes(W1, resource2) fails; an
//      assignment in W1 referencing W2's resource violates the composite FK.
//      After each failure the persisted state is verified unchanged.
//
// Safety invariants (mirroring the reviewed A7 validator):
//   * Every SQL text is a fixed constant; every runtime value travels as a
//     BOUND PARAMETER whose shape the transport validates; workspace names are
//     transport-enforced to be "CANARY-2B-VALIDATION <their own uuid>".
//   * knowledge_chunks is never written directly (RPC + FK cascade only);
//     canary_guard and a7_guard are never referenced.
//   * Mutation is unreachable before: environment guard -> sentinel
//     authorization -> migrated-state gate (all five step markers, hardened
//     ACLs, empty history) -> residue preflight (REFUSES, never cleans) ->
//     baseline counts.
//   * Cleanup deletes ONLY the two current-run workspaces by exact id AND
//     exact name (0014/0065/0068 cascades remove agents, assignments,
//     resources, documents and chunks). No LIKE deletion, no retries into
//     broader scopes. Restoration is verified against the baseline counts;
//     failures report the run uuids for separately-approved manual recovery.
//   * Output discipline: check names, PASS/FAIL, run UUIDs and scrubbed
//     transport text only — never tokens, digests or unrelated row data.

import { createHash, randomUUID } from "node:crypto";
import { CANARY_PROJECT_REF, assertCanaryEnvironment } from "./canary-guard";
import { CANARY_STEP_ORDER } from "./canary-manifest-check";
import { STEP_MARKER_SQL, SQL_DEFAULT_ACL_API_ROLE_GRANTS } from "./canary-plan-lib";
import { SQL_HISTORY_COUNT, SQL_HISTORY_TABLE, A7_VALIDATION_MARKER_PREFIX } from "./canary-preflight-lib";
import { authorizeCanaryMutation } from "./canary-sentinel";
import {
  CanaryProbeError,
  EXPECTED_WRITE_PATH_ROLE,
  P9_SQL_APPLY_DOCUMENT_CHANGES,
  P9_SQL_CLEANUP_WORKSPACE,
  P9_SQL_CREATE_AGENT,
  P9_SQL_CREATE_ASSIGNMENT,
  P9_SQL_CREATE_RESOURCE,
  P9_SQL_CREATE_WORKSPACE,
  P9_SQL_MATCH_CHUNKS,
  P9_SQL_REINDEX_DOCUMENT,
  P9_VALIDATION_MARKER_PREFIX,
  type CanaryWriteProbeTransport,
} from "./canary-probe-lib";
import type { CanaryReadOnlyExecutor } from "./canary-transport";
import { chunkDocumentContent, chunkSourceLabel, type KnowledgeChunk } from "@/lib/knowledge-chunker";

// ------------------------------------------------------------ errors

export type CanaryValidateFailureCode =
  | "P9_NOT_MIGRATED" // the canary is not at completedThrough=apply-0068
  | "P9_ACL_NOT_HARDENED" // the P2 posture is not in place
  | "P9_HISTORY_NOT_EMPTY" // supabase_migrations has rows this tooling cannot explain
  | "P9_RESIDUE" // marker-named workspaces exist; REFUSED, never cleaned here
  | "P9_SETUP_FAILED" // fixture creation did not produce the expected ids
  | "P9_RESULT_MALFORMED"; // a result this module cannot interpret

const VALIDATE_MESSAGES: Record<CanaryValidateFailureCode, string> = {
  P9_NOT_MIGRATED: "the canary is not fully migrated (apply-0068 markers incomplete); P9 refuses to run",
  P9_ACL_NOT_HARDENED: "default privileges are not the P2-hardened posture; P9 refuses to run",
  P9_HISTORY_NOT_EMPTY: "supabase_migrations.schema_migrations has rows; P9 refuses to run beside them",
  P9_RESIDUE: "validation-marker workspaces already exist; P9 refuses and never cleans residue itself",
  P9_SETUP_FAILED: "fixture setup did not produce the expected validation rows; stopping",
  P9_RESULT_MALFORMED: "a verification returned a result this module cannot interpret; stopping",
};

export class CanaryValidateError extends Error {
  readonly code: CanaryValidateFailureCode;
  /** Check names / run uuids / counts ONLY — never content or secrets. */
  readonly detail?: string;
  constructor(code: CanaryValidateFailureCode, detail?: string) {
    super(`CANARY P9 STOPPED [${code}]: ${VALIDATE_MESSAGES[code]}${detail ? ` (${detail})` : ""}`);
    this.name = "CanaryValidateError";
    this.code = code;
    this.detail = detail;
  }
}

// ------------------------------------------------------------ validation data
// Deterministic, synthetic, ASCII-only; identical structure to the A7
// validator's content so the committed chunker produces several chunks. The
// SAME content is indexed in both workspaces, which makes the isolation test
// as strong as the schema allows: only workspace scoping can tell them apart.

export const VALIDATION_RESOURCE_NAME = "Canary 2B validation resource";
export const VALIDATION_DOCUMENT_FILENAME = "canary-2b-validation.txt";
export const V1_PROBE_TOKEN = "canaryzebravalidation";
export const V2_PROBE_TOKEN = "canaryyakvalidation";

function buildValidationContent(version: "v1" | "v2", probe: string): string {
  const filler = (tag: string): string =>
    Array.from({ length: 12 }, (_, i) => `Synthetic ${version} ${tag} validation sentence ${i} ${"word ".repeat(18)}end.`).join(" ");
  return [
    `Pydent canary Phase 2B ${version} preamble paragraph before any marker. ${filler("pre")}`,
    `--- Canary 2B validation section ${version} ---`,
    `Probe paragraph containing the unique token ${probe} exactly once for the generated-FTS check.`,
    filler("alpha"),
    filler("beta"),
    filler("gamma"),
  ].join("\n\n");
}

export const V1_CONTENT = buildValidationContent("v1", V1_PROBE_TOKEN);
export const V2_CONTENT = buildValidationContent("v2", V2_PROBE_TOKEN);

export const validationContentHash = (content: string): string => createHash("sha256").update(content, "utf8").digest("hex");

/** The committed Phase 2B chunker, applied exactly as the indexing service does. */
export const validationChunks = (content: string): KnowledgeChunk[] =>
  chunkDocumentContent({
    content,
    sourceLabel: chunkSourceLabel(VALIDATION_RESOURCE_NAME, { filename: VALIDATION_DOCUMENT_FILENAME, sourceUrl: null }),
  });

// ------------------------------------------------------------ fixed read-only SQL

export const SQL_P9_RESIDUE =
  "select id::text as id from public.workspaces where name like $1 or name like $2 order by id";

export const SQL_P9_BASELINE_COUNTS =
  "select" +
  " (select count(*)::int from public.workspaces) as workspaces," +
  " (select count(*)::int from public.knowledge_resources) as knowledge_resources," +
  " (select count(*)::int from public.knowledge_documents) as knowledge_documents," +
  " (select count(*)::int from public.knowledge_chunks) as knowledge_chunks," +
  " (select count(*)::int from public.agent_knowledge_resources) as agent_knowledge_resources," +
  " (select count(*)::int from public.agents) as agents";

export const SQL_P9_READ_CHUNKS =
  "select chunk_index, content, source_label, heading, chars, char_length(content) as content_len," +
  " content_hash, content_version, workspace_id::text as workspace_id, resource_id::text as resource_id," +
  " document_id::text as document_id" +
  " from public.knowledge_chunks where workspace_id = $1::uuid and document_id = $2::uuid order by chunk_index, id";

export const SQL_P9_READ_DOCUMENT_STATE =
  "select d.content_hash, d.status, r.content_version" +
  " from public.knowledge_documents d" +
  " join public.knowledge_resources r on r.id = d.resource_id and r.workspace_id = d.workspace_id" +
  " where d.workspace_id = $1::uuid and d.id = $2::uuid";

export const SQL_P9_FTS_PROBE =
  "select count(*)::int as hits from public.knowledge_chunks" +
  " where workspace_id = $1::uuid and document_id = $2::uuid and fts @@ websearch_to_tsquery('simple', $3)";

export const SQL_P9_VERIFY_DOCUMENT_GONE =
  "select (select count(*)::int from public.knowledge_documents where workspace_id = $1::uuid and id = $2::uuid) as documents," +
  " (select count(*)::int from public.knowledge_chunks where workspace_id = $1::uuid and document_id = $2::uuid) as chunks";

export const SQL_P9_VERIFY_RUN_ABSENT =
  "select (select count(*)::int from public.workspaces where id = $1::uuid) as workspaces," +
  " (select count(*)::int from public.knowledge_resources where workspace_id = $1::uuid) as knowledge_resources," +
  " (select count(*)::int from public.knowledge_documents where workspace_id = $1::uuid) as knowledge_documents," +
  " (select count(*)::int from public.knowledge_chunks where workspace_id = $1::uuid) as knowledge_chunks," +
  " (select count(*)::int from public.agent_knowledge_resources where workspace_id = $1::uuid) as agent_knowledge_resources," +
  " (select count(*)::int from public.agents where workspace_id = $1::uuid) as agents";

export const SQL_P9_COUNT_WORKSPACE_STATE =
  "select (select count(*)::int from public.knowledge_documents where workspace_id = $1::uuid) as documents," +
  " (select count(*)::int from public.agent_knowledge_resources where workspace_id = $1::uuid) as assignments";

// ------------------------------------------------------------ shapes and helpers

export type ValidationCheck = { readonly name: string; readonly ok: boolean; readonly detail?: string };

export type WorkspaceRunIds = {
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly agentId: string;
  documentId: string | null;
};

export type Canary2bValidationReport = {
  readonly ok: boolean; // every check passed AND cleanup/restoration succeeded
  readonly target: typeof CANARY_PROJECT_REF;
  readonly checks: ValidationCheck[];
  readonly cleanupOk: boolean;
  readonly cleanupDetail?: string;
  /** Run-owned uuids (safe to print; needed for separately-approved manual recovery). */
  readonly runIds: { readonly w1: WorkspaceRunIds; readonly w2: WorkspaceRunIds };
};

type Row = Record<string, unknown>;

const rowsOf = (v: unknown): Row[] => (Array.isArray(v) ? v.filter((r): r is Row => typeof r === "object" && r !== null) : []);

const oneRow = (v: unknown, what: string): Row => {
  const rows = rowsOf(v);
  if (rows.length !== 1) throw new CanaryValidateError("P9_RESULT_MALFORMED", `${what}: expected one row`);
  return rows[0];
};

const asInt = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : NaN;
};

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

const allTrue = (row: Row): boolean => Object.values(row).length > 0 && Object.values(row).every((v) => v === true);

const safeMessage = (e: unknown): string =>
  e instanceof CanaryProbeError || e instanceof CanaryValidateError || (e instanceof Error && e.name === "CanaryError")
    ? e.message
    : e instanceof Error
      ? `unexpected ${e.name}`
      : "unexpected error";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Comparable view of a persisted chunk row (drops row ids — uuid stability is NOT required). */
const comparable = (r: Row) => ({
  chunk_index: asInt(r.chunk_index),
  content: String(r.content),
  source_label: String(r.source_label),
  heading: r.heading === null ? null : String(r.heading),
  content_hash: String(r.content_hash),
});

const BASELINE_TABLES = [
  "workspaces",
  "knowledge_resources",
  "knowledge_documents",
  "knowledge_chunks",
  "agent_knowledge_resources",
  "agents",
] as const;

export type Canary2bValidationDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readOnly: CanaryReadOnlyExecutor;
  readonly probe: CanaryWriteProbeTransport;
  /** Test-only override for generated ids; the CLI passes nothing. */
  readonly runIds?: {
    readonly w1: { workspaceId: string; resourceId: string; agentId: string };
    readonly w2: { workspaceId: string; resourceId: string; agentId: string };
    readonly userId: string;
  };
};

// ------------------------------------------------------------ the validation

export async function runCanary2bFunctionalValidation(deps: Canary2bValidationDeps): Promise<Canary2bValidationReport> {
  assertCanaryEnvironment(deps.env);

  // Sentinel authorization — mutation is unreachable without it.
  await authorizeCanaryMutation(deps.readOnly, deps.env);

  const read = (sql: string, parameters: readonly string[], context: string) => deps.readOnly(sql, parameters, context);
  const mutate = (sql: string, parameters: readonly string[], context: string) => deps.probe.runValidationStatement(sql, parameters, context);

  // Migrated-state gate: every step's markers, hardened ACLs, empty history.
  for (const stepId of CANARY_STEP_ORDER) {
    const row = oneRow(await read(STEP_MARKER_SQL[stepId], [], `p9-markers-${stepId}`), `p9-markers-${stepId}`);
    if (!allTrue(row)) throw new CanaryValidateError("P9_NOT_MIGRATED", stepId);
  }
  const acl = rowsOf(await read(SQL_DEFAULT_ACL_API_ROLE_GRANTS, [], "p9-acl"));
  const aclDirty = acl.filter(
    (r) => r.owner === EXPECTED_WRITE_PATH_ROLE && (r.objtype === "r" || r.objtype === "S") && String(r.api_role_grantees ?? "") !== "",
  );
  if (aclDirty.length !== 0) throw new CanaryValidateError("P9_ACL_NOT_HARDENED", `rows=${aclDirty.length}`);
  const historyPresent = oneRow(await read(SQL_HISTORY_TABLE, [], "p9-history"), "p9-history").present === true;
  if (historyPresent) {
    const rows = asInt(oneRow(await read(SQL_HISTORY_COUNT, [], "p9-history-count"), "p9-history-count").rows);
    if (rows !== 0) throw new CanaryValidateError("P9_HISTORY_NOT_EMPTY", `rows=${rows}`);
  }

  // Residue preflight (both marker families): residue REFUSES the run.
  const residue = rowsOf(
    await read(SQL_P9_RESIDUE, [`${P9_VALIDATION_MARKER_PREFIX} %`, `${A7_VALIDATION_MARKER_PREFIX} %`], "p9-residue"),
  );
  if (residue.length > 0) {
    throw new CanaryValidateError("P9_RESIDUE", residue.map((r) => String(r.id)).join(", ").slice(0, 300));
  }

  // Baseline counts before the first mutation.
  const baseline = oneRow(await read(SQL_P9_BASELINE_COUNTS, [], "p9-baseline-before"), "p9-baseline-before");

  const mk = (ids?: { workspaceId: string; resourceId: string; agentId: string }): WorkspaceRunIds => ({
    workspaceId: ids?.workspaceId ?? randomUUID(),
    resourceId: ids?.resourceId ?? randomUUID(),
    agentId: ids?.agentId ?? randomUUID(),
    documentId: null,
  });
  const w1 = mk(deps.runIds?.w1);
  const w2 = mk(deps.runIds?.w2);
  const userId = deps.runIds?.userId ?? randomUUID();
  const wsName = (w: WorkspaceRunIds) => `${P9_VALIDATION_MARKER_PREFIX} ${w.workspaceId}`;

  const checks: ValidationCheck[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  let cleanupOk = true;
  let cleanupDetail: string | undefined;
  let mutated = false;

  const hashV1 = validationContentHash(V1_CONTENT);
  const hashV2 = validationContentHash(V2_CONTENT);
  const chunksV1 = validationChunks(V1_CONTENT);
  const chunksV2 = validationChunks(V2_CONTENT);

  const applyChanges = async (w: WorkspaceRunIds, resourceId: string, changes: readonly Row[], context: string): Promise<Row> =>
    asJson(oneRow(await mutate(P9_SQL_APPLY_DOCUMENT_CHANGES, [w.workspaceId, resourceId, userId, JSON.stringify(changes)], context), context).result);

  const reindex = async (workspaceId: string, documentId: string, hash: string, chunks: readonly KnowledgeChunk[], context: string): Promise<Row> =>
    asJson(oneRow(await mutate(P9_SQL_REINDEX_DOCUMENT, [workspaceId, documentId, hash, JSON.stringify(chunks)], context), context).result);

  const match = async (workspaceId: string, agentId: string, query: string, context: string): Promise<Row> =>
    asJson(oneRow(await mutate(P9_SQL_MATCH_CHUNKS, [workspaceId, agentId, query], context), context).result);

  const readChunks = async (workspaceId: string, documentId: string, context: string): Promise<Row[]> =>
    rowsOf(await read(SQL_P9_READ_CHUNKS, [workspaceId, documentId], context));

  const insertDocument = async (w: WorkspaceRunIds, context: string): Promise<void> => {
    const inserted = await applyChanges(
      w,
      w.resourceId,
      [{
        op: "insert", kind: "file", source_url: null, filename: VALIDATION_DOCUMENT_FILENAME, mime: "text/plain",
        content: V1_CONTENT, content_hash: hashV1, fetched_at: null, status: "ready", error: null, position: 0,
      }],
      context,
    );
    const id = String(rowsOf(inserted.results)[0]?.id ?? "");
    w.documentId = UUID_RE.test(id) ? id : null;
    if (inserted.changed !== true || w.documentId === null) {
      throw new CanaryValidateError("P9_SETUP_FAILED", `${context}: no validation document id`);
    }
  };

  /** A negative contract case: the statement MUST fail at the transport. */
  const expectContractFailure = async (fn: () => Promise<unknown>, name: string): Promise<void> => {
    try {
      await fn();
      add(name, false, "the statement unexpectedly succeeded");
    } catch (e) {
      add(name, e instanceof CanaryProbeError && e.code === "PROBE_HTTP_ERROR", safeMessage(e).slice(0, 160));
    }
  };

  try {
    // ---------------- setup: two isolated worlds -----------------------------
    mutated = true;
    for (const [w, label] of [[w1, "w1"], [w2, "w2"]] as const) {
      await mutate(P9_SQL_CREATE_WORKSPACE, [w.workspaceId, wsName(w)], `setup-${label}-workspace`);
      await mutate(P9_SQL_CREATE_RESOURCE, [w.resourceId, w.workspaceId, VALIDATION_RESOURCE_NAME], `setup-${label}-resource`);
      await mutate(P9_SQL_CREATE_AGENT, [w.agentId, w.workspaceId, `Canary 2B validation agent ${label}`], `setup-${label}-agent`);
      await mutate(P9_SQL_CREATE_ASSIGNMENT, [w.workspaceId, w.agentId, w.resourceId], `setup-${label}-assignment`);
      await insertDocument(w, `setup-${label}-document`);
    }
    add("setup: two validation workspaces with resource, agent, assignment and ready document", true);
    add("setup: validation content produces multiple chunks", chunksV1.length >= 3, `chunks=${chunksV1.length}`);
    const doc1 = w1.documentId as string;
    const doc2 = w2.documentId as string;

    // ---------------- TEST A: normal index (W1) ------------------------------
    const a = await reindex(w1.workspaceId, doc1, hashV1, chunksV1, "test-a-reindex");
    add("A: stale_input=false", a.stale_input === false);
    add("A: replaced=true", a.replaced === true);
    add("A: returned chunk count matches the chunker", asInt(a.chunks) === chunksV1.length);
    const docState = oneRow(await read(SQL_P9_READ_DOCUMENT_STATE, [w1.workspaceId, doc1], "test-a-document-state"), "test-a-document-state");
    add("A: document hash is the V1 hash", String(docState.content_hash) === hashV1);
    const rowsA = await readChunks(w1.workspaceId, doc1, "test-a-read-chunks");
    add("A: exactly n persisted rows for the validation document", rowsA.length === chunksV1.length);
    add("A: workspace_id exact on every row", rowsA.every((r) => String(r.workspace_id) === w1.workspaceId));
    add("A: resource_id exact on every row", rowsA.every((r) => String(r.resource_id) === w1.resourceId));
    add("A: document_id exact on every row", rowsA.every((r) => String(r.document_id) === doc1));
    add("A: chunk_index exactly 0..n-1 in order", rowsA.every((r, i) => asInt(r.chunk_index) === i));
    add("A: content exactly equals chunker output", rowsA.every((r, i) => String(r.content) === chunksV1[i]?.content));
    add("A: source_label exactly equals chunker output", rowsA.every((r, i) => String(r.source_label) === chunksV1[i]?.source_label));
    add("A: heading exactly equals chunker output", rowsA.every((r, i) => (r.heading === null ? null : String(r.heading)) === (chunksV1[i]?.heading ?? null)));
    add("A: generated chars equals char_length(content)", rowsA.every((r) => asInt(r.chars) === asInt(r.content_len)));
    add("A: every chunk is 1..4000 chars", rowsA.every((r) => asInt(r.content_len) >= 1 && asInt(r.content_len) <= 4000));
    add("A: chunk content_hash equals the CURRENT document content_hash", rowsA.every((r) => String(r.content_hash) === String(docState.content_hash)));
    add("A: chunk content_version equals the CURRENT resource content_version", rowsA.every((r) => asInt(r.content_version) === asInt(docState.content_version)));
    const expectedHits = chunksV1.filter((c) => c.content.includes(V1_PROBE_TOKEN)).length;
    const probe = oneRow(await read(SQL_P9_FTS_PROBE, [w1.workspaceId, doc1, V1_PROBE_TOKEN], "test-a-fts-probe"), "test-a-fts-probe");
    add("A: generated FTS responds to the validation probe token", asInt(probe.hits) === expectedHits && expectedHits >= 1, `hits=${String(probe.hits)} expected=${expectedHits}`);

    // Index the IDENTICAL content in W2 (setup for the isolation test).
    const w2Index = await reindex(w2.workspaceId, doc2, hashV1, chunksV1, "setup-w2-reindex");
    add("setup: identical content indexed in W2", w2Index.replaced === true && asInt(w2Index.chunks) === chunksV1.length);

    // ---------------- TEST B: idempotent reindex (W1) ------------------------
    const b = await reindex(w1.workspaceId, doc1, hashV1, chunksV1, "test-b-reindex");
    add("B: stale_input=false", b.stale_input === false);
    add("B: replaced=true", b.replaced === true);
    add("B: same chunk count", asInt(b.chunks) === chunksV1.length);
    const rowsB = await readChunks(w1.workspaceId, doc1, "test-b-read-chunks");
    add("B: persisted set is exactly equivalent (no duplicates, no extra rows)",
      rowsB.length === rowsA.length && JSON.stringify(rowsB.map(comparable)) === JSON.stringify(rowsA.map(comparable)));

    // ---------------- TEST E: cross-workspace isolation ----------------------
    const e1 = await match(w1.workspaceId, w1.agentId, V1_PROBE_TOKEN, "test-e-match-w1");
    const e1matches = Array.isArray(e1.matches) ? (e1.matches as Row[]) : [];
    add("E: match(W1, agent1) searches exactly W1's current chunks", asInt(e1.searched_chunks) === chunksV1.length, `searched=${String(e1.searched_chunks)}`);
    add("E: match(W1, agent1) returns at least one match for the probe", e1matches.length >= 1);
    add("E: every match belongs to W1's document and resource",
      e1matches.every((m) => String(m.document_id) === doc1 && String(m.resource_id) === w1.resourceId));
    const eCross = await match(w1.workspaceId, w2.agentId, V1_PROBE_TOKEN, "test-e-match-cross");
    add("E: match(W1, agent2) has universe 0 and no matches (assignment is workspace-scoped)",
      asInt(eCross.searched_chunks) === 0 && Array.isArray(eCross.matches) && (eCross.matches as unknown[]).length === 0);
    const e2 = await match(w2.workspaceId, w2.agentId, V1_PROBE_TOKEN, "test-e-match-w2");
    const e2matches = Array.isArray(e2.matches) ? (e2.matches as Row[]) : [];
    add("E: match(W2, agent2) returns only W2's document despite identical content",
      e2matches.length >= 1 && e2matches.every((m) => String(m.document_id) === doc2));
    add("E: workspace-scoped read of (W1, doc2) is empty", (await readChunks(w1.workspaceId, doc2, "test-e-cross-read")).length === 0);
    const crossProbe = oneRow(await read(SQL_P9_FTS_PROBE, [w1.workspaceId, doc2, V1_PROBE_TOKEN], "test-e-cross-probe"), "test-e-cross-probe");
    add("E: FTS probe across the (W1, doc2) pair returns no hits", asInt(crossProbe.hits) === 0);

    // ---------------- TEST F: negative contracts (no write) ------------------
    const w2Before = (await readChunks(w2.workspaceId, doc2, "test-f-w2-before")).map(comparable);
    const stateBefore = oneRow(await read(SQL_P9_COUNT_WORKSPACE_STATE, [w2.workspaceId], "test-f-state-before"), "test-f-state-before");
    await expectContractFailure(
      () => reindex(w1.workspaceId, doc2, hashV1, chunksV1, "test-f-cross-reindex"),
      "F: reindex with a cross-workspace document is rejected (P0002 contract)",
    );
    await expectContractFailure(
      () => applyChanges(w1, w2.resourceId, [{ op: "insert", kind: "file", source_url: null, filename: VALIDATION_DOCUMENT_FILENAME, mime: "text/plain", content: V1_CONTENT, content_hash: hashV1, fetched_at: null, status: "ready", error: null, position: 1 }], "test-f-cross-apply"),
      "F: apply_changes with a cross-workspace resource is rejected (P0002 contract)",
    );
    await expectContractFailure(
      () => mutate(P9_SQL_CREATE_ASSIGNMENT, [w1.workspaceId, w1.agentId, w2.resourceId], "test-f-cross-assignment"),
      "F: an assignment referencing another workspace's resource violates the composite FK",
    );
    const w2After = (await readChunks(w2.workspaceId, doc2, "test-f-w2-after")).map(comparable);
    const stateAfter = oneRow(await read(SQL_P9_COUNT_WORKSPACE_STATE, [w2.workspaceId], "test-f-state-after"), "test-f-state-after");
    add("F: W2 chunks unchanged by every rejected statement", JSON.stringify(w2After) === JSON.stringify(w2Before));
    add("F: W2 document and assignment counts unchanged",
      asInt(stateAfter.documents) === asInt(stateBefore.documents) && asInt(stateAfter.assignments) === asInt(stateBefore.assignments));

    // ---------------- TEST C: stale input (W1) -------------------------------
    const replaced = await applyChanges(
      w1,
      w1.resourceId,
      [{ op: "replace", id: doc1, mime: "text/plain", content: V2_CONTENT, content_hash: hashV2, fetched_at: null, status: "ready", error: null, optional: false }],
      "test-c-replace-document",
    );
    add("C: document moved to V2 via knowledge_apply_document_changes", replaced.changed === true);
    const beforeStale = (await readChunks(w1.workspaceId, doc1, "test-c-read-before-stale")).map(comparable);
    const stale = await reindex(w1.workspaceId, doc1, hashV1, chunksV1, "test-c-stale-reindex");
    add("C: stale_input=true", stale.stale_input === true);
    add("C: replaced=false", stale.replaced === false);
    add("C: chunks=0 from the stale operation", asInt(stale.chunks) === 0);
    const afterStale = (await readChunks(w1.workspaceId, doc1, "test-c-read-after-stale")).map(comparable);
    add("C: persisted chunk state unchanged by the stale attempt", JSON.stringify(afterStale) === JSON.stringify(beforeStale));
    const c2 = await reindex(w1.workspaceId, doc1, hashV2, chunksV2, "test-c-reindex-v2");
    add("C: V2 reindex replaced", c2.replaced === true && c2.stale_input === false && asInt(c2.chunks) === chunksV2.length);
    const rowsC = await readChunks(w1.workspaceId, doc1, "test-c-read-chunks-v2");
    add("C: final set corresponds only to V2 content", rowsC.length === chunksV2.length && rowsC.every((r, i) => String(r.content) === chunksV2[i]?.content));
    add("C: final set carries the V2 content_hash", rowsC.every((r) => String(r.content_hash) === hashV2));

    // ---------------- TEST D: delete / cascade (W1) --------------------------
    await applyChanges(w1, w1.resourceId, [{ op: "delete", id: doc1, optional: false }], "test-d-delete-document");
    const gone = oneRow(await read(SQL_P9_VERIFY_DOCUMENT_GONE, [w1.workspaceId, doc1], "test-d-verify-cascade"), "test-d-verify-cascade");
    add("D: validation document absent after delete", asInt(gone.documents) === 0);
    add("D: validation chunks removed by the foreign-key cascade", asInt(gone.chunks) === 0);
  } catch (e) {
    add("validation sequence completed without transport error", false, safeMessage(e));
  } finally {
    if (mutated) {
      try {
        for (const [w, label] of [[w1, "w1"], [w2, "w2"]] as const) {
          await mutate(P9_SQL_CLEANUP_WORKSPACE, [w.workspaceId, wsName(w)], `cleanup-${label}-workspace`);
          const absent = oneRow(await read(SQL_P9_VERIFY_RUN_ABSENT, [w.workspaceId], `cleanup-${label}-absent`), `cleanup-${label}-absent`);
          const left = BASELINE_TABLES.filter((t) => asInt(absent[t]) !== 0);
          add(`cleanup: ${label} rows absent (workspace cascade covered agents, assignments, resources, documents, chunks)`, left.length === 0, left.join(", ") || undefined);
          if (left.length > 0) {
            cleanupOk = false;
            cleanupDetail = cleanupDetail ?? `${label} rows remain in: ${left.join(", ")}`;
          }
        }
        const after = oneRow(await read(SQL_P9_BASELINE_COUNTS, [], "p9-baseline-after"), "p9-baseline-after");
        const drifted = BASELINE_TABLES.filter((t) => asInt(after[t]) !== asInt(baseline[t]));
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

  return { ok: cleanupOk && checks.every((c) => c.ok), target: CANARY_PROJECT_REF, checks, cleanupOk, cleanupDetail, runIds: { w1, w2 } };
}
