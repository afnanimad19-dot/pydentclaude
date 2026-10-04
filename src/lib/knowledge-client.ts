// Central Knowledge Base — browser API client (Phase A6).
//
// Every Central KB request from the browser goes through /api/knowledge/*
// with the signed-in user's token (authFetch). Nothing here talks to Supabase
// tables, and no request carries a workspace, owner, agent, model or prompt —
// the server derives the workspace from the session and owns every rule.
//
// Responses are returned as a typed result; errors keep the server's stable
// `code` (e.g. knowledge_migration_missing, forbidden_role, resource_assigned)
// so the UI can react without parsing messages.

export type ResourceType = "file" | "url";
export type ResourceStatus = "empty" | "processing" | "ready" | "error";
export type DocumentStatus = "processing" | "ready" | "error";

export interface AssignedAgent {
  id: string;
  name: string;
}

export interface KnowledgeResource {
  id: string;
  name: string;
  description: string;
  type: ResourceType;
  status: ResourceStatus;
  contentVersion: number;
  documentCount: number;
  charCount: number;
  assignedAgentCount: number;
  assignedAgents: AssignedAgent[];
  refreshEnabled: boolean;
  refreshIntervalHours: number | null;
  lastRefreshedAt: string | null;
  nextRefreshAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDocument {
  id: string;
  kind: ResourceType;
  filename: string | null;
  sourceUrl: string | null;
  mime: string | null;
  chars: number;
  status: DocumentStatus;
  error: string | null;
  position: number;
  fetchedAt: string | null;
  updatedAt: string;
  preview: string;
}

/** Server-derived capability of the signed-in member (UI hint; the server re-checks every change). */
export interface Viewer {
  canManage: boolean;
}

export interface ResourceDetail {
  resource: KnowledgeResource;
  documents: KnowledgeDocument[];
  assignedAgents: AssignedAgent[];
  /** Present on GET detail. */
  viewer?: Viewer;
}

export interface ResourceSummary {
  id: string;
  status: ResourceStatus;
  contentVersion: number;
}

export interface IngestResult {
  action: "inserted" | "replaced" | "unchanged";
  documentId: string | null;
  truncated: boolean;
  resource: ResourceSummary;
}

export interface RefreshResult {
  refreshed: number;
  failed: number;
  changed: boolean;
  results: { documentId: string; sourceUrl: string | null; outcome: "replaced" | "unchanged" | "kept_previous" | "skipped" | "removed"; error?: string }[];
  resource: ResourceSummary & { lastRefreshedAt: string | null; lastError: string | null };
}

export interface TesterChunk {
  rank: number;
  resourceId: string;
  resourceName: string;
  documentId: string;
  documentLabel: string;
  section: string;
  chunkIndex: number;
  score: number;
  chars: number;
  preview: string;
}

export interface TesterResult {
  question: string;
  answer: string | null;
  answerStatus: "answered" | "not_found" | "retrieval_only";
  generation: { status: "answered" | "skipped_no_match" | "unavailable" | "failed"; model: string | null; attemptedModel?: string; reason?: string };
  resources: { id: string; name: string; type: ResourceType; status: ResourceStatus; documentCount: number; searchedDocumentCount: number }[];
  chunks: TesterChunk[];
  retrieval: { documentsSearched: number; documentsSkipped: number; totalChunks: number; matchedChunks: number; contextChars: number; maxContextChars: number };
}

export type ApiError = { ok: false; status: number; code: string; error: string; body: Record<string, unknown> };
export type ApiResult<T> = { ok: true; status: number; data: T } | ApiError;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// The real authenticated fetch, loaded lazily so this module stays importable
// where the browser Supabase client isn't (tests inject their own fetch).
const defaultFetch: FetchLike = async (input, init) => (await import("@/lib/auth-fetch")).authFetch(input, init);

const BASE = "/api/knowledge";

async function call<T>(fetcher: FetchLike, url: string, init?: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetcher(url, init);
  } catch {
    return { ok: false, status: 0, code: "network_error", error: "Couldn't reach the server. Check your connection and try again.", body: {} };
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed = await res.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (res.ok && body.ok !== false) return { ok: true, status: res.status, data: body as T };
  return {
    ok: false,
    status: res.status,
    code: typeof body.code === "string" ? body.code : res.status === 401 ? "unauthenticated" : "request_failed",
    error: typeof body.error === "string" && body.error ? body.error : "Something went wrong. Try again.",
    body,
  };
}

const json = (method: string, payload?: unknown): RequestInit => ({ method, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
const seg = (id: string) => encodeURIComponent(id);

export interface ListFilters {
  q?: string;
  type?: ResourceType | "";
  status?: ResourceStatus | "";
}

/** The list URL for a set of filters (empty filters are omitted). */
export function listUrl(f: ListFilters = {}): string {
  const p = new URLSearchParams();
  const q = (f.q ?? "").trim();
  if (q) p.set("q", q);
  if (f.type) p.set("type", f.type);
  if (f.status) p.set("status", f.status);
  const s = p.toString();
  return `${BASE}/resources${s ? `?${s}` : ""}`;
}

export interface NewResourceInput {
  name: string;
  description: string;
  type: ResourceType;
}

export interface ResourceUpdateInput {
  name?: string;
  description?: string;
  refreshEnabled?: boolean;
  refreshIntervalHours?: number | null;
}

export function createKnowledgeClient(fetcher: FetchLike = defaultFetch) {
  return {
    list: (f: ListFilters = {}) => call<{ resources: KnowledgeResource[]; viewer?: Viewer }>(fetcher, listUrl(f)),
    detail: (id: string) => call<ResourceDetail>(fetcher, `${BASE}/resources/${seg(id)}`),
    create: (input: NewResourceInput) =>
      call<{ resource: KnowledgeResource }>(fetcher, `${BASE}/resources`, json("POST", { name: input.name, description: input.description, type: input.type })),
    update: (id: string, input: ResourceUpdateInput) => {
      // Only editable metadata — never type, status, version, owner or workspace.
      const body: ResourceUpdateInput = {};
      if (input.name !== undefined) body.name = input.name;
      if (input.description !== undefined) body.description = input.description;
      if (input.refreshEnabled !== undefined) body.refreshEnabled = input.refreshEnabled;
      if (input.refreshIntervalHours !== undefined) body.refreshIntervalHours = input.refreshIntervalHours;
      return call<ResourceDetail>(fetcher, `${BASE}/resources/${seg(id)}`, json("PATCH", body));
    },
    remove: (id: string) => call<{ deleted: true; resourceId: string }>(fetcher, `${BASE}/resources/${seg(id)}`, json("DELETE")),
    duplicate: (id: string) => call<ResourceDetail & { duplicatedFrom: string; copiedDocuments: number }>(fetcher, `${BASE}/resources/${seg(id)}/duplicate`, json("POST")),
    /** The file goes up as-is; extraction happens on the server only. */
    uploadFile: (id: string, file: File) => {
      const form = new FormData();
      form.append("file", file, file.name);
      return call<IngestResult>(fetcher, `${BASE}/resources/${seg(id)}/files`, { method: "POST", body: form });
    },
    /** Only the address is sent; the server fetches the page (SSRF-checked). */
    addUrl: (id: string, url: string) => call<IngestResult>(fetcher, `${BASE}/resources/${seg(id)}/urls`, json("POST", { url })),
    refresh: (id: string) => call<RefreshResult>(fetcher, `${BASE}/resources/${seg(id)}/refresh`, json("POST")),
    removeDocument: (id: string, docId: string) =>
      call<{ deleted: true; documentId: string; resource: ResourceSummary }>(fetcher, `${BASE}/resources/${seg(id)}/documents/${seg(docId)}`, json("DELETE")),
    /** Tester: only the selection and the question — the model and prompt are server-controlled. */
    test: (resourceIds: string[], question: string) => call<TesterResult>(fetcher, `${BASE}/test`, json("POST", { resourceIds, question })),
  };
}

export type KnowledgeClient = ReturnType<typeof createKnowledgeClient>;
export const knowledgeClient: KnowledgeClient = createKnowledgeClient();
