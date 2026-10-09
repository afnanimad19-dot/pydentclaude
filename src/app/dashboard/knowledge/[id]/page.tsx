"use client";

// Central Knowledge Base — resource detail (Phase A6). Metadata, read-only
// assignment info, documents (previews only), and — for owners / managers —
// upload files / add URLs, refresh, edit, duplicate, delete documents and the
// resource. All data comes from /api/knowledge/*.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Copy, FileText, FlaskConical, Globe, Pencil, RefreshCw, Trash2, Users } from "lucide-react";
import { Card, StatusBadge } from "@/components/ui";
import { toast } from "@/components/toast";
import {
  AssignedAgentsEditor,
  ConfirmModal,
  FileUploader,
  LoadingRows,
  NoticeLine,
  PageStateCard,
  ResourceFormModal,
  ResourceStatusBadge,
  TesterModal,
  TypeBadge,
  UrlAdder,
  btnSecondary,
} from "@/components/dashboard/knowledge-shared";
import { knowledgeClient, type KnowledgeDocument, type KnowledgeResource, type RefreshResult, type ResourceDetail } from "@/lib/knowledge-client";
import {
  DOCUMENT_STATUS_META,
  READ_ONLY_NOTE,
  REFRESH_OUTCOME_LABEL,
  actionError,
  atCharacterLimit,
  canManageFrom,
  deleteBlockedMessage,
  documentLabel,
  formatChars,
  formatDateTime,
  isForbiddenRole,
  pageStateFor,
  refreshNotice,
  type Notice,
  type PageState,
} from "@/lib/knowledge-ui";

export default function KnowledgeResourcePage() {
  const params = useParams<{ id: string }>();
  const id = String(params?.id ?? "");
  const router = useRouter();
  const [detail, setDetail] = useState<ResourceDetail | null>(null);
  const [state, setState] = useState<PageState>("ready");
  const [loading, setLoading] = useState(true);
  // Read-only until the server says otherwise (viewer.canManage).
  const [readOnly, setReadOnly] = useState(true);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"refresh" | "duplicate" | null>(null);
  const [refreshResult, setRefreshResult] = useState<{ notice: Notice; results: RefreshResult["results"] } | null>(null);
  const [docToDelete, setDocToDelete] = useState<KnowledgeDocument | null>(null);
  const [docBusy, setDocBusy] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBlocked, setDeleteBlocked] = useState(false);
  const [tester, setTester] = useState<KnowledgeResource[] | null>(null);

  const load = useCallback(async () => {
    const r = await knowledgeClient.detail(id);
    setLoading(false);
    if (r.ok) {
      setDetail(r.data);
      setReadOnly(!canManageFrom(r.data));
      setState("ready");
    } else {
      setDetail(null);
      setState(pageStateFor(r));
    }
  }, [id]);

  useEffect(() => {
    // Loading the resource is the page's external data source.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const forbidden = useCallback(() => {
    setReadOnly(true);
    toast(READ_ONLY_NOTE, "info");
  }, []);

  async function refresh() {
    if (busy || !detail) return;
    setBusy("refresh");
    setRefreshResult(null);
    const r = await knowledgeClient.refresh(detail.resource.id);
    setBusy(null);
    if (isForbiddenRole(r)) return forbidden();
    setRefreshResult({ notice: refreshNotice(r), results: r.ok ? r.data.results : [] });
    void load();
  }

  async function duplicate() {
    if (busy || !detail) return;
    setBusy("duplicate");
    const r = await knowledgeClient.duplicate(detail.resource.id);
    setBusy(null);
    if (!r.ok) {
      if (isForbiddenRole(r)) forbidden();
      else toast(actionError(r), "info");
      return;
    }
    toast(`Created "${r.data.resource.name}" with ${r.data.copiedDocuments} document${r.data.copiedDocuments === 1 ? "" : "s"}.`, "success");
    router.push(`/dashboard/knowledge/${r.data.resource.id}`);
  }

  async function confirmDeleteDocument() {
    if (!docToDelete || !detail || docBusy) return;
    setDocBusy(true);
    setDocError(null);
    const r = await knowledgeClient.removeDocument(detail.resource.id, docToDelete.id);
    setDocBusy(false);
    if (r.ok) {
      toast(`Removed "${documentLabel(docToDelete)}".`, "success");
      setDocToDelete(null);
      void load();
      return;
    }
    if (isForbiddenRole(r)) {
      setDocToDelete(null);
      return forbidden();
    }
    setDocError(actionError(r));
  }

  async function confirmDelete() {
    if (!detail || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    const r = await knowledgeClient.remove(detail.resource.id);
    setDeleteBusy(false);
    if (r.ok) {
      toast(`Deleted "${detail.resource.name}".`, "success");
      router.push("/dashboard/knowledge");
      return;
    }
    if (isForbiddenRole(r)) {
      setDeleting(false);
      return forbidden();
    }
    const blocked = deleteBlockedMessage(r, detail.resource.name);
    setDeleteBlocked(!!blocked);
    setDeleteError(blocked ? `${blocked} Remove it from those agents before deleting it.` : actionError(r));
  }

  async function openTester() {
    const r = await knowledgeClient.list();
    if (r.ok) setTester(r.data.resources);
    else toast(actionError(r), "info");
  }

  const back = (
    <Link href="/dashboard/knowledge" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-ink-500 hover:text-ink-900">
      <ArrowLeft className="h-4 w-4" aria-hidden /> Knowledge Base
    </Link>
  );

  if (loading) return (<>{back}<LoadingRows label="Loading knowledge resource…" /></>);
  if (state !== "ready" || !detail) return (<>{back}<PageStateCard state={state === "ready" ? "error" : state} onRetry={() => void load()} /></>);

  const r = detail.resource;
  const docs = detail.documents;

  return (
    <>
      {back}
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="break-words text-2xl font-semibold tracking-tight text-ink-900">{r.name}</h1>
            <TypeBadge type={r.type} />
            <ResourceStatusBadge status={r.status} />
          </div>
          {r.description && <p className="mt-1 max-w-2xl whitespace-pre-wrap break-words text-sm text-ink-500">{r.description}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void openTester()} className={btnSecondary}>
            <FlaskConical className="h-4 w-4" aria-hidden /> Test Knowledge
          </button>
          {!readOnly && (
            <>
              {r.type === "url" && (
                <button type="button" onClick={() => void refresh()} disabled={!!busy || docs.length === 0} className={btnSecondary}>
                  <RefreshCw className={`h-4 w-4 ${busy === "refresh" ? "animate-spin" : ""}`} aria-hidden />
                  {busy === "refresh" ? "Refreshing…" : "Refresh"}
                </button>
              )}
              <button type="button" onClick={() => setEditing(true)} disabled={!!busy} className={btnSecondary}>
                <Pencil className="h-4 w-4" aria-hidden /> Edit
              </button>
              <button type="button" onClick={() => void duplicate()} disabled={!!busy} className={btnSecondary}>
                <Copy className="h-4 w-4" aria-hidden /> {busy === "duplicate" ? "Duplicating…" : "Duplicate"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDeleteError(null);
                  setDeleteBlocked(false);
                  setDeleting(true);
                }}
                disabled={!!busy}
                className={`${btnSecondary} text-rose-600`}
              >
                <Trash2 className="h-4 w-4" aria-hidden /> Delete
              </button>
            </>
          )}
        </div>
      </div>

      {readOnly && <p className="mb-4 rounded-xl border border-ink-200 bg-ink-50 px-4 py-2.5 text-sm text-ink-600">{READ_ONLY_NOTE}</p>}

      <Card className="mb-4 p-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
          <div>
            <dt className="text-xs text-ink-400">Documents</dt>
            <dd className="font-semibold text-ink-800">{r.documentCount}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-400">Text</dt>
            <dd className="font-semibold text-ink-800">{formatChars(r.charCount)}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-400">Content version</dt>
            <dd className="font-semibold text-ink-800">{r.contentVersion}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-400">Assigned agents</dt>
            <dd className="font-semibold text-ink-800">{r.assignedAgentCount}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-400">Updated</dt>
            <dd className="text-ink-800">{formatDateTime(r.updatedAt)}</dd>
          </div>
          {r.type === "url" && (
            <div>
              <dt className="text-xs text-ink-400">Last refreshed</dt>
              <dd className="text-ink-800">{formatDateTime(r.lastRefreshedAt)}</dd>
            </div>
          )}
        </dl>
        {detail.assignedAgents.length > 0 ? (
          <p className="mt-3 flex items-start gap-1.5 border-t border-ink-100 pt-3 text-sm text-ink-600">
            <Users className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" aria-hidden />
            <span>
              Used by <span className="font-medium text-ink-800">{detail.assignedAgents.map((a) => a.name).join(", ")}</span>
            </span>
          </p>
        ) : (
          <p className="mt-3 border-t border-ink-100 pt-3 text-sm text-ink-500">Not assigned to any agent.</p>
        )}
        {r.type === "url" && r.lastError && (
          <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
            <p className="font-medium">The last refresh had problems — the previously imported content is still in use.</p>
            <p className="mt-0.5 break-words text-xs">{r.lastError}</p>
          </div>
        )}
      </Card>

      {!readOnly && (
        <Card className="mb-4 p-4">
          <h2 className="mb-3 text-sm font-semibold text-ink-900">Assigned agents</h2>
          <AssignedAgentsEditor resourceId={r.id} onChanged={() => void load()} onForbidden={forbidden} />
        </Card>
      )}

      {!readOnly && (
        <Card className="mb-4 p-4">
          <h2 className="mb-3 text-sm font-semibold text-ink-900">{r.type === "file" ? "Add files" : "Add web addresses"}</h2>
          {r.type === "file" ? (
            <FileUploader resourceId={r.id} documents={docs} onChanged={() => void load()} onForbidden={forbidden} />
          ) : (
            <UrlAdder resourceId={r.id} documents={docs} onChanged={() => void load()} onForbidden={forbidden} />
          )}
        </Card>
      )}

      {refreshResult && (
        <Card className="mb-4 p-4">
          <NoticeLine notice={refreshResult.notice} />
          {refreshResult.results.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm">
              {refreshResult.results.map((x) => (
                <li key={x.documentId} className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
                  <span className="min-w-0 break-all text-ink-700">{x.sourceUrl ?? "Web address"}</span>
                  <span className={x.outcome === "kept_previous" || x.outcome === "skipped" ? "text-amber-600" : "text-ink-500"}>— {REFRESH_OUTCOME_LABEL[x.outcome] ?? x.outcome}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold text-ink-900">
          Documents <span className="font-normal text-ink-400">({docs.length} of 50)</span>
        </h2>
        {docs.length === 0 ? (
          <p className="text-sm text-ink-500">{r.type === "file" ? "No files yet." : "No web addresses yet."}</p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {docs.map((d) => {
              const meta = DOCUMENT_STATUS_META[d.status] ?? DOCUMENT_STATUS_META.error;
              return (
                <li key={d.id} className="py-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="flex items-start gap-1.5 text-sm font-medium text-ink-900">
                        {d.kind === "file" ? <FileText className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" aria-hidden /> : <Globe className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" aria-hidden />}
                        <span className="min-w-0 break-all">{documentLabel(d)}</span>
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-500">
                        <StatusBadge status={meta.label} tone={meta.tone} />
                        <span>{formatChars(d.chars)}</span>
                        {atCharacterLimit(d) && <span className="text-amber-600">At the 200,000-character limit — later text was cut off</span>}
                        <span>{d.kind === "url" ? `Fetched ${formatDateTime(d.fetchedAt)}` : `Updated ${formatDateTime(d.updatedAt)}`}</span>
                      </p>
                      {d.error && (
                        <p className="mt-1 break-words text-xs text-amber-600">
                          {d.status === "ready" ? "Last update failed — previous content still in use: " : ""}
                          {d.error}
                        </p>
                      )}
                      {d.preview && (
                        <details className="mt-1.5">
                          <summary className="cursor-pointer text-xs font-medium text-brand-600">Show preview</summary>
                          {/* Plain text only — imported website HTML is never rendered. */}
                          <p className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
                            {d.preview}
                            {d.chars > d.preview.length && "…"}
                          </p>
                        </details>
                      )}
                    </div>
                    {!readOnly && (
                      <button
                        type="button"
                        onClick={() => {
                          setDocError(null);
                          setDocToDelete(d);
                        }}
                        className={`${btnSecondary} shrink-0 self-start text-rose-600`}
                        aria-label={`Delete document ${documentLabel(d)}`}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden /> Delete
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {editing && (
        <ResourceFormModal
          mode="edit"
          resource={r}
          onClose={() => setEditing(false)}
          onForbidden={() => {
            setEditing(false);
            forbidden();
          }}
          onSaved={() => {
            setEditing(false);
            toast("Saved.", "success");
            void load();
          }}
        />
      )}
      {docToDelete && (
        <ConfirmModal
          title="Delete document?"
          danger
          busy={docBusy}
          error={docError}
          confirmLabel="Delete document"
          body={
            <>
              <p className="break-all">
                <strong className="text-ink-900">{documentLabel(docToDelete)}</strong>
              </p>
              <p>Deleting this document removes its knowledge from this resource. This can&apos;t be undone.</p>
            </>
          }
          onConfirm={() => void confirmDeleteDocument()}
          onClose={() => setDocToDelete(null)}
        />
      )}
      {deleting && (
        <ConfirmModal
          title="Delete knowledge resource?"
          danger
          busy={deleteBusy}
          error={deleteError}
          confirmDisabled={deleteBlocked}
          confirmLabel="Delete resource"
          body={
            <>
              <p>
                <strong className="text-ink-900">{r.name}</strong> and its {docs.length} document{docs.length === 1 ? "" : "s"} will be permanently deleted.
              </p>
              <p>This can&apos;t be undone.</p>
            </>
          }
          onConfirm={() => void confirmDelete()}
          onClose={() => setDeleting(false)}
        />
      )}
      {tester && <TesterModal resources={tester} preselected={[r.id]} onClose={() => setTester(null)} />}
      {busy === null && docs.length === 0 && !readOnly && r.type === "url" && (
        <p className="mt-3 text-xs text-ink-400">
          Tip: add a web address above, then use <span className="font-medium">Refresh</span> any time to re-import it.
        </p>
      )}
      <span className="sr-only" aria-live="polite">
        {busy === "refresh" ? "Refreshing" : busy === "duplicate" ? "Duplicating" : ""}
      </span>
    </>
  );
}
