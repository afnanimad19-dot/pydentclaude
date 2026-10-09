// Central Knowledge Base — server orchestration (Phase A4).
//
// Each operation takes the AUTHENTICATED workspace (from the session, via
// knowledge-route.ts) and an injected store (knowledge-server.ts in
// production, an in-memory fake in tests). Business rules come from the pure
// A2 module (lib/knowledge.ts); text extraction and website import are the
// approved A3 libraries, injected so tests never touch a parser or the network.
//
// Isolation: every store call is scoped by the session workspace, and an id that
// isn't in that workspace is indistinguishable from one that doesn't exist (404).
// No client-supplied workspace, owner, version or status is ever accepted.
//
// content_version: incremented ONCE per API operation that changed the
// resource's effective knowledge (upload/replace, URL add/refresh with changes,
// document delete). Unchanged content and failures never increment it.
//
// Atomicity (A4.1): every operation that changes documents makes exactly ONE
// store call — applyDocumentChanges, or duplicateResource — which the
// database runs as a single transaction (0065 functions). The document write
// and the content_version increment can never be separated, and the version is
// computed by the database (content_version + 1 under the resource row lock),
// never by this module.
//
// Chunk indexing (Phase 2B): AFTER a successful changed ready-document write
// (upload insert/replace, URL add, refresh replace) the document is chunked
// (lib/knowledge-chunker.ts, pure) and handed to the store's reindexDocument
// (knowledge_reindex_document, migration 0068). Indexing is ADDITIVE and sits
// OUTSIDE the A4.1 atomicity contract: the database function does its own
// locking + stale-hash rejection, retrieval only ever joins chunks on
// chunk.content_hash = document.content_hash, and an indexing failure NEVER
// fails the ingestion response. Unchanged/kept/error writes, deletes (FK
// cascade removes chunks), duplicates and historical documents are not indexed
// here — backfill is Phase 2C.
//
// Logging: none here. Nothing in this module logs knowledge content.

import {
  canAddDocument,
  copyName,
  normalizeSourceUrl,
  planDelete,
  planDuplicate,
  planFileUpload,
  planUrlIngest,
  planUrlRefresh,
  validateNewResource,
  validateResourceStatus,
  validateResourceType,
  validateResourceUpdate,
  type ContentAttempt,
  type DocumentRecord,
  type DocumentWrite,
  type IngestPlan,
  type ResourceRecord,
  type ResourceType,
  type ResourceStatus,
  type DocumentStatus,
  type RefreshIntervalHours,
} from "@/lib/knowledge";
import { chunkDocumentContent, chunkSourceLabel, type KnowledgeChunk } from "@/lib/knowledge-chunker";

// ------------------------------------------------------------------ store contract

export interface ResourceRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  type: ResourceType;
  status: ResourceStatus;
  refresh_enabled: boolean;
  refresh_interval_hours: RefreshIntervalHours | null;
  next_refresh_at: string | null;
  last_refreshed_at: string | null;
  last_error: string | null;
  content_version: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentRow {
  id: string;
  workspace_id: string;
  resource_id: string;
  kind: ResourceType;
  source_url: string | null;
  filename: string | null;
  mime: string | null;
  content: string;
  content_hash: string | null;
  char_count: number;
  fetched_at: string | null;
  status: DocumentStatus;
  error: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface AssignmentRow {
  resource_id: string;
  agent_id: string;
  agent_name: string;
}

/** One agent of the session workspace (the assignment picker's rows). */
export interface WorkspaceAgentRow {
  id: string;
  name: string;
  kind: string | null;
}

export type ResourceInsert = Pick<ResourceRow, "name" | "description" | "type" | "status" | "refresh_enabled" | "refresh_interval_hours" | "created_by" | "updated_by">;
/** Metadata edits only — status and content_version are owned by the database functions. */
export type ResourcePatchRow = Partial<Pick<ResourceRow, "name" | "description" | "refresh_enabled" | "refresh_interval_hours" | "updated_by">>;
export type DocumentInsert = Pick<DocumentRow, "kind" | "source_url" | "filename" | "mime" | "content" | "content_hash" | "fetched_at" | "status" | "error" | "position">;
export type DocumentReplace = Pick<DocumentRow, "mime" | "content" | "content_hash" | "fetched_at" | "status" | "error">;

/** One document change inside an atomic operation (knowledge_apply_document_changes). */
export type DocumentChange =
  | { op: "insert"; doc: DocumentInsert }
  | { op: "replace"; id: string; doc: DocumentReplace; optional?: boolean }
  | { op: "touch"; id: string; fetched_at?: string | null; error?: string | null; optional?: boolean }
  | { op: "delete"; id: string; optional?: boolean };

/** Resource fields written in the same transaction (only keys present are written). */
export type ResourceMeta = { last_error?: string | null; last_refreshed_at?: string | null };

export type ChangeResult = { op: DocumentChange["op"]; id: string | null; applied: boolean };
export type ApplyResult =
  | { row: ResourceRow; changed: boolean; results: ChangeResult[] }
  | { notFound: "resource" | "document" }
  | { limit: true }
  | { conflict: true };
export type DuplicateResult = { row: ResourceRow; documents: number } | { notFound: true } | { conflict: "name" };
/**
 * knowledge_reindex_document outcome (Phase 2B). "replaced" = the chunk set was
 * swapped; "stale_input" = the document's content changed since the chunks were
 * built — the database wrote NOTHING (the newer content's own write indexes
 * itself); "not_found" = no such document in this workspace; "unavailable" =
 * migration 0068 isn't installed (ingestion proceeds without chunks);
 * "error" = any other failure (logged by the store, never thrown to ingestion).
 */
export type ReindexResult =
  | { outcome: "replaced"; chunks: number }
  | { outcome: "stale_input" }
  | { outcome: "not_found" }
  | { outcome: "unavailable" }
  | { outcome: "error" };

/** Every method is scoped by `ws`; rows of another workspace are never returned or touched. */
export interface KnowledgeStore {
  listResources(ws: string): Promise<ResourceRow[]>;
  getResource(ws: string, id: string): Promise<ResourceRow | null>;
  insertResource(ws: string, row: ResourceInsert): Promise<{ row: ResourceRow } | { conflict: "name" }>;
  /** Metadata only (name, description, refresh settings). null = not found. */
  updateResource(ws: string, id: string, patch: ResourcePatchRow): Promise<{ row: ResourceRow } | { conflict: "name" } | null>;
  /** "assigned" when the database refuses (NO ACTION foreign key). */
  deleteResource(ws: string, id: string): Promise<"deleted" | "not_found" | "assigned">;
  listDocuments(ws: string, resourceId: string, opts: { withContent: boolean }): Promise<DocumentRow[]>;
  /** char_count of every document in the workspace, for list summaries. */
  listDocumentStats(ws: string): Promise<{ resource_id: string; char_count: number }[]>;
  /**
   * ATOMIC: apply all `changes` to one resource, re-derive its status, write
   * `meta`, and increment content_version once if knowledge changed — one
   * transaction; on any failure nothing is written.
   */
  applyDocumentChanges(ws: string, resourceId: string, userId: string, changes: DocumentChange[], meta: ResourceMeta): Promise<ApplyResult>;
  /** ATOMIC: copy a resource and all its documents under `name`; assignments are not copied. */
  duplicateResource(ws: string, sourceId: string, name: string, userId: string): Promise<DuplicateResult>;
  /** Assignments (with agent names) for the given resources, or the whole workspace. */
  listAssignments(ws: string, resourceIds?: string[]): Promise<AssignmentRow[]>;
  /** The workspace's agents, for the assignment picker. */
  listWorkspaceAgents(ws: string): Promise<WorkspaceAgentRow[]>;
  /** One agent of the workspace, or null — another workspace's agent is indistinguishable from a missing one. */
  getWorkspaceAgent(ws: string, agentId: string): Promise<WorkspaceAgentRow | null>;
  /**
   * Link an agent to a resource (agent_knowledge_resources, position appended
   * per agent). "exists" = already linked (idempotent); "refused" = the
   * database vetoed it (workspace trigger / composite foreign key).
   */
  insertAssignment(ws: string, agentId: string, resourceId: string): Promise<"inserted" | "exists" | "refused">;
  deleteAssignment(ws: string, agentId: string, resourceId: string): Promise<"deleted" | "not_found">;
  /**
   * Replace one document's chunk set via knowledge_reindex_document (0068).
   * The database derives ownership/hash/version from the LOCKED document row
   * and rejects stale input itself — callers add no locking and no retries.
   * Implementations map failures to an outcome where possible; the service
   * treats a throw as "error" too (indexing never fails ingestion).
   */
  reindexDocument(ws: string, documentId: string, contentHash: string, chunks: readonly KnowledgeChunk[]): Promise<ReindexResult>;
}

/** Thrown by the store when migration 0065 isn't installed. */
export class KnowledgeMigrationMissing extends Error {
  constructor() {
    super("The Central Knowledge Base isn't installed yet (migration 0065).");
    this.name = "KnowledgeMigrationMissing";
  }
}

// ------------------------------------------------------------------ results

export type Outcome = { status: number; body: Record<string, unknown> };

const ok = (body: Record<string, unknown>, status = 200): Outcome => ({ status, body: { ok: true, ...body } });
const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Outcome => ({
  status,
  body: { ok: false, code, error, ...extra },
});
const notFound = (what: "resource" | "document" = "resource"): Outcome =>
  fail(404, `${what}_not_found`, what === "resource" ? "Knowledge resource not found." : "Document not found in this resource.");

/** HTTP status for an A2 validation / plan code. */
export function statusForCode(code: string): number {
  if (code === "name_taken" || code === "resource_assigned") return 409;
  if (code === "document_limit" || code === "content_too_large" || code === "upload_too_large") return 413;
  return 400;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_PREVIEW_CHARS = 300;
/** Fields the server owns: a request that tries to set them is refused. */
const SERVER_OWNED = ["id", "workspace_id", "workspaceId", "ws", "created_by", "updated_by", "createdBy", "updatedBy", "content_version", "contentVersion", "status", "created_at", "updated_at", "createdAt", "updatedAt", "last_refreshed_at", "lastRefreshedAt", "last_error", "lastError", "next_refresh_at"];

function serverOwnedField(body: Record<string, unknown>): string | null {
  return SERVER_OWNED.find((k) => k in body) ?? null;
}

function asBody(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

// ------------------------------------------------------------------ mapping

function toResourceRecord(r: ResourceRow): ResourceRecord {
  return { id: r.id, name: r.name, description: r.description, type: r.type, refreshEnabled: r.refresh_enabled, refreshIntervalHours: r.refresh_interval_hours };
}

function toDocumentRecord(d: DocumentRow): DocumentRecord {
  return { id: d.id, resourceId: d.resource_id, kind: d.kind, filename: d.filename, sourceUrl: d.source_url, mime: d.mime, content: d.content ?? "", contentHash: d.content_hash, position: d.position, status: d.status };
}

function resourceView(r: ResourceRow, stats: { count: number; chars: number }, agents: { id: string; name: string }[]) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    type: r.type,
    status: r.status,
    contentVersion: r.content_version,
    documentCount: stats.count,
    charCount: stats.chars,
    assignedAgentCount: agents.length,
    assignedAgents: agents,
    refreshEnabled: r.refresh_enabled,
    refreshIntervalHours: r.refresh_interval_hours,
    lastRefreshedAt: r.last_refreshed_at,
    nextRefreshAt: r.next_refresh_at,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function documentView(d: DocumentRow) {
  return {
    id: d.id,
    kind: d.kind,
    filename: d.filename,
    sourceUrl: d.source_url,
    mime: d.mime,
    chars: d.char_count,
    status: d.status,
    error: d.error,
    position: d.position,
    fetchedAt: d.fetched_at,
    updatedAt: d.updated_at,
    preview: (d.content ?? "").slice(0, DOCUMENT_PREVIEW_CHARS),
  };
}

function agentsByResource(rows: AssignmentRow[]): Map<string, { id: string; name: string }[]> {
  const m = new Map<string, { id: string; name: string }[]>();
  for (const a of rows) {
    const list = m.get(a.resource_id) ?? [];
    if (!list.some((x) => x.id === a.agent_id)) list.push({ id: a.agent_id, name: a.agent_name || "Unnamed agent" });
    m.set(a.resource_id, list);
  }
  for (const list of m.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return m;
}

async function loadResource(store: KnowledgeStore, ws: string, id: string): Promise<ResourceRow | null> {
  if (!UUID_RE.test(String(id ?? ""))) return null;
  return store.getResource(ws, id);
}

// ------------------------------------------------------------------ list / detail

export async function listResources(store: KnowledgeStore, ws: string, query: { q?: string | null; type?: string | null; status?: string | null }): Promise<Outcome> {
  const type = query.type ? validateResourceType(query.type) : null;
  if (type && !type.ok) return fail(400, "type_invalid", "Unknown resource type filter.");
  const status = query.status ? validateResourceStatus(query.status) : null;
  if (status && !status.ok) return fail(400, "status_invalid", "Unknown resource status filter.");
  const q = String(query.q ?? "").trim().toLowerCase().slice(0, 200);
  const [resources, stats, assignments] = await Promise.all([store.listResources(ws), store.listDocumentStats(ws), store.listAssignments(ws)]);
  const statMap = new Map<string, { count: number; chars: number }>();
  for (const s of stats) {
    const v = statMap.get(s.resource_id) ?? { count: 0, chars: 0 };
    v.count++;
    v.chars += s.char_count;
    statMap.set(s.resource_id, v);
  }
  const agents = agentsByResource(assignments);
  const list = resources
    .filter((r) => (!type || r.type === type.value) && (!status || r.status === status.value))
    .filter((r) => !q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
    .map((r) => resourceView(r, statMap.get(r.id) ?? { count: 0, chars: 0 }, agents.get(r.id) ?? []));
  return ok({ resources: list });
}

export async function getResourceDetail(store: KnowledgeStore, ws: string, id: string): Promise<Outcome> {
  const r = await loadResource(store, ws, id);
  if (!r) return notFound();
  const [docs, assignments] = await Promise.all([store.listDocuments(ws, r.id, { withContent: true }), store.listAssignments(ws, [r.id])]);
  const agents = agentsByResource(assignments).get(r.id) ?? [];
  const sorted = docs.slice().sort((a, b) => a.position - b.position);
  return ok({
    resource: resourceView(r, { count: docs.length, chars: docs.reduce((n, d) => n + d.char_count, 0) }, agents),
    documents: sorted.map(documentView),
    assignedAgents: agents,
  });
}

// ------------------------------------------------------------------ create / update / delete

export async function createResource(store: KnowledgeStore, ws: string, userId: string, raw: unknown): Promise<Outcome> {
  const body = asBody(raw);
  if (!body) return fail(400, "invalid_body", "Send a JSON object.");
  const owned = serverOwnedField(body);
  if (owned) return fail(400, "field_not_allowed", `"${owned}" is set by the server and can't be supplied.`);
  const existing = await store.listResources(ws);
  const v = validateNewResource(
    { name: body.name, description: body.description, type: body.type, refreshEnabled: body.refreshEnabled, refreshIntervalHours: body.refreshIntervalHours },
    existing.map((r) => r.name)
  );
  if (!v.ok) return fail(statusForCode(v.code), v.code, v.message, v.field ? { field: v.field } : {});
  const res = await store.insertResource(ws, {
    name: v.value.name,
    description: v.value.description,
    type: v.value.type,
    status: "empty",
    refresh_enabled: v.value.refreshEnabled,
    refresh_interval_hours: v.value.refreshIntervalHours,
    created_by: userId,
    updated_by: userId,
  });
  if ("conflict" in res) return fail(409, "name_taken", `A knowledge resource called "${v.value.name}" already exists.`, { field: "name" });
  return ok({ resource: resourceView(res.row, { count: 0, chars: 0 }, []) }, 201);
}

export async function updateResource(store: KnowledgeStore, ws: string, userId: string, id: string, raw: unknown): Promise<Outcome> {
  const body = asBody(raw);
  if (!body) return fail(400, "invalid_body", "Send a JSON object.");
  const r = await loadResource(store, ws, id);
  if (!r) return notFound();
  const owned = serverOwnedField(body);
  if (owned) return fail(400, "field_not_allowed", `"${owned}" is set by the server and can't be supplied.`);
  const others = (await store.listResources(ws)).map((x) => x.name);
  const v = validateResourceUpdate(
    toResourceRecord(r),
    { name: body.name, description: body.description, type: body.type, refreshEnabled: body.refreshEnabled, refreshIntervalHours: body.refreshIntervalHours },
    others
  );
  if (!v.ok) return fail(statusForCode(v.code), v.code, v.message, v.field ? { field: v.field } : {});
  const patch: ResourcePatchRow = { updated_by: userId };
  if (v.value.name !== undefined) patch.name = v.value.name;
  if (v.value.description !== undefined) patch.description = v.value.description;
  if (v.value.refreshEnabled !== undefined) patch.refresh_enabled = v.value.refreshEnabled;
  if (v.value.refreshIntervalHours !== undefined) patch.refresh_interval_hours = v.value.refreshIntervalHours;
  const res = await store.updateResource(ws, r.id, patch);
  if (res === null) return notFound();
  if ("conflict" in res) return fail(409, "name_taken", "Another knowledge resource already has that name.", { field: "name" });
  return getResourceDetail(store, ws, r.id);
}

export async function deleteResource(store: KnowledgeStore, ws: string, id: string): Promise<Outcome> {
  const r = await loadResource(store, ws, id);
  if (!r) return notFound();
  const blocked = async (): Promise<Outcome> => {
    const assignments = await store.listAssignments(ws, [r.id]);
    const p = planDelete(assignments.map((a) => ({ agentId: a.agent_id, agentName: a.agent_name })));
    if (p.allowed) return fail(409, "resource_assigned", "This knowledge resource is assigned to an agent. Unassign it first.", { agents: [], count: 0 });
    return fail(409, p.code, p.message, { agents: p.agents, count: p.count });
  };
  const assignments = await store.listAssignments(ws, [r.id]);
  if (assignments.length) return blocked();
  const res = await store.deleteResource(ws, r.id);
  if (res === "not_found") return notFound();
  // The database's NO ACTION foreign key is the final word (an assignment raced in).
  if (res === "assigned") return blocked();
  return ok({ deleted: true, resourceId: r.id });
}

/**
 * Duplicate: A2 plans the collision-safe name; the database copies the
 * resource and ALL its documents (new ids, same order, no assignments) in one
 * transaction. If another resource takes the name meanwhile, the name is
 * re-planned (a few attempts) — never a partial copy.
 */
export async function duplicateResource(store: KnowledgeStore, ws: string, userId: string, id: string): Promise<Outcome> {
  const r = await loadResource(store, ws, id);
  if (!r) return notFound();
  for (let attempt = 0; attempt < 3; attempt++) {
    // Content stays in the database: the plan needs names and order only.
    const [docs, all] = await Promise.all([store.listDocuments(ws, r.id, { withContent: false }), store.listResources(ws)]);
    const plan = planDuplicate({ source: toResourceRecord(r), documents: docs.map(toDocumentRecord), existingNames: all.map((x) => x.name) });
    if (!plan.ok) return fail(statusForCode(plan.code), plan.code, plan.message);
    const res = await store.duplicateResource(ws, r.id, plan.value.resource.name, userId);
    if ("notFound" in res) return notFound();
    if ("conflict" in res) continue;
    const detail = await getResourceDetail(store, ws, res.row.id);
    if (detail.status !== 200) return detail;
    return { status: 201, body: { ...detail.body, duplicatedFrom: r.id, copiedDocuments: res.documents } };
  }
  return fail(409, "name_taken", "Couldn't find a free name for the copy. Rename a copy and try again.");
}

// ------------------------------------------------------------------ ingestion

export type ExtractFn = (input: { buf: Buffer; name: string; mime: string }) => Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }>;
export type ImportSiteFn = (url: string) => Promise<{ ok: true; text: string } | { ok: false; status: number; error: string; code?: string }>;

function writeToInsert(w: DocumentWrite, fetchedAt: string | null): DocumentInsert {
  return { kind: w.kind, source_url: w.sourceUrl, filename: w.filename, mime: w.mime, content: w.content, content_hash: w.contentHash, fetched_at: fetchedAt, status: w.status, error: w.error, position: w.position };
}

function writeToReplace(w: DocumentWrite, fetchedAt: string | null): DocumentReplace {
  return { mime: w.mime, content: w.content, content_hash: w.contentHash, fetched_at: fetchedAt, status: w.status, error: null };
}

type PlannedOutcome = "inserted" | "replaced" | "unchanged" | "kept";

/**
 * Translate one A2 ingestion plan into the document change to persist (none
 * for an unchanged upload). keep_existing only records the error — the last
 * good content is never touched. A reject is returned as its error.
 */
function planToChange(plan: IngestPlan, nowIso: string, fetched: boolean, optional = false): { change: DocumentChange | null; outcome: PlannedOutcome; truncated: boolean } | { error: Outcome } {
  const fetchedAt = fetched ? nowIso : null;
  switch (plan.action) {
    case "insert":
      return { change: { op: "insert", doc: writeToInsert(plan.write, fetchedAt) }, outcome: "inserted", truncated: plan.write.truncated };
    case "replace":
      return { change: { op: "replace", id: plan.documentId, doc: writeToReplace(plan.write, fetchedAt), optional }, outcome: "replaced", truncated: plan.write.truncated };
    case "unchanged":
      return { change: fetched ? { op: "touch", id: plan.documentId, fetched_at: nowIso, error: null, optional } : null, outcome: "unchanged", truncated: false };
    case "keep_existing":
      return { change: { op: "touch", id: plan.documentId, error: plan.error.slice(0, 500), optional }, outcome: "kept", truncated: false };
    case "reject":
      return { error: fail(statusForCode(plan.code), plan.code, plan.message) };
  }
}

/**
 * Phase 2B: chunk the content a successful apply just persisted and hand the
 * set to knowledge_reindex_document. The content/hash pair comes from the
 * ingestion PLAN — the exact bytes the atomic write stored — so the database's
 * hash check can only reject it when a NEWER write raced in (correct: that
 * write indexes its own content). Additive by contract: any outcome or throw
 * is absorbed — the committed document write is never failed by indexing, and
 * stale/absent chunks are excluded from retrieval by the hash join anyway.
 */
async function indexDocumentChunks(store: KnowledgeStore, ws: string, resourceName: string, documentId: string, write: DocumentWrite): Promise<void> {
  try {
    const chunks = chunkDocumentContent({
      content: write.content,
      sourceLabel: chunkSourceLabel(resourceName, { filename: write.filename, sourceUrl: write.sourceUrl }),
    });
    await store.reindexDocument(ws, documentId, write.contentHash, chunks);
  } catch {
    // Outcome logging is the store's job; the next content write or the
    // Phase 2C backfill re-indexes this document.
  }
}

/** HTTP outcome for an atomic write the database refused (nothing was written). */
function applyFailure(res: ApplyResult): Outcome | null {
  if ("row" in res) return null;
  if ("limit" in res) return fail(413, "document_limit", "A knowledge resource can hold at most 50 documents.");
  if ("conflict" in res) return fail(409, "document_conflict", "A document with that name or address was added at the same time. Try again.");
  return res.notFound === "document" ? notFound("document") : notFound();
}

const resourceSummary = (r: ResourceRow) => ({ id: r.id, status: r.status, contentVersion: r.content_version });

export async function uploadFile(
  store: KnowledgeStore,
  ws: string,
  userId: string,
  id: string,
  file: { buf: Buffer; name: string; mime: string } | null,
  extract: ExtractFn,
  now: () => Date
): Promise<Outcome> {
  const r = await loadResource(store, ws, id);
  if (!r) return notFound();
  if (r.type !== "file") return fail(400, "type_mismatch", "Files can only be added to a File resource.");
  if (!file) return fail(400, "file_required", "No file received.");
  if (file.buf.length > MAX_UPLOAD_BYTES) return fail(413, "upload_too_large", "That file is too large to import (10 MB maximum).");
  const docs = (await store.listDocuments(ws, r.id, { withContent: false })).map(toDocumentRecord);
  const x = await extract(file);
  const extraction: ContentAttempt = x.ok ? { ok: true, content: x.text } : { ok: false, error: x.error };
  const plan = await planFileUpload({ resourceType: r.type, documents: docs, filename: file.name, mime: file.mime, extraction });
  const step = planToChange(plan, now().toISOString(), false);
  if ("error" in step) {
    // Failed extraction of a NEW file: the extractor's own status (415/422/…) and message.
    if (plan.action === "reject" && plan.code === "extraction_failed" && !x.ok) return fail(x.status >= 400 && x.status < 600 ? x.status : 422, "extraction_failed", x.error);
    return step.error;
  }
  const res = await store.applyDocumentChanges(ws, r.id, userId, step.change ? [step.change] : [], {});
  const refused = applyFailure(res);
  if (refused || !("row" in res)) return refused ?? notFound();
  const documentId = plan.action === "insert" ? res.results[0]?.id ?? null : "documentId" in plan ? plan.documentId : null;
  if (step.outcome === "kept") {
    return fail(x.ok ? 422 : x.status >= 400 && x.status < 600 ? x.status : 422, "extraction_failed", `${x.ok ? "No readable text was found in that file." : x.error} The existing version was kept.`, { kept: true, documentId });
  }
  if ((plan.action === "insert" || plan.action === "replace") && documentId) await indexDocumentChunks(store, ws, r.name, documentId, plan.write);
  return ok({ action: step.outcome, documentId, truncated: step.truncated, resource: resourceSummary(res.row) }, step.outcome === "inserted" ? 201 : 200);
}

export async function addUrl(store: KnowledgeStore, ws: string, userId: string, id: string, raw: unknown, importSite: ImportSiteFn, now: () => Date): Promise<Outcome> {
  const body = asBody(raw);
  if (!body) return fail(400, "invalid_body", "Send a JSON object.");
  const r = await loadResource(store, ws, id);
  if (!r) return notFound();
  if (r.type !== "url") return fail(400, "type_mismatch", "URLs can only be added to a URL resource.");
  const owned = serverOwnedField(body);
  if (owned) return fail(400, "field_not_allowed", `"${owned}" is set by the server and can't be supplied.`);
  if ("content" in body || "text" in body) return fail(400, "field_not_allowed", "Page content is fetched by the server and can't be supplied.");
  const url = normalizeSourceUrl(body.url);
  if (!url) return fail(400, "source_url_required", "Enter a valid http(s) web address.");
  const docs = (await store.listDocuments(ws, r.id, { withContent: false })).map(toDocumentRecord);
  const existing = docs.find((d) => d.kind === "url" && d.sourceUrl !== null && normalizeSourceUrl(d.sourceUrl) === url);
  if (!existing) {
    const limit = canAddDocument(docs.length);
    if (!limit.ok) return fail(413, limit.code, limit.message);
  }
  // The A3 importer validates the address against the SSRF rules before any fetch.
  const site = await importSite(url);
  if (!site.ok && !existing) return fail(site.status >= 400 && site.status < 600 ? site.status : 502, site.code ?? "fetch_failed", site.error);
  const plan = await planUrlIngest({ resourceType: r.type, documents: docs, sourceUrl: url, fetch: site.ok ? { ok: true, content: site.text } : { ok: false, error: site.error } });
  const nowIso = now().toISOString();
  const step = planToChange(plan, nowIso, true);
  if ("error" in step) return step.error;
  const failure = site.ok ? "The page returned no readable text." : site.error;
  const meta: ResourceMeta = step.outcome === "kept" ? { last_error: failure.slice(0, 500) } : { last_refreshed_at: nowIso, last_error: null };
  const res = await store.applyDocumentChanges(ws, r.id, userId, step.change ? [step.change] : [], meta);
  const refused = applyFailure(res);
  if (refused || !("row" in res)) return refused ?? notFound();
  const documentId = plan.action === "insert" ? res.results[0]?.id ?? null : "documentId" in plan ? plan.documentId : null;
  if (step.outcome === "kept") {
    return fail(site.ok ? 422 : site.status >= 400 && site.status < 600 ? site.status : 502, site.ok ? "empty_content" : site.code ?? "fetch_failed", `${failure} The previous content was kept.`, { kept: true, documentId });
  }
  if ((plan.action === "insert" || plan.action === "replace") && documentId) await indexDocumentChunks(store, ws, r.name, documentId, plan.write);
  return ok({ action: step.outcome, documentId, truncated: step.truncated, resource: resourceSummary(res.row) }, step.outcome === "inserted" ? 201 : 200);
}

/**
 * Phase A manual refresh of every URL document in a resource (no scheduling).
 * Every address is fetched first; then ALL resulting changes are persisted in
 * ONE atomic call with ONE content_version increment (if anything changed).
 * A document removed by someone else meanwhile is skipped, not recreated.
 */
export async function refreshResource(
  store: KnowledgeStore,
  ws: string,
  userId: string,
  id: string,
  importSite: ImportSiteFn,
  now: () => Date,
  opts: { budgetMs?: number } = {}
): Promise<Outcome> {
  const r = await loadResource(store, ws, id);
  if (!r) return notFound();
  if (r.type !== "url") return fail(400, "type_mismatch", "Only URL resources can be refreshed.");
  const docs = (await store.listDocuments(ws, r.id, { withContent: false })).sort((a, b) => a.position - b.position);
  if (!docs.length) return fail(400, "nothing_to_refresh", "This resource has no web addresses yet.");
  const started = now().getTime();
  const budget = opts.budgetMs ?? 45_000;
  const results: { documentId: string; sourceUrl: string | null; outcome: string; error?: string }[] = [];
  const changes: DocumentChange[] = [];
  const changeIndex: number[] = []; // results[i] ↔ changes[changeIndex[i]] (or -1)
  const changeWrites: (DocumentWrite | null)[] = []; // per change: the ready content a replace persisted (Phase 2B indexing input)
  for (const d of docs) {
    if (now().getTime() - started > budget) {
      results.push({ documentId: d.id, sourceUrl: d.source_url, outcome: "skipped", error: "Not refreshed: time limit reached. Refresh again to continue." });
      changeIndex.push(-1);
      continue;
    }
    // The SSRF check runs again on every refresh, inside the A3 importer.
    const site = await importSite(String(d.source_url ?? ""));
    const plan = await planUrlRefresh({ document: toDocumentRecord(d), fetch: site.ok ? { ok: true, content: site.text } : { ok: false, error: site.error } });
    const step = planToChange(plan, now().toISOString(), true, true);
    if ("error" in step || step.outcome === "kept") {
      const err = site.ok ? "The page returned no readable text." : site.error;
      results.push({ documentId: d.id, sourceUrl: d.source_url, outcome: "kept_previous", error: err });
    } else {
      results.push({ documentId: d.id, sourceUrl: d.source_url, outcome: step.outcome });
    }
    if (!("error" in step) && step.change) {
      changeIndex.push(changes.length);
      changes.push(step.change);
      changeWrites.push(plan.action === "replace" ? plan.write : null);
    } else changeIndex.push(-1);
  }
  const failedCount = () => results.filter((x) => x.outcome === "kept_previous" || x.outcome === "skipped").length;
  const succeeded = () => results.filter((x) => x.outcome === "replaced" || x.outcome === "unchanged").length;
  const firstError = () => {
    const first = results.find((x) => x.outcome === "kept_previous" || x.outcome === "skipped");
    return first?.outcome === "skipped" ? "Time limit reached before every address was refreshed." : first?.error ?? "";
  };
  const summary = (): ResourceMeta => {
    const meta: ResourceMeta = {
      last_error: failedCount() ? `${failedCount()} of ${results.length} address${results.length === 1 ? "" : "es"} could not be refreshed: ${firstError()}`.slice(0, 500) : null,
    };
    if (succeeded() > 0) meta.last_refreshed_at = now().toISOString();
    return meta;
  };
  const res = await store.applyDocumentChanges(ws, r.id, userId, changes, summary());
  const refused = applyFailure(res);
  if (refused || !("row" in res)) return refused ?? notFound();
  // A document deleted while the pages were being fetched: reported, nothing recreated.
  results.forEach((x, i) => {
    const ci = changeIndex[i];
    if (ci >= 0 && res.results[ci] && !res.results[ci].applied) {
      x.outcome = "removed";
      x.error = "This address was removed while the refresh was running.";
    }
  });
  // Phase 2B: index exactly the documents this refresh REPLACED (unchanged,
  // kept and removed-meanwhile entries are skipped) with each plan's own
  // content/hash pair — the bytes the single atomic apply just persisted.
  for (let ci = 0; ci < changes.length; ci++) {
    const write = changeWrites[ci];
    const c = changes[ci];
    if (write && c.op === "replace" && res.results[ci]?.applied) {
      await indexDocumentChunks(store, ws, r.name, c.id, write);
    }
  }
  return ok({
    refreshed: succeeded(),
    failed: failedCount(),
    changed: res.changed,
    results,
    resource: { ...resourceSummary(res.row), lastRefreshedAt: res.row.last_refreshed_at, lastError: res.row.last_error },
  });
}

export async function deleteDocument(store: KnowledgeStore, ws: string, userId: string, id: string, docId: string): Promise<Outcome> {
  const r = await loadResource(store, ws, id);
  if (!r) return notFound();
  if (!UUID_RE.test(String(docId ?? ""))) return notFound("document");
  // The database checks the document belongs to this resource AND workspace.
  const res = await store.applyDocumentChanges(ws, r.id, userId, [{ op: "delete", id: docId }], {});
  const refused = applyFailure(res);
  if (refused || !("row" in res)) return refused ?? notFound();
  return ok({ deleted: true, documentId: docId, resource: resourceSummary(res.row) });
}

// ------------------------------------------------------------------ agent assignment (Phase 1A)
//
// Activates the 0065 link table (agent_knowledge_resources) for operators.
// Assignment changes NEVER touch the resource row: content_version and status
// describe the knowledge itself, which an assignment does not change. Nothing
// in the agent runtime reads these links yet (that is Phase 1B).

const workspaceAgentView = (a: WorkspaceAgentRow) => ({ id: a.id, name: a.name || "Unnamed agent", kind: a.kind });

/** The resource's assigned agents plus the workspace's other agents (the picker). */
export async function listResourceAgents(store: KnowledgeStore, ws: string, id: string): Promise<Outcome> {
  const r = await loadResource(store, ws, id);
  if (!r) return notFound();
  const [assignments, agents] = await Promise.all([store.listAssignments(ws, [r.id]), store.listWorkspaceAgents(ws)]);
  const assigned = agentsByResource(assignments).get(r.id) ?? [];
  const assignedIds = new Set(assigned.map((a) => a.id));
  const available = agents
    .filter((a) => !assignedIds.has(a.id))
    .map(workspaceAgentView)
    .sort((a, b) => a.name.localeCompare(b.name));
  return ok({ resourceId: r.id, assignedAgents: assigned, availableAgents: available });
}

export async function assignAgent(store: KnowledgeStore, ws: string, id: string, raw: unknown): Promise<Outcome> {
  const body = asBody(raw);
  if (!body) return fail(400, "invalid_body", "Send a JSON object.");
  const owned = serverOwnedField(body);
  if (owned) return fail(400, "field_not_allowed", `"${owned}" is set by the server and can't be supplied.`);
  const r = await loadResource(store, ws, id);
  if (!r) return notFound();
  const agentId = String(body.agentId ?? "").trim();
  // A malformed id, a missing agent and another workspace's agent all read the same.
  const agent = UUID_RE.test(agentId) ? await store.getWorkspaceAgent(ws, agentId) : null;
  if (!agent) return fail(404, "agent_not_found", "No such agent in this workspace.");
  const res = await store.insertAssignment(ws, agent.id, r.id);
  // The database's workspace trigger / composite FK is the final word.
  if (res === "refused") return fail(409, "assignment_refused", "The assignment was refused. Reload and try again.");
  return ok(
    { assigned: true, resourceId: r.id, agent: { id: agent.id, name: agent.name || "Unnamed agent" }, alreadyAssigned: res === "exists" },
    res === "inserted" ? 201 : 200
  );
}

export async function unassignAgent(store: KnowledgeStore, ws: string, id: string, agentId: string): Promise<Outcome> {
  const r = await loadResource(store, ws, id);
  if (!r) return notFound();
  const aid = String(agentId ?? "").trim();
  if (!UUID_RE.test(aid)) return fail(404, "assignment_not_found", "That agent isn't assigned to this resource.");
  const res = await store.deleteAssignment(ws, aid, r.id);
  if (res === "not_found") return fail(404, "assignment_not_found", "That agent isn't assigned to this resource.");
  return ok({ unassigned: true, resourceId: r.id, agentId: aid });
}

export { copyName };
