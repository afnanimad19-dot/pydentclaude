"use client";

// Central Knowledge Base — resource list (Phase A6). Browse, search and filter
// the workspace's knowledge resources; create, edit, duplicate, refresh and
// delete them (owner / manager); open the Knowledge Tester (every member).
// All data comes from /api/knowledge/* — the server decides the workspace.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookOpen, Copy, FlaskConical, Pencil, Plus, RefreshCw, RotateCw, Search, Trash2, Users } from "lucide-react";
import { Card, PageHeader } from "@/components/ui";
import { inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import {
  ConfirmModal,
  LoadingRows,
  PageStateCard,
  ResourceFormModal,
  ResourceStatusBadge,
  TesterModal,
  TypeBadge,
  btnPrimary,
  btnSecondary,
} from "@/components/dashboard/knowledge-shared";
import { knowledgeClient, type KnowledgeResource, type ResourceStatus, type ResourceType } from "@/lib/knowledge-client";
import {
  READ_ONLY_NOTE,
  STATUS_FILTERS,
  TYPE_FILTERS,
  actionError,
  canManageFrom,
  deleteBlockedMessage,
  formatChars,
  formatDateTime,
  isForbiddenRole,
  pageStateFor,
  refreshNotice,
  type PageState,
} from "@/lib/knowledge-ui";

type Busy = { id: string; action: "duplicate" | "refresh" } | null;

export default function KnowledgeBasePage() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"" | ResourceType>("");
  const [status, setStatus] = useState<"" | ResourceStatus>("");
  const [resources, setResources] = useState<KnowledgeResource[] | null>(null);
  const [state, setState] = useState<PageState>("ready");
  const [loading, setLoading] = useState(true);
  // Read-only until the server says otherwise (viewer.canManage) — no control flashes for doctors / agents.
  const [readOnly, setReadOnly] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<KnowledgeResource | null>(null);
  const [deleting, setDeleting] = useState<KnowledgeResource | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBlocked, setDeleteBlocked] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [tester, setTester] = useState<KnowledgeResource[] | null>(null);

  // Debounce typing in the search box.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await knowledgeClient.list({ q: query, type, status });
    setLoading(false);
    if (r.ok) {
      setResources(r.data.resources);
      setReadOnly(!canManageFrom(r.data));
      setState("ready");
    } else {
      setResources(null);
      setState(pageStateFor(r));
    }
  }, [query, type, status]);

  useEffect(() => {
    // Loading the list is the page's external data source.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const forbidden = useCallback(() => {
    setReadOnly(true);
    toast(READ_ONLY_NOTE, "info");
  }, []);

  async function duplicate(r: KnowledgeResource) {
    if (busy) return;
    setBusy({ id: r.id, action: "duplicate" });
    const res = await knowledgeClient.duplicate(r.id);
    setBusy(null);
    if (!res.ok) {
      if (isForbiddenRole(res)) forbidden();
      else toast(actionError(res), "info");
      return;
    }
    toast(`Created "${res.data.resource.name}" with ${res.data.copiedDocuments} document${res.data.copiedDocuments === 1 ? "" : "s"}.`, "success");
    router.push(`/dashboard/knowledge/${res.data.resource.id}`);
  }

  async function refresh(r: KnowledgeResource) {
    if (busy) return;
    setBusy({ id: r.id, action: "refresh" });
    const res = await knowledgeClient.refresh(r.id);
    setBusy(null);
    if (isForbiddenRole(res)) return forbidden();
    toast(refreshNotice(res).text, res.ok && res.data.failed === 0 ? "success" : "info");
    void load();
  }

  async function confirmDelete() {
    if (!deleting || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    const res = await knowledgeClient.remove(deleting.id);
    setDeleteBusy(false);
    if (res.ok) {
      toast(`Deleted "${deleting.name}".`, "success");
      setDeleting(null);
      void load();
      return;
    }
    if (isForbiddenRole(res)) {
      setDeleting(null);
      return forbidden();
    }
    const blocked = deleteBlockedMessage(res, deleting.name);
    setDeleteBlocked(!!blocked);
    setDeleteError(blocked ? `${blocked} Remove it from those agents before deleting it.` : actionError(res));
  }

  async function openTester() {
    const r = await knowledgeClient.list();
    if (r.ok) setTester(r.data.resources);
    else toast(actionError(r), "info");
  }

  const filtered = !!(query.trim() || type || status);
  const anyBusy = !!busy;

  return (
    <>
      <PageHeader
        title="Knowledge Base"
        subtitle="Manage reusable knowledge resources for your AI agents."
        actions={
          state === "ready" && resources !== null ? (
            <>
              <button type="button" onClick={() => void openTester()} className={btnSecondary}>
                <FlaskConical className="h-4 w-4" aria-hidden /> Test Knowledge
              </button>
              {!readOnly && (
                <button type="button" onClick={() => setCreating(true)} className={btnPrimary}>
                  <Plus className="h-4 w-4" aria-hidden /> Add Resource
                </button>
              )}
            </>
          ) : null
        }
      />

      {readOnly && state === "ready" && resources !== null && <p className="mb-4 rounded-xl border border-ink-200 bg-ink-50 px-4 py-2.5 text-sm text-ink-600">{READ_ONLY_NOTE}</p>}

      {state !== "ready" ? (
        <PageStateCard state={state} onRetry={() => void load()} />
      ) : (
        <>
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-ink-200 bg-surface px-3 py-2 sm:min-w-[220px]">
              <Search className="h-4 w-4 shrink-0 text-ink-400" aria-hidden />
              <label htmlFor="kb-search" className="sr-only">
                Search knowledge resources
              </label>
              <input id="kb-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or description" className="w-full bg-transparent text-sm text-ink-800 outline-none placeholder:text-ink-400" />
            </div>
            <div className="flex gap-2">
              <label htmlFor="kb-type" className="sr-only">
                Filter by type
              </label>
              <select id="kb-type" value={type} onChange={(e) => setType(e.target.value as "" | ResourceType)} className={`${inputCls} sm:w-36`}>
                {TYPE_FILTERS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <label htmlFor="kb-status" className="sr-only">
                Filter by status
              </label>
              <select id="kb-status" value={status} onChange={(e) => setStatus(e.target.value as "" | ResourceStatus)} className={`${inputCls} sm:w-40`}>
                {STATUS_FILTERS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => void load()} disabled={loading} className={btnSecondary} title="Reload" aria-label="Reload knowledge resources">
                <RotateCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden />
              </button>
            </div>
          </div>

          {loading && !resources ? (
            <LoadingRows />
          ) : resources && resources.length === 0 ? (
            filtered ? (
              <Card className="px-6 py-10 text-center text-sm text-ink-500">No knowledge resources match your search or filters.</Card>
            ) : (
              <Card className="flex flex-col items-center px-6 py-14 text-center">
                <BookOpen className="h-8 w-8 text-brand-500" aria-hidden />
                <h2 className="mt-3 text-base font-semibold text-ink-900">No knowledge resources yet.</h2>
                <p className="mt-1 max-w-md text-sm text-ink-500">
                  A knowledge resource holds reusable information — uploaded files (PDF, Word, images) or text imported from websites — that you can keep up to date in one place.
                </p>
                {!readOnly && (
                  <button type="button" onClick={() => setCreating(true)} className={`${btnPrimary} mt-5`}>
                    <Plus className="h-4 w-4" aria-hidden /> Add Resource
                  </button>
                )}
              </Card>
            )
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-busy={loading}>
              {(resources ?? []).map((r) => (
                <li key={r.id}>
                  <Card className="flex h-full flex-col p-4">
                    <div className="flex items-start justify-between gap-2">
                      <Link href={`/dashboard/knowledge/${r.id}`} className="min-w-0 break-words text-base font-semibold text-ink-900 hover:text-brand-600 focus-visible:underline">
                        {r.name}
                      </Link>
                      <div className="flex shrink-0 flex-wrap justify-end gap-1">
                        <TypeBadge type={r.type} />
                        <ResourceStatusBadge status={r.status} />
                      </div>
                    </div>
                    {r.description && <p className="mt-1 line-clamp-2 text-sm text-ink-500">{r.description}</p>}
                    <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <dt className="text-ink-400">Documents</dt>
                        <dd className="font-semibold text-ink-800">{r.documentCount}</dd>
                      </div>
                      <div>
                        <dt className="text-ink-400">Text</dt>
                        <dd className="font-semibold text-ink-800">{formatChars(r.charCount)}</dd>
                      </div>
                      <div>
                        <dt className="text-ink-400">Agents</dt>
                        <dd className="font-semibold text-ink-800">{r.assignedAgentCount}</dd>
                      </div>
                    </dl>
                    {r.assignedAgents.length > 0 && (
                      <p className="mt-2 flex items-start gap-1 text-xs text-ink-500">
                        <Users className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                        <span className="break-words">Used by {r.assignedAgents.map((a) => a.name).join(", ")}</span>
                      </p>
                    )}
                    {r.type === "url" && r.lastError && <p className="mt-2 text-xs text-amber-600">Last refresh had problems — previous content is still in use.</p>}
                    <p className="mt-2 text-xs text-ink-400">Updated {formatDateTime(r.updatedAt)}</p>
                    <div className="mt-auto flex flex-wrap gap-1.5 pt-3">
                      <Link href={`/dashboard/knowledge/${r.id}`} className={btnSecondary}>
                        Open
                      </Link>
                      {!readOnly && (
                        <>
                          <button type="button" onClick={() => setEditing(r)} disabled={anyBusy} className={btnSecondary} aria-label={`Edit ${r.name}`}>
                            <Pencil className="h-4 w-4" aria-hidden /> Edit
                          </button>
                          {r.type === "url" && (
                            <button type="button" onClick={() => void refresh(r)} disabled={anyBusy || r.documentCount === 0} className={btnSecondary} aria-label={`Refresh ${r.name}`}>
                              <RefreshCw className={`h-4 w-4 ${busy?.id === r.id && busy.action === "refresh" ? "animate-spin" : ""}`} aria-hidden />
                              {busy?.id === r.id && busy.action === "refresh" ? "Refreshing…" : "Refresh"}
                            </button>
                          )}
                          <button type="button" onClick={() => void duplicate(r)} disabled={anyBusy} className={btnSecondary} aria-label={`Duplicate ${r.name}`}>
                            <Copy className="h-4 w-4" aria-hidden />
                            {busy?.id === r.id && busy.action === "duplicate" ? "Duplicating…" : "Duplicate"}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setDeleteError(null);
                              setDeleteBlocked(false);
                              setDeleting(r);
                            }}
                            disabled={anyBusy}
                            className={`${btnSecondary} text-rose-600`}
                            aria-label={`Delete ${r.name}`}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden /> Delete
                          </button>
                        </>
                      )}
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {creating && (
        <ResourceFormModal
          mode="create"
          onClose={() => setCreating(false)}
          onForbidden={() => {
            setCreating(false);
            forbidden();
          }}
          onSaved={(res) => {
            setCreating(false);
            toast(`Created "${res.name}". Now add its ${res.type === "file" ? "files" : "web addresses"}.`, "success");
            router.push(`/dashboard/knowledge/${res.id}`);
          }}
        />
      )}
      {editing && (
        <ResourceFormModal
          mode="edit"
          resource={editing}
          onClose={() => setEditing(null)}
          onForbidden={() => {
            setEditing(null);
            forbidden();
          }}
          onSaved={() => {
            setEditing(null);
            toast("Saved.", "success");
            void load();
          }}
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
                <strong className="text-ink-900">{deleting.name}</strong> and its {deleting.documentCount} document{deleting.documentCount === 1 ? "" : "s"} will be permanently deleted.
              </p>
              <p>This can&apos;t be undone.</p>
            </>
          }
          onConfirm={() => void confirmDelete()}
          onClose={() => setDeleting(null)}
        />
      )}
      {tester && <TesterModal resources={tester} onClose={() => setTester(null)} />}
    </>
  );
}
