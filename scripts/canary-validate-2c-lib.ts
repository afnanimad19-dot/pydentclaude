// Pydent Phase 2C CANARY retrieval integration validation — NETWORK-FREE module.
//
// Proves, against the real migrated canary, that the Phase 2C retrieval
// ladder behaves exactly as the offline suite established, with TEMPORARY
// validation-owned rows only. Two legs share one fixture world:
//
//   Leg A (SQL truth): knowledge_match_chunks through the existing hardened
//   Management-API write transport (the frozen P9 MATCH_CHUNKS statement),
//   fed the REAL ftsQueryFor output — universes, matches, attribution and
//   websearch OR-semantics are asserted at the database.
//   Leg B (the production seam): the REAL searchKnowledgeCore /
//   centralRetrievalForReply run with a canary-bound matcher + loader
//   (PostgREST via scripts/canary-kb-client.ts, or fakes in offline tests).
//
// Fixture world (synthetic ASCII content; committed chunker, like P9):
//   W1: agentA → R1 "violet" (indexed) and R3 "citrine" (indexed, later made
//       STALE by an apply without reindex); agentC → R3 only; agentD → no
//       assignments (legacy agent); R2 "amber" exists UNASSIGNED with an
//       indexed document.
//   W2: agentB → RB "indigo" (identical structure; isolation world).
//
// The checks map 1:1 to the authorized Step 70 matrix:
//   (1) authorized retrieval  (2) correct matches + OR semantics
//   (3) genuine zero-match, no broadening  (4) cross-workspace isolation
//   (5) unassigned exclusion  (6) stale-hash exclusion (and recovery)
//   (7) fallback when no usable index exists (assigned→document path;
//       unassigned→legacy)  (8) source attribution  (9) log hygiene.
//
// Safety invariants are P9's, unchanged: the SAME frozen parameterized
// statements (the allowlist is NOT expanded), transport-enforced marker
// names, sentinel + migrated-state + residue + baseline gates before any
// write, exact-id-and-name cleanup in finally with absence and baseline
// restoration, and output discipline (check names, counts, run uuids,
// scrubbed transport text — never knowledge content or credentials).
//
// This module performs no network I/O and VALUE-imports no application
// module that constructs a database client; the app functions under test
// (searchKnowledgeCore, centralRetrievalForReply, ftsQueryFor) are INJECTED
// by the CLI or the offline tests.

import { randomUUID, createHash } from "node:crypto";
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
import {
  SQL_P9_BASELINE_COUNTS,
  SQL_P9_RESIDUE,
  SQL_P9_VERIFY_RUN_ABSENT,
} from "./canary-validate-lib";
import type { CanaryReadOnlyExecutor } from "./canary-transport";
import { chunkDocumentContent, chunkSourceLabel, type KnowledgeChunk } from "@/lib/knowledge-chunker";
import type { ChunkMatcher, CentralKnowledgeLoader } from "@/lib/knowledge-runtime";
import type { KnowledgeResult, ReplyRetrieval } from "@/lib/agent-tools-core";

// ------------------------------------------------------------ errors

export type Canary2cFailureCode =
  | "C2C_GATE_FAILED" // a pre-mutation gate (markers, ACL, history) refused
  | "C2C_RESIDUE" // marker-named workspaces exist; REFUSED, never cleaned here
  | "C2C_SETUP_FAILED" // fixture creation did not produce the expected ids
  | "C2C_RESULT_MALFORMED"; // a result this module cannot interpret

const C2C_MESSAGES: Record<Canary2cFailureCode, string> = {
  C2C_GATE_FAILED: "a pre-mutation gate refused (not migrated / ACL not hardened / history not empty); 2C validation stops",
  C2C_RESIDUE: "validation-marker workspaces already exist; 2C validation refuses and never cleans residue itself",
  C2C_SETUP_FAILED: "fixture setup did not produce the expected validation rows; stopping",
  C2C_RESULT_MALFORMED: "a verification returned a result this module cannot interpret; stopping",
};

export class Canary2cError extends Error {
  readonly code: Canary2cFailureCode;
  readonly detail?: string;
  constructor(code: Canary2cFailureCode, detail?: string) {
    super(`CANARY 2C STOPPED [${code}]: ${C2C_MESSAGES[code]}${detail ? ` (${detail})` : ""}`);
    this.name = "Canary2cError";
    this.code = code;
    this.detail = detail;
  }
}

// ------------------------------------------------------------ synthetic fixtures

export const C2C_TOKEN_W1 = "canaryvioletretrieval";
export const C2C_TOKEN_UNASSIGNED = "canaryamberretrieval";
export const C2C_TOKEN_STALE_V1 = "canarycitrineretrieval";
export const C2C_TOKEN_STALE_V2 = "canarytealretrieval";
export const C2C_TOKEN_W2 = "canaryindigoretrieval";
export const C2C_ABSENT_TOKEN = "canaryabsentretrievalterm";
export const C2C_LEGACY_BLOB = "LEGACY-2C-BLOB-FACT canarylegacyretrieval appears only in the per-agent blob.";

export function buildC2cContent(tag: string, token: string): string {
  const filler = (sub: string): string =>
    Array.from({ length: 12 }, (_, i) => `Synthetic ${tag} ${sub} retrieval sentence ${i} ${"word ".repeat(18)}end.`).join(" ");
  return [
    `Pydent canary Phase 2C ${tag} preamble paragraph. ${filler("pre")}`,
    `--- Canary 2C ${tag} section ---`,
    `Probe paragraph containing the unique token ${token} exactly once for the retrieval checks.`,
    filler("alpha"),
    filler("beta"),
  ].join("\n\n");
}

export interface C2cResourceFixture {
  readonly label: "violet" | "amber" | "citrine" | "indigo";
  readonly name: string;
  readonly filename: string;
  readonly content: string;
}

const fixture = (label: C2cResourceFixture["label"], token: string): C2cResourceFixture => ({
  label,
  name: `Canary 2C ${label} resource`,
  filename: `canary-2c-${label}.txt`,
  content: buildC2cContent(label, token),
});

export const FX_VIOLET = fixture("violet", C2C_TOKEN_W1);
export const FX_AMBER = fixture("amber", C2C_TOKEN_UNASSIGNED);
export const FX_CITRINE = fixture("citrine", C2C_TOKEN_STALE_V1);
export const FX_INDIGO = fixture("indigo", C2C_TOKEN_W2);
export const CITRINE_V2_CONTENT = buildC2cContent("citrine-v2", C2C_TOKEN_STALE_V2);

export const c2cHash = (content: string): string => createHash("sha256").update(content, "utf8").digest("hex");
export const c2cChunks = (fx: Pick<C2cResourceFixture, "name" | "filename">, content: string): KnowledgeChunk[] =>
  chunkDocumentContent({ content, sourceLabel: chunkSourceLabel(fx.name, { filename: fx.filename, sourceUrl: null }) });
export const c2cLabel = (fx: Pick<C2cResourceFixture, "name" | "filename">): string =>
  chunkSourceLabel(fx.name, { filename: fx.filename, sourceUrl: null });

// ------------------------------------------------------------ deps and report

export type ValidationCheck = { readonly name: string; readonly ok: boolean; readonly detail?: string };

type AgentArg = { id: string; workspace_id: string; name: string; knowledge_base: string | null };

/** The injected application functions under test (real in the CLI, real in offline tests too). */
export type C2cAppFns = {
  readonly searchCore: (
    agent: AgentArg,
    a: { query?: unknown; context?: unknown },
    channel: string,
    loader: CentralKnowledgeLoader,
    matcher: ChunkMatcher
  ) => Promise<KnowledgeResult>;
  readonly replyRetrieval: (
    agent: AgentArg,
    messages: { role: string; content: string }[],
    channel: string,
    loader: CentralKnowledgeLoader,
    matcher: ChunkMatcher
  ) => Promise<ReplyRetrieval | null>;
  readonly ftsQuery: (queries: readonly string[]) => string;
};

export type Canary2cDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readOnly: CanaryReadOnlyExecutor;
  readonly probe: CanaryWriteProbeTransport;
  /** Leg B bindings: canary-bound in the CLI, fakes in offline tests. */
  readonly matcher: ChunkMatcher;
  readonly loader: CentralKnowledgeLoader;
  readonly app: C2cAppFns;
  /** Test-only override for generated ids; the CLI passes nothing. */
  readonly runIds?: { readonly w1: string; readonly w2: string };
};

export type Canary2cReport = {
  readonly ok: boolean;
  readonly target: typeof CANARY_PROJECT_REF;
  readonly checks: ValidationCheck[];
  readonly cleanupOk: boolean;
  readonly cleanupDetail?: string;
  readonly runIds: { readonly w1: string; readonly w2: string };
  /** How many captured Leg B log lines leaked fixture content (must be 0). */
  readonly logLeaks: number;
};

type Row = Record<string, unknown>;
const rowsOf = (v: unknown): Row[] => (Array.isArray(v) ? v.filter((r): r is Row => typeof r === "object" && r !== null) : []);
const oneRow = (v: unknown, what: string): Row => {
  const rows = rowsOf(v);
  if (rows.length !== 1) throw new Canary2cError("C2C_RESULT_MALFORMED", `${what}: expected one row`);
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
  e instanceof CanaryProbeError || e instanceof Canary2cError || (e instanceof Error && (e.name === "CanaryError" || e.name === "CanaryValidateError"))
    ? e.message
    : e instanceof Error
      ? `unexpected ${e.name}`
      : "unexpected error";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BASELINE_TABLES = ["workspaces", "knowledge_resources", "knowledge_documents", "knowledge_chunks", "agent_knowledge_resources", "agents"] as const;

// ------------------------------------------------------------ the validation

export async function runCanary2cRetrievalValidation(deps: Canary2cDeps): Promise<Canary2cReport> {
  assertCanaryEnvironment(deps.env);
  await authorizeCanaryMutation(deps.readOnly, deps.env);

  const read = (sql: string, parameters: readonly string[], context: string) => deps.readOnly(sql, parameters, context);
  const mutate = (sql: string, parameters: readonly string[], context: string) => deps.probe.runValidationStatement(sql, parameters, context);

  // Migrated-state gate, hardened ACLs, empty history — refuse before any write.
  for (const stepId of CANARY_STEP_ORDER) {
    const row = oneRow(await read(STEP_MARKER_SQL[stepId], [], `c2c-markers-${stepId}`), `c2c-markers-${stepId}`);
    if (!allTrue(row)) throw new Canary2cError("C2C_GATE_FAILED", `markers:${stepId}`);
  }
  const acl = rowsOf(await read(SQL_DEFAULT_ACL_API_ROLE_GRANTS, [], "c2c-acl"));
  const aclDirty = acl.filter(
    (r) => r.owner === EXPECTED_WRITE_PATH_ROLE && (r.objtype === "r" || r.objtype === "S") && String(r.api_role_grantees ?? "") !== "",
  );
  if (aclDirty.length !== 0) throw new Canary2cError("C2C_GATE_FAILED", `acl rows=${aclDirty.length}`);
  if (oneRow(await read(SQL_HISTORY_TABLE, [], "c2c-history"), "c2c-history").present === true) {
    const rows = asInt(oneRow(await read(SQL_HISTORY_COUNT, [], "c2c-history-count"), "c2c-history-count").rows);
    if (rows !== 0) throw new Canary2cError("C2C_GATE_FAILED", `history rows=${rows}`);
  }
  const residue = rowsOf(await read(SQL_P9_RESIDUE, [`${P9_VALIDATION_MARKER_PREFIX} %`, `${A7_VALIDATION_MARKER_PREFIX} %`], "c2c-residue"));
  if (residue.length > 0) throw new Canary2cError("C2C_RESIDUE", residue.map((r) => String(r.id)).join(", ").slice(0, 300));

  const baseline = oneRow(await read(SQL_P9_BASELINE_COUNTS, [], "c2c-baseline-before"), "c2c-baseline-before");

  // ------------------------------------------------------ run identities
  const w1 = deps.runIds?.w1 ?? randomUUID();
  const w2 = deps.runIds?.w2 ?? randomUUID();
  const wsName = (ws: string) => `${P9_VALIDATION_MARKER_PREFIX} ${ws}`;
  const ids = {
    agentA: randomUUID(),
    agentB: randomUUID(),
    agentC: randomUUID(),
    agentD: randomUUID(),
    r1: randomUUID(),
    r2: randomUUID(),
    r3: randomUUID(),
    rb: randomUUID(),
    userId: randomUUID(),
  };
  const agent = (id: string, ws: string, name: string, blob: string | null = null): AgentArg => ({ id, workspace_id: ws, name, knowledge_base: blob });

  const checks: ValidationCheck[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  let cleanupOk = true;
  let cleanupDetail: string | undefined;
  let mutated = false;

  // Leg B instrumentation: count loader calls and capture everything logged.
  let loaderCalls = 0;
  const countedLoader: CentralKnowledgeLoader = async (ws, agentId) => {
    loaderCalls += 1;
    return deps.loader(ws, agentId);
  };
  const capturedLogs: string[] = [];
  const withCapturedLogs = async <T>(fn: () => Promise<T>): Promise<T> => {
    const orig = console.log;
    console.log = (...a: unknown[]) => {
      capturedLogs.push(a.map(String).join(" "));
    };
    try {
      return await fn();
    } finally {
      console.log = orig;
    }
  };

  const hashes = {
    violet: c2cHash(FX_VIOLET.content),
    amber: c2cHash(FX_AMBER.content),
    citrineV1: c2cHash(FX_CITRINE.content),
    citrineV2: c2cHash(CITRINE_V2_CONTENT),
    indigo: c2cHash(FX_INDIGO.content),
  };
  const chunksViolet = c2cChunks(FX_VIOLET, FX_VIOLET.content);
  const chunksCitrineV1 = c2cChunks(FX_CITRINE, FX_CITRINE.content);
  const chunksCitrineV2 = c2cChunks(FX_CITRINE, CITRINE_V2_CONTENT);
  const chunksIndigo = c2cChunks(FX_INDIGO, FX_INDIGO.content);

  const applyChanges = async (ws: string, resourceId: string, changes: readonly Row[], context: string): Promise<Row> =>
    asJson(oneRow(await mutate(P9_SQL_APPLY_DOCUMENT_CHANGES, [ws, resourceId, ids.userId, JSON.stringify(changes)], context), context).result);
  const reindex = async (ws: string, documentId: string, hash: string, chunks: readonly KnowledgeChunk[], context: string): Promise<Row> =>
    asJson(oneRow(await mutate(P9_SQL_REINDEX_DOCUMENT, [ws, documentId, hash, JSON.stringify(chunks)], context), context).result);
  const matchA = async (ws: string, agentId: string, query: string, context: string): Promise<{ universe: number; matches: Row[] }> => {
    const result = asJson(oneRow(await mutate(P9_SQL_MATCH_CHUNKS, [ws, agentId, query], context), context).result);
    return { universe: asInt(result.searched_chunks), matches: rowsOf(result.matches) };
  };

  /** Insert one ready document into a resource and return its id. */
  const insertDocument = async (ws: string, resourceId: string, fx: C2cResourceFixture, content: string, hash: string, context: string): Promise<string> => {
    const inserted = await applyChanges(
      ws,
      resourceId,
      [{ op: "insert", kind: "file", source_url: null, filename: fx.filename, mime: "text/plain", content, content_hash: hash, fetched_at: null, status: "ready", error: null, position: 0 }],
      context,
    );
    const id = String(rowsOf(inserted.results)[0]?.id ?? "");
    if (inserted.changed !== true || !UUID_RE.test(id)) throw new Canary2cError("C2C_SETUP_FAILED", `${context}: no document id`);
    return id;
  };

  try {
    // ---------------------------------------------------- fixtures
    mutated = true;
    await mutate(P9_SQL_CREATE_WORKSPACE, [w1, wsName(w1)], "setup-w1-workspace");
    await mutate(P9_SQL_CREATE_WORKSPACE, [w2, wsName(w2)], "setup-w2-workspace");
    await mutate(P9_SQL_CREATE_RESOURCE, [ids.r1, w1, FX_VIOLET.name], "setup-r1");
    await mutate(P9_SQL_CREATE_RESOURCE, [ids.r2, w1, FX_AMBER.name], "setup-r2");
    await mutate(P9_SQL_CREATE_RESOURCE, [ids.r3, w1, FX_CITRINE.name], "setup-r3");
    await mutate(P9_SQL_CREATE_RESOURCE, [ids.rb, w2, FX_INDIGO.name], "setup-rb");
    await mutate(P9_SQL_CREATE_AGENT, [ids.agentA, w1, "Canary 2C agent A"], "setup-agent-a");
    await mutate(P9_SQL_CREATE_AGENT, [ids.agentC, w1, "Canary 2C agent C"], "setup-agent-c");
    await mutate(P9_SQL_CREATE_AGENT, [ids.agentD, w1, "Canary 2C agent D"], "setup-agent-d");
    await mutate(P9_SQL_CREATE_AGENT, [ids.agentB, w2, "Canary 2C agent B"], "setup-agent-b");
    await mutate(P9_SQL_CREATE_ASSIGNMENT, [w1, ids.agentA, ids.r1], "setup-assign-a-r1");
    await mutate(P9_SQL_CREATE_ASSIGNMENT, [w1, ids.agentA, ids.r3], "setup-assign-a-r3");
    await mutate(P9_SQL_CREATE_ASSIGNMENT, [w1, ids.agentC, ids.r3], "setup-assign-c-r3");
    await mutate(P9_SQL_CREATE_ASSIGNMENT, [w2, ids.agentB, ids.rb], "setup-assign-b-rb");
    const d1 = await insertDocument(w1, ids.r1, FX_VIOLET, FX_VIOLET.content, hashes.violet, "setup-d1");
    const d2 = await insertDocument(w1, ids.r2, FX_AMBER, FX_AMBER.content, hashes.amber, "setup-d2");
    const d3 = await insertDocument(w1, ids.r3, FX_CITRINE, FX_CITRINE.content, hashes.citrineV1, "setup-d3");
    const db = await insertDocument(w2, ids.rb, FX_INDIGO, FX_INDIGO.content, hashes.indigo, "setup-db");
    for (const [doc, hash, chunks, ctx] of [
      [d1, hashes.violet, chunksViolet, "setup-index-d1"],
      [d2, hashes.amber, c2cChunks(FX_AMBER, FX_AMBER.content), "setup-index-d2"],
      [d3, hashes.citrineV1, chunksCitrineV1, "setup-index-d3"],
    ] as const) {
      const r = await reindex(w1, doc, hash, chunks, ctx);
      if (r.replaced !== true) throw new Canary2cError("C2C_SETUP_FAILED", ctx);
    }
    const rb = await reindex(w2, db, hashes.indigo, chunksIndigo, "setup-index-db");
    if (rb.replaced !== true) throw new Canary2cError("C2C_SETUP_FAILED", "setup-index-db");
    add("setup: two workspaces, four agents, four resources, four indexed documents", true);
    add("setup: fixtures chunk to multiple rows", chunksViolet.length >= 2 && chunksCitrineV1.length >= 2, `violet=${chunksViolet.length} citrine=${chunksCitrineV1.length}`);

    const agentA = agent(ids.agentA, w1, "Canary 2C agent A", C2C_LEGACY_BLOB);
    const agentB = agent(ids.agentB, w2, "Canary 2C agent B");
    const agentC = agent(ids.agentC, w1, "Canary 2C agent C", C2C_LEGACY_BLOB);
    const agentD = agent(ids.agentD, w1, "Canary 2C agent D", C2C_LEGACY_BLOB);
    const universeA = chunksViolet.length + chunksCitrineV1.length;

    // ------------------------------------------- (2) Leg A: correct matches + SQL semantics
    const fts = deps.app.ftsQuery([`what does ${C2C_TOKEN_W1} cost`]);
    add("2: ftsQueryFor emits OR-joined terms including the probe token", fts.includes(C2C_TOKEN_W1) && / OR /.test(fts), fts.slice(0, 80));
    const a2 = await matchA(w1, ids.agentA, fts, "test-2-match");
    add("2: searched_chunks equals the authoritative universe (assigned + ready + hash-current)", a2.universe === universeA, `searched=${a2.universe} expected=${universeA}`);
    add("2: the probe query matches at least one chunk, all from the violet document", a2.matches.length >= 1 && a2.matches.every((m) => String(m.document_id) === d1), `matches=${a2.matches.length}`);
    const orCase = await matchA(w1, ids.agentA, `${C2C_TOKEN_W1} OR ${C2C_ABSENT_TOKEN}`, "test-2-or-upper");
    add("2: uppercase OR folds to the websearch or-operator (matches survive an absent term)", orCase.matches.length >= 1, `matches=${orCase.matches.length}`);
    const andCase = await matchA(w1, ids.agentA, `${C2C_TOKEN_W1} ${C2C_ABSENT_TOKEN}`, "test-2-and");
    add("2: plain adjacency ANDs terms (sanity: absent term kills the match)", andCase.matches.length === 0, `matches=${andCase.matches.length}`);

    // ------------------------------------------- Leg B block (captured logs)
    await withCapturedLogs(async () => {
      // (1) authorized retrieval through the REAL ladder
      const r1 = await deps.app.searchCore(agentA, { query: C2C_TOKEN_W1 }, "canary-2c", countedLoader, deps.matcher);
      add("1: searchKnowledgeCore answers from the live chunk index", r1.success === true && r1.found === true && r1.sourceMode === "central-chunks");
      add("1: the answer carries the violet content and never the legacy blob", r1.text.includes(C2C_TOKEN_W1) && !r1.text.includes("canarylegacyretrieval"));
      add("8: Leg B source attribution carries the resource/document label", (r1.sources[0]?.source ?? "").startsWith(c2cLabel(FX_VIOLET)), r1.sources[0]?.source);

      // (3) genuine zero-match: no fallback, no loader call
      const before3 = loaderCalls;
      const r3 = await deps.app.searchCore(agentA, { query: C2C_ABSENT_TOKEN }, "canary-2c", countedLoader, deps.matcher);
      add("3: a live index with zero matches is a genuine no-match", r3.success === true && r3.found === false && r3.sourceMode === "central-chunks" && r3.text === "");
      add("3: zero-match never broadens retrieval (document loader not consulted)", loaderCalls === before3);

      // (5) unassigned exclusion
      const r5 = await deps.app.searchCore(agentA, { query: C2C_TOKEN_UNASSIGNED }, "canary-2c", countedLoader, deps.matcher);
      add("5: an unassigned resource's content is unreachable (honest no-match instead)", r5.found === false && !r5.text.includes(C2C_TOKEN_UNASSIGNED));

      // (4) cross-workspace isolation
      const r4 = await deps.app.searchCore(agentA, { query: C2C_TOKEN_W2 }, "canary-2c", countedLoader, deps.matcher);
      add("4: another workspace's content is unreachable through the ladder", !r4.text.includes(C2C_TOKEN_W2));
      const r4b = await deps.app.searchCore(agentB, { query: C2C_TOKEN_W2 }, "canary-2c", countedLoader, deps.matcher);
      add("4: the owning workspace's agent retrieves the same content normally", r4b.found === true && r4b.text.includes(C2C_TOKEN_W2) && r4b.sourceMode === "central-chunks");

      // Reply-path parity + legacy agent
      const reply = await deps.app.replyRetrieval(agentA, [{ role: "user", content: `how much does ${C2C_TOKEN_W1} cost?` }], "canary-2c", countedLoader, deps.matcher);
      add("1: centralRetrievalForReply answers from chunks for text channels", reply !== null && reply.sourceMode === "central-chunks" && reply.retrieval.text.includes(C2C_TOKEN_W1));
      const legacyReply = await deps.app.replyRetrieval(agentD, [{ role: "user", content: "anything" }], "canary-2c", countedLoader, deps.matcher);
      add("7: an unassigned (legacy) agent gets null — callers keep the legacy path byte-for-byte", legacyReply === null);
      const legacyCore = await deps.app.searchCore(agentD, { query: "canarylegacyretrieval" }, "canary-2c", countedLoader, deps.matcher);
      add("7: the legacy agent's blob still answers through the unchanged legacy mode", legacyCore.sourceMode === "legacy" && legacyCore.found === true);
    });

    // ------------------------------------------- (6) stale-hash exclusion
    const replaced = await applyChanges(w1, ids.r3, [{ op: "replace", id: d3, mime: "text/plain", content: CITRINE_V2_CONTENT, content_hash: hashes.citrineV2, fetched_at: null, status: "ready", error: null, optional: false }], "test-6-replace");
    add("6: citrine document moved to V2 without a reindex", replaced.changed === true);
    const stale = await matchA(w1, ids.agentA, deps.app.ftsQuery([C2C_TOKEN_STALE_V1]), "test-6-stale-match");
    add("6: stale chunks leave the universe the moment the hash moves", stale.universe === chunksViolet.length && stale.matches.length === 0, `searched=${stale.universe} expected=${chunksViolet.length}`);

    // ------------------------------------------- (7) fallback when no usable index exists
    await withCapturedLogs(async () => {
      const r7 = await deps.app.searchCore(agentC, { query: C2C_TOKEN_STALE_V2 }, "canary-2c", countedLoader, deps.matcher);
      add("7: universe 0 falls back to the assigned-document path and reads the CURRENT content", r7.sourceMode === "central" && r7.found === true && r7.text.includes(C2C_TOKEN_STALE_V2));
      add("7: the fallback never swaps to the legacy blob for an assigned agent", !r7.text.includes("canarylegacyretrieval"));
    });

    // ------------------------------------------- (6b) recovery: reindex restores the universe
    const rec = await reindex(w1, d3, hashes.citrineV2, chunksCitrineV2, "test-6-recovery-reindex");
    add("6: V2 reindex accepted", rec.replaced === true && asInt(rec.chunks) === chunksCitrineV2.length);
    const recovered = await matchA(w1, ids.agentC, deps.app.ftsQuery([C2C_TOKEN_STALE_V2]), "test-6-recovery-match");
    add("6: the reindexed document re-enters the universe with matches", recovered.universe === chunksCitrineV2.length && recovered.matches.length >= 1);
    // (8) Leg A attribution on the recovered rows
    add("8: Leg A source_label equals the committed chunker's label", recovered.matches.every((m) => String(m.source_label) === c2cLabel(FX_CITRINE)));

    // ------------------------------------------- (9) log hygiene
    const leakTokens = [C2C_TOKEN_W1, C2C_TOKEN_UNASSIGNED, C2C_TOKEN_STALE_V1, C2C_TOKEN_STALE_V2, C2C_TOKEN_W2, "canarylegacyretrieval", FX_VIOLET.content.slice(0, 40)];
    const leaks = capturedLogs.filter((line) => leakTokens.some((t) => line.includes(t)));
    add("9: no captured retrieval log line carries knowledge content or probe tokens", leaks.length === 0, `lines=${capturedLogs.length} leaks=${leaks.length}`);
  } catch (e) {
    add("validation sequence completed without transport error", false, safeMessage(e));
  } finally {
    if (mutated) {
      try {
        for (const [ws, label] of [[w1, "w1"], [w2, "w2"]] as const) {
          await mutate(P9_SQL_CLEANUP_WORKSPACE, [ws, wsName(ws)], `cleanup-${label}-workspace`);
          const absent = oneRow(await read(SQL_P9_VERIFY_RUN_ABSENT, [ws], `cleanup-${label}-absent`), `cleanup-${label}-absent`);
          const left = BASELINE_TABLES.filter((t) => asInt(absent[t]) !== 0);
          add(`cleanup: ${label} rows absent (cascades covered agents, assignments, resources, documents, chunks)`, left.length === 0, left.join(", ") || undefined);
          if (left.length > 0) {
            cleanupOk = false;
            cleanupDetail = cleanupDetail ?? `${label} rows remain in: ${left.join(", ")}`;
          }
        }
        const after = oneRow(await read(SQL_P9_BASELINE_COUNTS, [], "c2c-baseline-after"), "c2c-baseline-after");
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

  const logLeaks = checks.find((c) => c.name.startsWith("9:"))?.ok === false ? 1 : 0;
  return { ok: cleanupOk && checks.every((c) => c.ok), target: CANARY_PROJECT_REF, checks, cleanupOk, cleanupDetail, runIds: { w1, w2 }, logLeaks };
}
