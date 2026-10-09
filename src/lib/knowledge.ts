// Central Knowledge Base — pure domain logic (Phase A).
//
// No database, Supabase, HTTP, UI, network or agent-runtime dependency: every
// function takes plain data and returns a validation result or a PLAN that the
// server layer (later) persists. The rules mirror migration 0065 exactly, so the
// application refuses what the database would refuse — with a clear message —
// before any write is attempted.
//
// Knowledge vs. behavior: nothing here touches agent Prompt Configuration
// (identity, instructions, behavior, first message) or the voice/chat runtime.
// The Tester preparation below reuses the SAME pure retrieval primitives the
// agents use (lib/kb-retrieval.ts: splitSources / chunkSource / rankChunks) —
// there is no second ranking algorithm.

import { chunkSource, rankChunks, splitSources } from "@/lib/kb-retrieval";

// ------------------------------------------------------------------ constants

export const KNOWLEDGE_MANAGER_ROLES: readonly string[] = ["owner", "manager"];
export const RESOURCE_TYPES = ["file", "url"] as const;
export const RESOURCE_STATUSES = ["empty", "processing", "ready", "error"] as const;
export const DOCUMENT_STATUSES = ["processing", "ready", "error"] as const;
export const REFRESH_INTERVAL_HOURS = [6, 12, 24, 168] as const;

export const MAX_RESOURCE_NAME = 80;
export const MAX_DESCRIPTION = 1000;
export const MAX_FILENAME = 255;
export const MAX_SOURCE_URL = 2048;
export const MAX_DOCUMENTS_PER_RESOURCE = 50;
export const MAX_DOCUMENT_CHARS = 200_000;
export const TESTER_MAX_CONTEXT_CHARS = 12_000;
export const TESTER_TOP_K = 8;
export const TESTER_PREVIEW_CHARS = 200;
export const MAX_QUESTION_CHARS = 1000;

// ------------------------------------------------------------------ types

export type ResourceType = (typeof RESOURCE_TYPES)[number];
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];
export type DocumentKind = ResourceType;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];
export type RefreshIntervalHours = (typeof REFRESH_INTERVAL_HOURS)[number];

export type Invalid = { ok: false; code: string; message: string; field?: string };
export type Valid<T> = { ok: true; value: T };
export type Validation<T> = Valid<T> | Invalid;

export interface RefreshSettings {
  refreshEnabled: boolean;
  refreshIntervalHours: RefreshIntervalHours | null;
}

export interface ResourceDraft extends RefreshSettings {
  name: string;
  description: string;
  type: ResourceType;
}

export interface ResourceInput {
  name?: unknown;
  description?: unknown;
  type?: unknown;
  refreshEnabled?: unknown;
  refreshIntervalHours?: unknown;
}

export interface ResourcePatch {
  name?: string;
  description?: string;
  refreshEnabled?: boolean;
  refreshIntervalHours?: RefreshIntervalHours | null;
}

/** The parts of a stored resource the rules need. */
export interface ResourceRecord extends RefreshSettings {
  id: string;
  name: string;
  description: string;
  type: ResourceType;
}

export interface DocumentInput {
  kind?: unknown;
  filename?: unknown;
  sourceUrl?: unknown;
  mime?: unknown;
  content?: unknown;
  position?: unknown;
}

export interface DocumentDraft {
  kind: DocumentKind;
  filename: string | null;
  sourceUrl: string | null;
  mime: string | null;
  content: string;
  position: number;
}

/** The parts of a stored document the rules need. */
export interface DocumentRecord {
  id: string;
  resourceId: string;
  kind: DocumentKind;
  filename: string | null;
  sourceUrl: string | null;
  mime?: string | null;
  content: string;
  contentHash: string | null;
  position: number;
  status: DocumentStatus;
}

/** Result of reading a file or fetching a URL (done elsewhere — never here). */
export type ContentAttempt = { ok: true; content: string } | { ok: false; error: string };

const invalid = (code: string, message: string, field?: string): Invalid => ({ ok: false, code, message, ...(field ? { field } : {}) });
const valid = <T>(value: T): Valid<T> => ({ ok: true, value });

// ------------------------------------------------------------------ names & resource validation

/** Trim + collapse inner whitespace; required, max 80 characters, printable. */
export function normalizeResourceName(raw: unknown): Validation<string> {
  if (typeof raw !== "string") return invalid("name_required", "Enter a name for the knowledge resource.", "name");
  if (/[\u0000-\u001f\u007f]/.test(raw)) return invalid("name_invalid", "The name contains invalid characters.", "name");
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) return invalid("name_required", "Enter a name for the knowledge resource.", "name");
  if (name.length > MAX_RESOURCE_NAME) return invalid("name_too_long", `Keep the name to ${MAX_RESOURCE_NAME} characters or fewer.`, "name");
  return valid(name);
}

/** The key the database uniqueness index uses: lower(btrim(name)). */
export function nameKey(name: string): string {
  return String(name ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function isNameTaken(name: string, existingNames: readonly string[], exceptName?: string): boolean {
  const key = nameKey(name);
  const except = exceptName === undefined ? null : nameKey(exceptName);
  return existingNames.some((n) => {
    const k = nameKey(n);
    return k === key && k !== except;
  });
}

function normalizeDescription(raw: unknown): Validation<string> {
  if (raw === undefined || raw === null) return valid("");
  if (typeof raw !== "string") return invalid("description_invalid", "The description must be text.", "description");
  const d = raw.trim();
  if (d.length > MAX_DESCRIPTION) return invalid("description_too_long", `Keep the description to ${MAX_DESCRIPTION} characters or fewer.`, "description");
  return valid(d);
}

export function isResourceType(v: unknown): v is ResourceType {
  return typeof v === "string" && (RESOURCE_TYPES as readonly string[]).includes(v);
}

export function validateResourceType(raw: unknown): Validation<ResourceType> {
  return isResourceType(raw) ? valid(raw) : invalid("type_invalid", "Choose a resource type: File or URL.", "type");
}

export function validateResourceStatus(raw: unknown): Validation<ResourceStatus> {
  return typeof raw === "string" && (RESOURCE_STATUSES as readonly string[]).includes(raw)
    ? valid(raw as ResourceStatus)
    : invalid("status_invalid", "Unknown resource status.", "status");
}

export function validateDocumentStatus(raw: unknown): Validation<DocumentStatus> {
  return typeof raw === "string" && (DOCUMENT_STATUSES as readonly string[]).includes(raw)
    ? valid(raw as DocumentStatus)
    : invalid("status_invalid", "Unknown document status.", "status");
}

/**
 * Refresh settings: only URL resources refresh; an interval, when given, is one
 * of 6 / 12 / 24 / 168 hours; enabling refresh requires an interval.
 */
export function validateRefreshSettings(type: ResourceType, enabled: unknown, interval: unknown): Validation<RefreshSettings> {
  if (enabled !== undefined && enabled !== null && typeof enabled !== "boolean") {
    return invalid("refresh_invalid", "Automatic refresh must be on or off.", "refreshEnabled");
  }
  const on = enabled === true;
  let hours: RefreshIntervalHours | null = null;
  if (interval !== undefined && interval !== null && interval !== "") {
    const n = typeof interval === "number" ? interval : typeof interval === "string" && /^\d+$/.test(interval.trim()) ? Number(interval) : NaN;
    if (!(REFRESH_INTERVAL_HOURS as readonly number[]).includes(n)) {
      return invalid("refresh_interval_invalid", "Refresh interval must be 6, 12, 24 or 168 hours.", "refreshIntervalHours");
    }
    hours = n as RefreshIntervalHours;
  }
  if (type !== "url" && (on || hours !== null)) {
    return invalid("refresh_not_supported", "Only URL resources can be refreshed.", "refreshEnabled");
  }
  if (on && hours === null) return invalid("refresh_interval_required", "Choose how often to refresh.", "refreshIntervalHours");
  return valid({ refreshEnabled: on, refreshIntervalHours: hours });
}

/** Validate a new resource. Unsupported types are refused, never coerced. */
export function validateNewResource(input: ResourceInput, existingNames: readonly string[] = []): Validation<ResourceDraft> {
  const name = normalizeResourceName(input.name);
  if (!name.ok) return name;
  if (isNameTaken(name.value, existingNames)) return invalid("name_taken", `A knowledge resource called "${name.value}" already exists.`, "name");
  const type = validateResourceType(input.type);
  if (!type.ok) return type;
  const description = normalizeDescription(input.description);
  if (!description.ok) return description;
  const refresh = validateRefreshSettings(type.value, input.refreshEnabled, input.refreshIntervalHours);
  if (!refresh.ok) return refresh;
  return valid({ name: name.value, description: description.value, type: type.value, ...refresh.value });
}

/**
 * Validate an update. The type is immutable (documents are bound to it, as
 * in the database); only provided fields are changed.
 */
export function validateResourceUpdate(existing: ResourceRecord, input: ResourceInput, existingNames: readonly string[] = []): Validation<ResourcePatch> {
  if (input.type !== undefined && input.type !== existing.type) {
    return invalid("type_immutable", "A resource's type can't be changed. Create a new resource instead.", "type");
  }
  const patch: ResourcePatch = {};
  if (input.name !== undefined) {
    const name = normalizeResourceName(input.name);
    if (!name.ok) return name;
    if (isNameTaken(name.value, existingNames, existing.name)) return invalid("name_taken", `A knowledge resource called "${name.value}" already exists.`, "name");
    patch.name = name.value;
  }
  if (input.description !== undefined) {
    const d = normalizeDescription(input.description);
    if (!d.ok) return d;
    patch.description = d.value;
  }
  if (input.refreshEnabled !== undefined || input.refreshIntervalHours !== undefined) {
    const refresh = validateRefreshSettings(
      existing.type,
      input.refreshEnabled !== undefined ? input.refreshEnabled : existing.refreshEnabled,
      input.refreshIntervalHours !== undefined ? input.refreshIntervalHours : existing.refreshIntervalHours
    );
    if (!refresh.ok) return refresh;
    patch.refreshEnabled = refresh.value.refreshEnabled;
    patch.refreshIntervalHours = refresh.value.refreshIntervalHours;
  }
  return valid(patch);
}

// ------------------------------------------------------------------ document validation

function cleanFilename(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const f = raw.trim();
  if (!f || f.length > MAX_FILENAME || /[\u0000-\u001f\u007f]/.test(f)) return null;
  return f;
}

/** Canonical http(s) URL string, or null. (Shape only — SSRF checks happen at fetch time.) */
export function normalizeSourceUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > MAX_SOURCE_URL) return null;
  // Another scheme (ftp://, javascript:, data:, file:, mailto: …) is refused —
  // never "fixed" by prefixing https://.
  if (!/^https?:\/\//i.test(s) && (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(javascript|data|file|mailto|vbscript|blob|about):/i.test(s))) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Validate one document for a resource of `resourceType`. Mirrors 0065: the
 * kind must equal the resource type; a file has a filename and no URL; a URL
 * has a source URL and no filename; content ≤ 200,000 characters; position ≥ 0.
 */
export function validateDocument(input: DocumentInput, resourceType: ResourceType): Validation<DocumentDraft> {
  if (input.kind !== "file" && input.kind !== "url") return invalid("kind_invalid", "Unknown document kind.", "kind");
  const kind = input.kind;
  if (kind !== resourceType) {
    return invalid("type_mismatch", kind === "file" ? "Files can only be added to a File resource." : "URLs can only be added to a URL resource.", "kind");
  }
  let filename: string | null = null;
  let sourceUrl: string | null = null;
  if (kind === "file") {
    if (input.sourceUrl !== undefined && input.sourceUrl !== null && input.sourceUrl !== "") {
      return invalid("type_mismatch", "A file document can't carry a source URL.", "sourceUrl");
    }
    filename = cleanFilename(input.filename);
    if (!filename) return invalid("filename_required", "A file document needs a valid filename.", "filename");
  } else {
    if (input.filename !== undefined && input.filename !== null && input.filename !== "") {
      return invalid("type_mismatch", "A URL document can't carry a filename.", "filename");
    }
    sourceUrl = normalizeSourceUrl(input.sourceUrl);
    if (!sourceUrl) return invalid("source_url_required", "A URL document needs a valid http(s) address.", "sourceUrl");
  }
  if (typeof input.content !== "string") return invalid("content_invalid", "Document content must be text.", "content");
  if (input.content.length > MAX_DOCUMENT_CHARS) {
    return invalid("content_too_large", `A document can hold at most ${MAX_DOCUMENT_CHARS.toLocaleString("en-US")} characters.`, "content");
  }
  let position = 0;
  if (input.position !== undefined && input.position !== null) {
    if (typeof input.position !== "number" || !Number.isInteger(input.position) || input.position < 0) {
      return invalid("position_invalid", "Position must be a whole number of 0 or more.", "position");
    }
    position = input.position;
  }
  const mime = typeof input.mime === "string" && input.mime.trim() ? input.mime.trim().slice(0, 200) : null;
  return valid({ kind, filename, sourceUrl, mime, content: input.content, position });
}

/** The 50-documents-per-resource limit (the database enforces it too). */
export function canAddDocument(existingCount: number): Validation<{ remaining: number }> {
  if (existingCount >= MAX_DOCUMENTS_PER_RESOURCE) {
    return invalid("document_limit", `A knowledge resource can hold at most ${MAX_DOCUMENTS_PER_RESOURCE} documents.`);
  }
  return valid({ remaining: MAX_DOCUMENTS_PER_RESOURCE - existingCount - 1 });
}

/** Extracted/fetched text clipped to the document limit (the legacy importers clip the same way). */
export function clipContent(text: string): { content: string; truncated: boolean } {
  const s = String(text ?? "");
  return s.length > MAX_DOCUMENT_CHARS ? { content: s.slice(0, MAX_DOCUMENT_CHARS), truncated: true } : { content: s, truncated: false };
}

/** Next free position at the end of a resource. */
export function nextPosition(docs: readonly Pick<DocumentRecord, "position">[]): number {
  return docs.reduce((max, d) => Math.max(max, d.position + 1), 0);
}

// ------------------------------------------------------------------ hashing

/**
 * SHA-256 (hex) of the exact content — Web Crypto, available in Node and in
 * browsers, so no extra dependency. Identical text → identical hash.
 */
export async function contentHash(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(String(content ?? ""));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function sameContent(hashA: string | null | undefined, hashB: string | null | undefined): boolean {
  return !!hashA && !!hashB && hashA === hashB;
}

// ------------------------------------------------------------------ ingestion plans

/** Fields the server writes for a new or replaced document. */
export interface DocumentWrite {
  kind: DocumentKind;
  filename: string | null;
  sourceUrl: string | null;
  mime: string | null;
  content: string;
  contentHash: string;
  status: "ready";
  error: null;
  position: number;
  truncated: boolean;
}

export type IngestPlan =
  | { action: "insert"; write: DocumentWrite; bumpVersion: true }
  | { action: "replace"; documentId: string; write: DocumentWrite; bumpVersion: true }
  | { action: "unchanged"; documentId: string; bumpVersion: false }
  | { action: "keep_existing"; documentId: string; error: string; bumpVersion: false }
  | { action: "reject"; code: string; message: string; bumpVersion: false };

/** Existing file document with the same name (case-insensitive, trimmed). */
export function findFileDocument(docs: readonly DocumentRecord[], filename: string): DocumentRecord | null {
  const key = nameKey(filename);
  return docs.find((d) => d.kind === "file" && d.filename !== null && nameKey(d.filename) === key) ?? null;
}

/** Existing URL document for the same address (canonical comparison). */
export function findUrlDocument(docs: readonly DocumentRecord[], sourceUrl: string): DocumentRecord | null {
  const key = normalizeSourceUrl(sourceUrl);
  if (!key) return null;
  return docs.find((d) => d.kind === "url" && d.sourceUrl !== null && normalizeSourceUrl(d.sourceUrl) === key) ?? null;
}

/**
 * Plan an upload into a File resource. A same-named file (case-insensitive)
 * REPLACES the existing document and keeps its id; identical content is a
 * no-op; a failed extraction never touches existing content.
 */
export async function planFileUpload(input: {
  resourceType: ResourceType;
  documents: readonly DocumentRecord[];
  filename: unknown;
  mime?: unknown;
  extraction: ContentAttempt;
}): Promise<IngestPlan> {
  if (input.resourceType !== "file") return { action: "reject", code: "type_mismatch", message: "Files can only be added to a File resource.", bumpVersion: false };
  const filename = cleanFilename(input.filename);
  if (!filename) return { action: "reject", code: "filename_required", message: "A file document needs a valid filename.", bumpVersion: false };
  const existing = findFileDocument(input.documents, filename);
  if (!input.extraction.ok) {
    return existing
      ? { action: "keep_existing", documentId: existing.id, error: input.extraction.error, bumpVersion: false }
      : { action: "reject", code: "extraction_failed", message: input.extraction.error, bumpVersion: false };
  }
  if (!input.extraction.content.trim()) {
    const msg = "No readable text was found in that file.";
    return existing ? { action: "keep_existing", documentId: existing.id, error: msg, bumpVersion: false } : { action: "reject", code: "empty_content", message: msg, bumpVersion: false };
  }
  const { content, truncated } = clipContent(input.extraction.content);
  const hash = await contentHash(content);
  const mime = typeof input.mime === "string" && input.mime.trim() ? input.mime.trim().slice(0, 200) : null;
  if (existing) {
    if (sameContent(existing.contentHash, hash)) return { action: "unchanged", documentId: existing.id, bumpVersion: false };
    // Replace in place: same id, same position; the stored name keeps its original casing.
    const write: DocumentWrite = { kind: "file", filename: existing.filename ?? filename, sourceUrl: null, mime, content, contentHash: hash, status: "ready", error: null, position: existing.position, truncated };
    return { action: "replace", documentId: existing.id, write, bumpVersion: true };
  }
  const limit = canAddDocument(input.documents.length);
  if (!limit.ok) return { action: "reject", code: limit.code, message: limit.message, bumpVersion: false };
  const write: DocumentWrite = { kind: "file", filename, sourceUrl: null, mime, content, contentHash: hash, status: "ready", error: null, position: nextPosition(input.documents), truncated };
  return { action: "insert", write, bumpVersion: true };
}

/**
 * Plan adding a URL to a URL resource (or re-fetching one already in it):
 * one document per URL holding the combined crawl. Changed content replaces it
 * in place; unchanged content is a no-op; a failed fetch keeps the last good
 * content.
 */
export async function planUrlIngest(input: {
  resourceType: ResourceType;
  documents: readonly DocumentRecord[];
  sourceUrl: unknown;
  fetch: ContentAttempt;
}): Promise<IngestPlan> {
  if (input.resourceType !== "url") return { action: "reject", code: "type_mismatch", message: "URLs can only be added to a URL resource.", bumpVersion: false };
  const sourceUrl = normalizeSourceUrl(input.sourceUrl);
  if (!sourceUrl) return { action: "reject", code: "source_url_required", message: "A URL document needs a valid http(s) address.", bumpVersion: false };
  const existing = findUrlDocument(input.documents, sourceUrl);
  if (existing) return planUrlRefresh({ document: existing, fetch: input.fetch });
  if (!input.fetch.ok) return { action: "reject", code: "fetch_failed", message: input.fetch.error, bumpVersion: false };
  if (!input.fetch.content.trim()) return { action: "reject", code: "empty_content", message: "No readable text was found at that address.", bumpVersion: false };
  const limit = canAddDocument(input.documents.length);
  if (!limit.ok) return { action: "reject", code: limit.code, message: limit.message, bumpVersion: false };
  const { content, truncated } = clipContent(input.fetch.content);
  const write: DocumentWrite = { kind: "url", filename: null, sourceUrl, mime: "text/plain", content, contentHash: await contentHash(content), status: "ready", error: null, position: nextPosition(input.documents), truncated };
  return { action: "insert", write, bumpVersion: true };
}

/** Plan a refresh of ONE existing URL document. Never destroys the previous good content. */
export async function planUrlRefresh(input: { document: DocumentRecord; fetch: ContentAttempt }): Promise<IngestPlan> {
  const doc = input.document;
  if (doc.kind !== "url" || !doc.sourceUrl) return { action: "reject", code: "type_mismatch", message: "Only URL documents can be refreshed.", bumpVersion: false };
  if (!input.fetch.ok) return { action: "keep_existing", documentId: doc.id, error: input.fetch.error, bumpVersion: false };
  if (!input.fetch.content.trim()) return { action: "keep_existing", documentId: doc.id, error: "The page returned no readable text.", bumpVersion: false };
  const { content, truncated } = clipContent(input.fetch.content);
  const hash = await contentHash(content);
  if (sameContent(doc.contentHash, hash)) return { action: "unchanged", documentId: doc.id, bumpVersion: false };
  const write: DocumentWrite = { kind: "url", filename: null, sourceUrl: doc.sourceUrl, mime: doc.mime ?? "text/plain", content, contentHash: hash, status: "ready", error: null, position: doc.position, truncated };
  return { action: "replace", documentId: doc.id, write, bumpVersion: true };
}

/** Resource status derived from its documents. */
export function deriveResourceStatus(docs: readonly Pick<DocumentRecord, "status">[]): ResourceStatus {
  if (!docs.length) return "empty";
  if (docs.some((d) => d.status === "processing")) return "processing";
  if (docs.some((d) => d.status === "ready")) return "ready";
  return "error";
}

// ------------------------------------------------------------------ duplicate

const COPY_SUFFIX = /\s+Copy(?:\s+(\d+))?$/i;

/**
 * Deterministic, collision-free copy name: "<base> Copy", then "<base> Copy 2",
 * "<base> Copy 3", … (case-insensitive against existing names). Duplicating a
 * copy continues the sequence of the original. The base is shortened when
 * needed so the result never exceeds 80 characters.
 */
export function copyName(sourceName: string, existingNames: readonly string[]): string {
  const base = String(sourceName ?? "").replace(/\s+/g, " ").trim().replace(COPY_SUFFIX, "").trim() || "Resource";
  const taken = new Set(existingNames.map(nameKey));
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? " Copy" : ` Copy ${n}`;
    const room = MAX_RESOURCE_NAME - suffix.length;
    const candidate = `${base.slice(0, room).trimEnd()}${suffix}`;
    if (!taken.has(nameKey(candidate))) return candidate;
  }
}

export interface DuplicateDocument {
  kind: DocumentKind;
  filename: string | null;
  sourceUrl: string | null;
  mime: string | null;
  content: string;
  /** Copied from the source; null when the source had none (persistence computes it). */
  contentHash: string | null;
  status: "ready";
  error: null;
  position: number;
}

export interface DuplicatePlan {
  resource: ResourceDraft;
  /** Documents to create under the NEW resource (new ids are assigned by persistence). */
  documents: DuplicateDocument[];
  /** Assignments are never copied: the copy starts unassigned. */
  assignments: [];
}

export function planDuplicate(input: {
  source: ResourceRecord;
  documents: readonly DocumentRecord[];
  existingNames: readonly string[];
}): Validation<DuplicatePlan> {
  const name = copyName(input.source.name, input.existingNames);
  const docs = input.documents
    .filter((d) => d.kind === input.source.type)
    .slice()
    .sort((a, b) => a.position - b.position)
    .slice(0, MAX_DOCUMENTS_PER_RESOURCE);
  const documents: DuplicateDocument[] = docs.map((d, i) => ({
    kind: d.kind,
    filename: d.filename,
    sourceUrl: d.sourceUrl,
    mime: d.mime ?? null,
    content: d.content,
    contentHash: d.contentHash ?? null,
    status: "ready" as const,
    error: null,
    position: i,
  }));
  for (const d of documents) {
    const check = validateDocument({ kind: d.kind, filename: d.filename, sourceUrl: d.sourceUrl, content: d.content, position: d.position }, input.source.type);
    if (!check.ok) return check;
  }
  return valid({
    resource: {
      name,
      description: input.source.description,
      type: input.source.type,
      refreshEnabled: input.source.refreshEnabled,
      refreshIntervalHours: input.source.refreshIntervalHours,
    },
    documents,
    assignments: [],
  });
}

// ------------------------------------------------------------------ delete

export interface AssignmentRef {
  agentId: string;
  agentName: string;
}

export type DeletePlan =
  | { allowed: true }
  | { allowed: false; code: "resource_assigned"; message: string; agents: AssignmentRef[]; count: number };

/** A resource assigned to any agent can't be deleted (the database refuses it too). */
export function planDelete(assignments: readonly AssignmentRef[]): DeletePlan {
  if (!assignments.length) return { allowed: true };
  const agents = [...new Map(assignments.map((a) => [a.agentId, { agentId: a.agentId, agentName: a.agentName || "Unnamed agent" }])).values()].sort((a, b) =>
    a.agentName.localeCompare(b.agentName)
  );
  const names = agents.map((a) => a.agentName);
  const list = names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
  return {
    allowed: false,
    code: "resource_assigned",
    message: `This knowledge resource is used by ${agents.length} agent${agents.length === 1 ? "" : "s"} (${list}). Unassign it from ${agents.length === 1 ? "that agent" : "those agents"} first.`,
    agents,
    count: agents.length,
  };
}

// ------------------------------------------------------------------ tester preparation

export interface TesterResource {
  id: string;
  name: string;
}

export interface TesterDocument {
  id: string;
  resourceId: string;
  kind: DocumentKind;
  filename: string | null;
  sourceUrl: string | null;
  content: string;
}

export interface TesterChunk {
  resourceId: string;
  resourceName: string;
  documentId: string;
  documentLabel: string;
  section: string;
  chunkIndex: number;
  score: number;
  chars: number;
  preview: string;
  text: string;
}

export interface TesterPreparation {
  question: string;
  chunks: TesterChunk[];
  context: string;
  contextChars: number;
  totalChunks: number;
  found: boolean;
}

export function documentLabel(d: Pick<TesterDocument, "kind" | "filename" | "sourceUrl">): string {
  return (d.kind === "file" ? d.filename : d.sourceUrl) || "Untitled document";
}

/**
 * Rank the selected resources' documents for a question — KB-only, no agent
 * prompt, no model call. Only documents whose resource is BOTH selected and
 * present in `resources` (the caller's workspace, loaded server-side) are
 * considered; an unknown selected id is refused. The best chunks are packed
 * into at most 12,000 characters of context.
 */
export function prepareTester(input: {
  question: unknown;
  selectedResourceIds: readonly string[];
  resources: readonly TesterResource[];
  documents: readonly TesterDocument[];
  maxContextChars?: number;
  topK?: number;
}): Validation<TesterPreparation> {
  const question = typeof input.question === "string" ? input.question.replace(/\s+/g, " ").trim() : "";
  if (!question) return invalid("question_required", "Ask a question to test the knowledge.", "question");
  if (question.length > MAX_QUESTION_CHARS) return invalid("question_too_long", `Keep the question to ${MAX_QUESTION_CHARS} characters or fewer.`, "question");
  const selected = [...new Set(input.selectedResourceIds.map(String))];
  if (!selected.length) return invalid("selection_required", "Select at least one knowledge resource to test.", "resourceIds");
  const byId = new Map(input.resources.map((r) => [r.id, r]));
  const unknown = selected.filter((id) => !byId.has(id));
  if (unknown.length) return invalid("resource_not_found", "One or more selected knowledge resources were not found.", "resourceIds");
  const allowed = new Set(selected);
  const maxContext = Math.max(0, Math.min(input.maxContextChars ?? TESTER_MAX_CONTEXT_CHARS, TESTER_MAX_CONTEXT_CHARS));
  const topK = input.topK ?? TESTER_TOP_K;

  // Chunk with the existing primitives. The KbChunk `source` is a private key
  // that maps each chunk back to its resource / document / section.
  const meta = new Map<string, { resource: TesterResource; doc: TesterDocument; section: string }>();
  const chunks: { source: string; id: number; text: string }[] = [];
  for (const doc of input.documents) {
    if (!allowed.has(doc.resourceId)) continue;
    const resource = byId.get(doc.resourceId);
    if (!resource) continue;
    const label = documentLabel(doc);
    const sections = splitSources(String(doc.content ?? ""));
    sections.forEach((s, si) => {
      const key = `${doc.id}#${si}`;
      meta.set(key, { resource, doc, section: s.name === "Knowledge base" ? label : s.name });
      for (const c of chunkSource(key, s.text)) chunks.push(c);
    });
  }
  const ranked = rankChunks(chunks, [question]);
  const picked: TesterChunk[] = [];
  let used = 0;
  for (const c of ranked) {
    if (picked.length >= topK || c.score <= 0) break;
    if (used + c.text.length > maxContext) continue;
    const m = meta.get(c.source);
    if (!m) continue;
    picked.push({
      resourceId: m.resource.id,
      resourceName: m.resource.name,
      documentId: m.doc.id,
      documentLabel: documentLabel(m.doc),
      section: m.section,
      chunkIndex: c.id,
      score: c.score,
      chars: c.text.length,
      preview: c.text.slice(0, TESTER_PREVIEW_CHARS),
      text: c.text,
    });
    used += c.text.length;
  }
  const context = picked.map((c, i) => `[${i + 1}] ${c.resourceName} · ${c.section}\n${c.text}`).join("\n\n");
  return valid({ question, chunks: picked, context, contextChars: used, totalChunks: chunks.length, found: picked.length > 0 });
}
