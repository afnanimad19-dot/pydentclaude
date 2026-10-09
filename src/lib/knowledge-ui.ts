// Central Knowledge Base — UI logic (Phase A6). Pure: no React, no fetch.
// Turns API results into what the Knowledge Base pages show, so the wording and
// decisions are unit-tested and the components stay thin.

import { MAX_DOCUMENT_CHARS, nameKey, normalizeSourceUrl } from "@/lib/knowledge";
import type { ApiError, ApiResult, IngestResult, KnowledgeDocument, RefreshResult, ResourceStatus, ResourceType, TesterResult } from "@/lib/knowledge-client";

// ------------------------------------------------------------------ labels

type Tone = "green" | "amber" | "red" | "gray" | "blue" | "violet";

/** The four A4 resource statuses — no others exist. Text, not color alone, carries the meaning. */
export const RESOURCE_STATUS_META: Record<ResourceStatus, { label: string; tone: Tone; hint: string }> = {
  empty: { label: "Empty", tone: "gray", hint: "No documents yet." },
  processing: { label: "Processing", tone: "blue", hint: "A document is still being processed." },
  ready: { label: "Ready", tone: "green", hint: "Knowledge is available." },
  error: { label: "Error", tone: "red", hint: "No document could be read." },
};

export const DOCUMENT_STATUS_META: Record<"processing" | "ready" | "error", { label: string; tone: Tone }> = {
  processing: { label: "Processing", tone: "blue" },
  ready: { label: "Ready", tone: "green" },
  error: { label: "Error", tone: "red" },
};

export const TYPE_LABEL: Record<ResourceType, string> = { file: "File", url: "URL" };

export const STATUS_FILTERS: { value: "" | ResourceStatus; label: string }[] = [
  { value: "", label: "All statuses" },
  { value: "ready", label: "Ready" },
  { value: "processing", label: "Processing" },
  { value: "error", label: "Error" },
  { value: "empty", label: "Empty" },
];

export const TYPE_FILTERS: { value: "" | ResourceType; label: string }[] = [
  { value: "", label: "All types" },
  { value: "file", label: "File" },
  { value: "url", label: "URL" },
];

/** URL refresh intervals the API accepts (A2/0065). */
export const REFRESH_INTERVALS: { hours: number; label: string }[] = [
  { hours: 6, label: "Every 6 hours" },
  { hours: 12, label: "Every 12 hours" },
  { hours: 24, label: "Every day" },
  { hours: 168, label: "Every week" },
];

/**
 * File types the server extractor (A3 kb-extract) actually reads: PDF, Word
 * (.docx; legacy .doc best-effort) and images via OCR. Plain-text files are
 * NOT accepted by that extractor, so they are not offered.
 */
export const ACCEPTED_FILE_EXTENSIONS = [".pdf", ".docx", ".doc", ".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".gif", ".bmp"];
export const ACCEPT_ATTRIBUTE = ACCEPTED_FILE_EXTENSIONS.join(",");
export const ACCEPTED_FILES_LABEL = "PDF, Word (.docx or .doc) or an image (PNG, JPG, WebP, TIFF)";
/** Mirrors the server's upload cap (knowledge-service MAX_UPLOAD_BYTES). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function formatChars(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 characters";
  if (n < 1000) return `${n} character${n === 1 ? "" : "s"}`;
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k characters`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function documentLabel(d: Pick<KnowledgeDocument, "kind" | "filename" | "sourceUrl">): string {
  return (d.kind === "file" ? d.filename : d.sourceUrl) || "Untitled document";
}

/** A document stored at the 200,000-character cap was (most likely) truncated on import. */
export function atCharacterLimit(d: Pick<KnowledgeDocument, "chars">): boolean {
  return d.chars >= MAX_DOCUMENT_CHARS;
}

// ------------------------------------------------------------------ page / error states

export type PageState = "ready" | "migration_missing" | "unavailable" | "signed_out" | "no_access" | "not_found" | "error";

/** How a failed load is shown. Migration-missing is its own state — never an empty list. */
export function pageStateFor(err: ApiError): PageState {
  if (err.code === "knowledge_migration_missing") return "migration_missing";
  if (err.code === "service_unavailable") return "unavailable";
  if (err.status === 401) return "signed_out";
  if (err.status === 403) return "no_access";
  if (err.status === 404) return "not_found";
  return "error";
}

export const PAGE_STATE_COPY: Record<Exclude<PageState, "ready">, { title: string; body: string }> = {
  migration_missing: { title: "Knowledge Base isn't available in this environment yet.", body: "It hasn't been set up here. Your agents' existing knowledge is not affected." },
  unavailable: { title: "Knowledge Base is temporarily unavailable.", body: "Please try again in a few minutes." },
  signed_out: { title: "Your session has ended.", body: "Sign in again to use the Knowledge Base." },
  no_access: { title: "You don't have access to this workspace's Knowledge Base.", body: "Ask a workspace owner to check your membership." },
  not_found: { title: "Knowledge resource not found.", body: "It may have been deleted, or it belongs to another workspace." },
  error: { title: "Couldn't load the Knowledge Base.", body: "Something went wrong. Try again." },
};

/**
 * Whether to offer mutation controls, from the server's `viewer` capability.
 * Missing / malformed → false (least privilege). The server still enforces it.
 */
export function canManageFrom(data: { viewer?: { canManage?: unknown } } | null | undefined): boolean {
  return data?.viewer?.canManage === true;
}

/** True when the server refused a change because of the user's role (doctor / agent). */
export function isForbiddenRole(r: ApiResult<unknown>): boolean {
  return !r.ok && r.code === "forbidden_role";
}

export const READ_ONLY_NOTE = "You can browse and test the Knowledge Base. Only workspace owners and managers can change it.";

/** A user-facing message for a failed action (no internals: the server already sends safe text). */
export function actionError(err: ApiError): string {
  if (err.code === "knowledge_migration_missing") return PAGE_STATE_COPY.migration_missing.title;
  if (err.code === "forbidden_role") return "Only a workspace owner or manager can change the Knowledge Base.";
  if (err.code === "network_error") return err.error;
  if (err.status >= 500) return "Something went wrong on the server. Nothing was changed — try again.";
  return err.error;
}

// ------------------------------------------------------------------ delete

/** The 409 "assigned" response → a blocking explanation naming the agents. */
export function deleteBlockedMessage(err: ApiError, resourceName: string): string | null {
  if (err.status !== 409 || err.code !== "resource_assigned") return null;
  const agents = Array.isArray(err.body.agents) ? (err.body.agents as { agentName?: string }[]).map((a) => String(a.agentName ?? "").trim()).filter(Boolean) : [];
  const count = typeof err.body.count === "number" ? err.body.count : agents.length;
  if (!agents.length) return `"${resourceName}" can't be deleted because it is assigned to ${count === 1 ? "an agent" : `${count || "one or more"} agents`}.`;
  const list = agents.length === 1 ? agents[0] : `${agents.slice(0, -1).join(", ")} and ${agents[agents.length - 1]}`;
  return `"${resourceName}" can't be deleted because it is assigned to ${list}.`;
}

// ------------------------------------------------------------------ files

/** The existing document a same-named upload would replace (same rule as the server: trimmed, case-insensitive). */
export function sameNameDocument(docs: readonly KnowledgeDocument[], filename: string): KnowledgeDocument | null {
  const key = nameKey(filename);
  return docs.find((d) => d.kind === "file" && d.filename !== null && nameKey(d.filename) === key) ?? null;
}

export const REPLACE_CONFIRM = "A file with this name already exists. Uploading will replace its knowledge content.";

export function uploadPrecheck(file: { name: string; size: number }): string | null {
  if (file.size <= 0) return `"${file.name}" is empty.`;
  if (file.size > MAX_UPLOAD_BYTES) return `"${file.name}" is larger than 10 MB.`;
  const lower = file.name.toLowerCase();
  if (!ACCEPTED_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return `"${file.name}" isn't a supported file type. Upload ${ACCEPTED_FILES_LABEL}.`;
  return null;
}

export type Notice = { tone: "success" | "info" | "error"; text: string };

export function uploadNotice(filename: string, r: ApiResult<IngestResult>): Notice {
  if (!r.ok) {
    if (r.body.kept === true) return { tone: "error", text: `${actionError(r)} The previous version of "${filename}" is still in use.` };
    return { tone: "error", text: `"${filename}": ${actionError(r)}` };
  }
  const trunc = r.data.truncated ? " It was longer than 200,000 characters, so only the first 200,000 were kept." : "";
  if (r.data.action === "inserted") return { tone: "success", text: `"${filename}" added.${trunc}` };
  if (r.data.action === "replaced") return { tone: "success", text: `"${filename}" replaced with the new version.${trunc}` };
  return { tone: "info", text: `"${filename}" is unchanged — the content is identical to the current version.` };
}

// ------------------------------------------------------------------ URLs

export function existingUrlDocument(docs: readonly KnowledgeDocument[], raw: string): KnowledgeDocument | null {
  const key = normalizeSourceUrl(raw);
  if (!key) return null;
  return docs.find((d) => d.kind === "url" && d.sourceUrl !== null && normalizeSourceUrl(d.sourceUrl) === key) ?? null;
}

export function urlNotice(url: string, r: ApiResult<IngestResult>): Notice {
  if (!r.ok) {
    if (r.body.kept === true) return { tone: "error", text: `${actionError(r)} The previously imported content is still in use.` };
    return { tone: "error", text: actionError(r) };
  }
  const trunc = r.data.truncated ? " The site had more than 200,000 characters of text, so only the first 200,000 were kept." : "";
  if (r.data.action === "inserted") return { tone: "success", text: `Imported ${url}.${trunc}` };
  if (r.data.action === "replaced") return { tone: "success", text: `Updated ${url} with the latest content.${trunc}` };
  return { tone: "info", text: `${url} is unchanged since the last import.` };
}

/** Summary of a manual refresh. A failure never removes knowledge: the last good content stays. */
export function refreshNotice(r: ApiResult<RefreshResult>): Notice {
  if (!r.ok) return { tone: "error", text: `${actionError(r)} The previously imported content is still in use.` };
  const { refreshed, failed, changed } = r.data;
  const kept = failed ? ` ${failed} address${failed === 1 ? "" : "es"} couldn't be refreshed — their previous content is still in use.` : "";
  if (refreshed === 0 && failed > 0) return { tone: "error", text: `Refresh failed.${kept}` };
  if (changed) return { tone: failed ? "info" : "success", text: `Refreshed — new content was imported.${kept}` };
  return { tone: failed ? "info" : "success", text: `Refreshed — nothing changed since the last import.${kept}` };
}

export const REFRESH_OUTCOME_LABEL: Record<RefreshResult["results"][number]["outcome"], string> = {
  replaced: "Updated",
  unchanged: "Unchanged",
  kept_previous: "Failed — previous content kept",
  skipped: "Skipped — time limit reached",
  removed: "Removed during refresh",
};

// ------------------------------------------------------------------ tester

export const TESTER_MAX_RESOURCES = 10;
export const TESTER_MAX_QUESTION = 1000;

export function testerPrecheck(selected: readonly string[], question: string): string | null {
  if (!selected.length) return "Select at least one knowledge resource to test.";
  if (selected.length > TESTER_MAX_RESOURCES) return `Select at most ${TESTER_MAX_RESOURCES} resources at a time.`;
  const q = question.trim();
  if (!q) return "Type a question to test the knowledge.";
  if (q.length > TESTER_MAX_QUESTION) return `Keep the question to ${TESTER_MAX_QUESTION} characters or fewer.`;
  return null;
}

export interface TesterView {
  heading: string;
  tone: "success" | "info" | "warning";
  answer: string | null;
  note: string | null;
  sources: { key: string; rank: number; resourceName: string; documentLabel: string; section: string; chunk: number; score: string; preview: string; truncated: boolean }[];
}

/** What the Tester panel shows for a result. Retrieval-only keeps every matched source. */
export function testerView(r: TesterResult): TesterView {
  const sources = r.chunks.map((c) => ({
    key: `${c.documentId}#${c.chunkIndex}`,
    rank: c.rank,
    resourceName: c.resourceName,
    documentLabel: c.documentLabel,
    section: c.section,
    chunk: c.chunkIndex + 1,
    score: Number.isFinite(c.score) ? c.score.toFixed(2) : "—",
    preview: c.preview,
    truncated: c.chars > c.preview.length,
  }));
  if (r.answerStatus === "answered") return { heading: "Answer", tone: "success", answer: r.answer, note: "Generated only from the matched knowledge below.", sources };
  if (r.answerStatus === "not_found") {
    return { heading: "Not in the selected resources", tone: "info", answer: r.answer, note: "No matching knowledge was found in the selected resources.", sources };
  }
  const why = r.generation.reason === "timeout" ? "the AI took too long to respond" : r.generation.status === "unavailable" ? "AI answers aren't set up in this environment" : "the AI service couldn't generate an answer";
  return {
    heading: "Matching knowledge found",
    tone: "warning",
    answer: null,
    note: `Matching knowledge was found, but no answer was generated because ${why}. The matched sources are shown below.`,
    sources,
  };
}
