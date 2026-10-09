"use client";

// Central Knowledge Base — shared UI pieces (Phase A6): dialogs, uploaders,
// the Knowledge Tester and state cards. All data goes through the
// /api/knowledge client; nothing here reads Supabase or sends a workspace,
// agent, model or prompt. Server authorization stays authoritative — hidden
// controls are a convenience, not a security boundary.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileUp, FlaskConical, Globe, Info, Loader2, Search } from "lucide-react";
import { Card, StatusBadge } from "@/components/ui";
import { Modal, inputCls } from "@/components/modal";
import {
  knowledgeClient,
  type ApiError,
  type KnowledgeDocument,
  type KnowledgeResource,
  type ResourceAgents,
  type ResourceType,
  type TesterResult,
} from "@/lib/knowledge-client";
import {
  ACCEPT_ATTRIBUTE,
  ACCEPTED_FILES_LABEL,
  PAGE_STATE_COPY,
  REFRESH_INTERVALS,
  REPLACE_CONFIRM,
  RESOURCE_STATUS_META,
  TESTER_MAX_QUESTION,
  TESTER_MAX_RESOURCES,
  TYPE_LABEL,
  actionError,
  existingUrlDocument,
  isForbiddenRole,
  sameNameDocument,
  testerPrecheck,
  testerView,
  uploadNotice,
  uploadPrecheck,
  urlNotice,
  type Notice,
  type PageState,
} from "@/lib/knowledge-ui";

export const btnPrimary =
  "inline-flex items-center justify-center gap-1.5 rounded-xl bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60";
export const btnSecondary =
  "inline-flex items-center justify-center gap-1.5 rounded-xl border border-ink-200 bg-surface px-3.5 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-60";
export const btnDanger =
  "inline-flex items-center justify-center gap-1.5 rounded-xl bg-rose-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60";

/** Escape closes the dialog (the shared Modal has no key handling of its own). */
export function useEscape(onClose: () => void, active = true) {
  const ref = useRef(onClose);
  useEffect(() => {
    ref.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") ref.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}

export function ResourceStatusBadge({ status }: { status: KnowledgeResource["status"] }) {
  const m = RESOURCE_STATUS_META[status] ?? RESOURCE_STATUS_META.error;
  return <StatusBadge status={m.label} tone={m.tone} />;
}

export function TypeBadge({ type }: { type: ResourceType }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-600">
      {type === "file" ? <FileUp className="h-3 w-3" aria-hidden /> : <Globe className="h-3 w-3" aria-hidden />}
      {TYPE_LABEL[type]}
    </span>
  );
}

export function NoticeLine({ notice }: { notice: Notice }) {
  const Icon = notice.tone === "success" ? CheckCircle2 : notice.tone === "error" ? AlertTriangle : Info;
  const cls = notice.tone === "success" ? "text-emerald-600" : notice.tone === "error" ? "text-rose-600" : "text-ink-600";
  return (
    <p role={notice.tone === "error" ? "alert" : "status"} className={`flex items-start gap-1.5 text-sm ${cls}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{notice.text}</span>
    </p>
  );
}

/** Full-page state for a failed load (migration missing, no access, …) — never an empty list. */
export function PageStateCard({ state, onRetry }: { state: Exclude<PageState, "ready">; onRetry?: () => void }) {
  const copy = PAGE_STATE_COPY[state];
  return (
    <Card className="flex flex-col items-center px-6 py-14 text-center">
      <AlertTriangle className="h-8 w-8 text-amber-500" aria-hidden />
      <h2 className="mt-3 text-base font-semibold text-ink-900">{copy.title}</h2>
      <p className="mt-1 max-w-md text-sm text-ink-500">{copy.body}</p>
      {onRetry && state !== "migration_missing" && (
        <button type="button" onClick={onRetry} className={`${btnSecondary} mt-5`}>
          Try again
        </button>
      )}
    </Card>
  );
}

export function LoadingRows({ label = "Loading knowledge resources…" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 py-10 text-sm text-ink-500">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

// ------------------------------------------------------------------ confirm

export function ConfirmModal({
  title,
  body,
  confirmLabel,
  danger = false,
  busy = false,
  error,
  confirmDisabled = false,
  onConfirm,
  onClose,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  /** e.g. after the server refused the action: only Cancel remains useful. */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEscape(onClose, !busy);
  return (
    <Modal open onClose={busy ? () => {} : onClose} title={title}>
      <div className="space-y-3 text-sm text-ink-600">{body}</div>
      {error && (
        <div className="mt-4">
          <NoticeLine notice={{ tone: "error", text: error }} />
        </div>
      )}
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onClose} disabled={busy} className={btnSecondary}>
          Cancel
        </button>
        <button type="button" onClick={onConfirm} disabled={busy || confirmDisabled} className={danger ? btnDanger : btnPrimary} autoFocus>
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ create / edit

export function ResourceFormModal({
  mode,
  resource,
  onClose,
  onSaved,
  onForbidden,
}: {
  mode: "create" | "edit";
  resource?: KnowledgeResource;
  onClose: () => void;
  onSaved: (resource: KnowledgeResource) => void;
  onForbidden: () => void;
}) {
  const ids = useId();
  const [name, setName] = useState(resource?.name ?? "");
  const [description, setDescription] = useState(resource?.description ?? "");
  const [type, setType] = useState<ResourceType>(resource?.type ?? "file");
  const [refreshEnabled, setRefreshEnabled] = useState(resource?.refreshEnabled ?? false);
  const [interval, setIntervalHours] = useState<number>(resource?.refreshIntervalHours ?? 24);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscape(onClose, !busy);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      setError("Give the resource a name.");
      return;
    }
    setBusy(true);
    setError(null);
    if (mode === "create") {
      const r = await knowledgeClient.create({ name, description, type });
      setBusy(false);
      if (r.ok) return onSaved(r.data.resource);
      if (isForbiddenRole(r)) onForbidden();
      return setError(actionError(r));
    }
    const patch =
      resource!.type === "url"
        ? { name, description, refreshEnabled, refreshIntervalHours: refreshEnabled ? interval : null }
        : { name, description };
    const r = await knowledgeClient.update(resource!.id, patch);
    setBusy(false);
    if (r.ok) return onSaved(r.data.resource);
    if (isForbiddenRole(r)) onForbidden();
    setError(actionError(r));
  }

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={mode === "create" ? "Add knowledge resource" : "Edit knowledge resource"}
      subtitle={mode === "create" ? "A reusable set of files or website knowledge. You'll add content after creating it." : undefined}
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <label htmlFor={`${ids}-name`} className="mb-1.5 block text-sm font-medium text-ink-700">
            Name
          </label>
          <input id={`${ids}-name`} className={inputCls} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Treatment prices" autoFocus required />
        </div>
        <div>
          <label htmlFor={`${ids}-desc`} className="mb-1.5 block text-sm font-medium text-ink-700">
            Description <span className="font-normal text-ink-400">(optional)</span>
          </label>
          <textarea id={`${ids}-desc`} className={`${inputCls} min-h-[72px]`} value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <fieldset>
          <legend className="mb-1.5 block text-sm font-medium text-ink-700">Type</legend>
          {mode === "create" ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {(["file", "url"] as const).map((t) => (
                <label key={t} className={`flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2.5 text-sm ${type === t ? "border-brand-400 bg-brand-50" : "border-ink-200"}`}>
                  <input type="radio" name={`${ids}-type`} value={t} checked={type === t} onChange={() => setType(t)} className="mt-0.5 h-4 w-4 accent-[#7c3aed]" />
                  <span>
                    <span className="block font-medium text-ink-800">{t === "file" ? "File" : "URL"}</span>
                    <span className="block text-xs text-ink-500">{t === "file" ? "Upload PDF, Word or image files." : "Import text from web pages."}</span>
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="text-sm text-ink-600">
              <TypeBadge type={resource!.type} /> <span className="ml-1 text-xs text-ink-400">The type can&apos;t be changed after creation.</span>
            </p>
          )}
          {mode === "create" && <p className="mt-1.5 text-xs text-ink-400">The type can&apos;t be changed later.</p>}
        </fieldset>
        {mode === "edit" && resource?.type === "url" && (
          <fieldset className="rounded-xl border border-ink-200 px-3 py-3">
            <legend className="px-1 text-sm font-medium text-ink-700">Automatic refresh setting</legend>
            <label className="flex items-center gap-2 text-sm text-ink-700">
              <input type="checkbox" checked={refreshEnabled} onChange={(e) => setRefreshEnabled(e.target.checked)} className="h-4 w-4 accent-[#7c3aed]" />
              Refresh this website automatically
            </label>
            {refreshEnabled && (
              <div className="mt-2">
                <label htmlFor={`${ids}-interval`} className="sr-only">
                  Refresh interval
                </label>
                <select id={`${ids}-interval`} className={inputCls} value={interval} onChange={(e) => setIntervalHours(Number(e.target.value))}>
                  {REFRESH_INTERVALS.map((o) => (
                    <option key={o.hours} value={o.hours}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <p className="mt-2 text-xs text-ink-500">Automatic refresh isn&apos;t running yet — this setting is saved for later. Use Refresh on the resource to update it now.</p>
          </fieldset>
        )}
        {error && <NoticeLine notice={{ tone: "error", text: error }} />}
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={busy} className={btnSecondary}>
            Cancel
          </button>
          <button type="submit" disabled={busy} className={btnPrimary}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {mode === "create" ? "Create resource" : "Save changes"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ add content

/** Upload one or more files to a File resource, one at a time (server-side extraction). */
export function FileUploader({ resourceId, documents, onChanged, onForbidden }: { resourceId: string; documents: KnowledgeDocument[]; onChanged: () => void; onForbidden: () => void }) {
  const inputId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<File[] | null>(null);
  const [replacing, setReplacing] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);

  function pick(files: FileList | null) {
    if (!files?.length) return;
    const list = Array.from(files);
    const same = list.map((f) => sameNameDocument(documents, f.name)?.filename).filter((x): x is string => !!x);
    if (same.length) {
      setReplacing(same);
      setQueue(list);
    } else void run(list);
  }

  async function run(list: File[]) {
    setQueue(null);
    setReplacing([]);
    const out: Notice[] = [];
    let changed = false;
    for (const [i, f] of list.entries()) {
      const pre = uploadPrecheck(f);
      if (pre) {
        out.push({ tone: "error", text: pre });
        continue;
      }
      setBusy(`Uploading and reading ${f.name}${list.length > 1 ? ` (${i + 1} of ${list.length})` : ""}…`);
      const r = await knowledgeClient.uploadFile(resourceId, f);
      out.push(uploadNotice(f.name, r));
      if (r.ok) changed = true;
      if (isForbiddenRole(r)) {
        onForbidden();
        break;
      }
    }
    setBusy(null);
    setNotices(out);
    if (fileRef.current) fileRef.current.value = "";
    if (changed) onChanged();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={inputId} className={`${btnPrimary} cursor-pointer ${busy ? "pointer-events-none opacity-60" : ""}`}>
          <FileUp className="h-4 w-4" aria-hidden /> Upload files
        </label>
        <input
          id={inputId}
          ref={fileRef}
          type="file"
          multiple
          accept={ACCEPT_ATTRIBUTE}
          className="sr-only"
          disabled={!!busy}
          onChange={(e) => pick(e.target.files)}
        />
        <p className="text-xs text-ink-500">{ACCEPTED_FILES_LABEL}, up to 10 MB each. Text is extracted on the server.</p>
      </div>
      {busy && (
        <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-ink-600">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {busy}
        </p>
      )}
      {notices.length > 0 && <div className="space-y-1">{notices.map((n, i) => <NoticeLine key={i} notice={n} />)}</div>}
      {queue && (
        <ConfirmModal
          title="Replace existing file?"
          body={
            <>
              <p>{REPLACE_CONFIRM}</p>
              <ul className="list-disc pl-5">
                {replacing.map((n) => (
                  <li key={n} className="break-all">
                    {n}
                  </li>
                ))}
              </ul>
            </>
          }
          confirmLabel="Upload and replace"
          onConfirm={() => void run(queue)}
          onClose={() => {
            setQueue(null);
            setReplacing([]);
            if (fileRef.current) fileRef.current.value = "";
          }}
        />
      )}
    </div>
  );
}

/** Add one or more web addresses to a URL resource; the server imports each page. */
export function UrlAdder({ resourceId, documents, onChanged, onForbidden }: { resourceId: string; documents: KnowledgeDocument[]; onChanged: () => void; onForbidden: () => void }) {
  const id = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const urls = [...new Set(text.split(/\s+/).map((u) => u.trim()).filter(Boolean))];
    if (!urls.length) {
      setNotices([{ tone: "error", text: "Enter at least one web address." }]);
      return;
    }
    const out: Notice[] = [];
    let changed = false;
    for (const [i, u] of urls.entries()) {
      const again = existingUrlDocument(documents, u);
      setBusy(`${again ? "Re-importing" : "Importing"} ${u}${urls.length > 1 ? ` (${i + 1} of ${urls.length})` : ""} — reading the website, this can take up to a minute…`);
      const r = await knowledgeClient.addUrl(resourceId, u);
      out.push(urlNotice(u, r));
      if (r.ok) changed = true;
      if (isForbiddenRole(r)) {
        onForbidden();
        break;
      }
    }
    setBusy(null);
    setNotices(out);
    if (out.every((n) => n.tone !== "error")) setText("");
    if (changed) onChanged();
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <div>
        <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-ink-700">
          Web addresses <span className="font-normal text-ink-400">(one per line)</span>
        </label>
        <textarea id={id} className={`${inputCls} min-h-[72px]`} placeholder="https://example-clinic.com/prices" value={text} onChange={(e) => setText(e.target.value)} disabled={!!busy} />
        <p className="mt-1 text-xs text-ink-500">Pydent imports the text of each website (and its linked pages on the same site). Only public websites can be imported.</p>
      </div>
      <button type="submit" disabled={!!busy} className={btnPrimary}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Globe className="h-4 w-4" aria-hidden />}
        Add URL
      </button>
      {busy && (
        <p role="status" aria-live="polite" className="text-sm text-ink-600">
          {busy}
        </p>
      )}
      {notices.length > 0 && <div className="space-y-1">{notices.map((n, i) => <NoticeLine key={i} notice={n} />)}</div>}
    </form>
  );
}

/**
 * Assigned-agents editor (Phase 1A): which of the workspace's agents this
 * resource is assigned to. Only the agent id is ever sent — the server resolves
 * the workspace from the session and refuses any agent or resource outside it.
 */
export function AssignedAgentsEditor({ resourceId, onChanged, onForbidden }: { resourceId: string; onChanged: () => void; onForbidden: () => void }) {
  const id = useId();
  const [agents, setAgents] = useState<ResourceAgents | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // "assign" or the agent id being unassigned
  const [notice, setNotice] = useState<Notice | null>(null);

  const load = useCallback(async () => {
    const r = await knowledgeClient.listAgents(resourceId);
    if (r.ok) {
      setAgents(r.data);
      setFailed(false);
    } else {
      setAgents(null);
      setFailed(true);
    }
  }, [resourceId]);

  useEffect(() => {
    // The agent list is this editor's external data source.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function assign(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !selected) return;
    setBusy("assign");
    setNotice(null);
    const r = await knowledgeClient.assignAgent(resourceId, selected);
    setBusy(null);
    if (isForbiddenRole(r)) return onForbidden();
    if (!r.ok) return setNotice({ tone: "error", text: actionError(r) });
    setSelected("");
    setNotice({ tone: "success", text: r.data.alreadyAssigned ? `${r.data.agent.name} was already assigned.` : `Assigned ${r.data.agent.name}.` });
    await load();
    onChanged();
  }

  async function unassign(agentId: string, name: string) {
    if (busy) return;
    setBusy(agentId);
    setNotice(null);
    const r = await knowledgeClient.unassignAgent(resourceId, agentId);
    setBusy(null);
    if (isForbiddenRole(r)) return onForbidden();
    if (!r.ok) return setNotice({ tone: "error", text: actionError(r) });
    setNotice({ tone: "success", text: `Unassigned ${name}.` });
    await load();
    onChanged();
  }

  if (failed) {
    return (
      <p className="text-sm text-ink-500">
        Couldn&apos;t load the agent list.{" "}
        <button type="button" onClick={() => void load()} className="font-medium text-brand-600">
          Retry
        </button>
      </p>
    );
  }
  if (!agents) return <p className="text-sm text-ink-500">Loading agents…</p>;

  const none = agents.assignedAgents.length === 0 && agents.availableAgents.length === 0;
  return (
    <div className="space-y-3">
      {none ? (
        <p className="text-sm text-ink-500">This workspace has no agents yet. Create an agent first, then assign this resource to it here.</p>
      ) : (
        <>
          {agents.assignedAgents.length === 0 ? (
            <p className="text-sm text-ink-500">Not assigned to any agent yet.</p>
          ) : (
            <ul className="divide-y divide-ink-100">
              {agents.assignedAgents.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2 py-2">
                  <span className="min-w-0 break-words text-sm font-medium text-ink-800">{a.name}</span>
                  <button type="button" onClick={() => void unassign(a.id, a.name)} disabled={!!busy} className={`${btnSecondary} shrink-0 text-rose-600`}>
                    {busy === a.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Unassign
                  </button>
                </li>
              ))}
            </ul>
          )}
          {agents.availableAgents.length > 0 && (
            <form onSubmit={assign} className="flex flex-col gap-2 sm:flex-row sm:items-end" noValidate>
              <div className="min-w-0 flex-1">
                <label htmlFor={`${id}-agent`} className="mb-1.5 block text-sm font-medium text-ink-700">
                  Assign an agent
                </label>
                <select id={`${id}-agent`} className={inputCls} value={selected} onChange={(e) => setSelected(e.target.value)} disabled={!!busy}>
                  <option value="">Choose an agent…</option>
                  {agents.availableAgents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <button type="submit" disabled={!!busy || !selected} className={btnPrimary}>
                {busy === "assign" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Assign
              </button>
            </form>
          )}
          {agents.availableAgents.length === 0 && agents.assignedAgents.length > 0 && (
            <p className="text-xs text-ink-400">Every agent in this workspace is already assigned.</p>
          )}
        </>
      )}
      {notice && <NoticeLine notice={notice} />}
    </div>
  );
}

// ------------------------------------------------------------------ tester

/**
 * Knowledge Tester: pick resources, ask a question. Only the selection and the
 * question are sent; the model and prompt are fixed on the server. Shows the
 * answer (or why there isn't one) and the matched sources as ~200-char previews.
 */
export function TesterModal({ resources, preselected = [], onClose }: { resources: KnowledgeResource[]; preselected?: string[]; onClose: () => void }) {
  const ids = useId();
  const [selected, setSelected] = useState<string[]>(preselected.filter((id) => resources.some((r) => r.id === id)));
  const [filter, setFilter] = useState("");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TesterResult | null>(null);
  useEscape(onClose, !busy);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return resources.filter((r) => !q || r.name.toLowerCase().includes(q));
  }, [resources, filter]);
  const view = result ? testerView(result) : null;

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const pre = testerPrecheck(selected, question);
    if (pre) {
      setError(pre);
      return;
    }
    setBusy(true);
    setError(null);
    const r = await knowledgeClient.test(selected, question.trim());
    setBusy(false);
    if (r.ok) setResult(r.data);
    else {
      setResult(null);
      setError(r.status === 404 ? "One or more selected resources no longer exist. Reload and select again." : actionError(r as ApiError));
    }
  }

  return (
    <Modal open onClose={busy ? () => {} : onClose} title="Test knowledge" subtitle="Ask a question and see what the selected resources say. This tests knowledge only — not an agent." wide>
      <form onSubmit={ask} className="space-y-4" noValidate>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-ink-700">
            Resources to search <span className="font-normal text-ink-400">({selected.length} selected, up to {TESTER_MAX_RESOURCES})</span>
          </legend>
          {resources.length === 0 ? (
            <p className="text-sm text-ink-500">There are no knowledge resources to test yet.</p>
          ) : (
            <>
              {resources.length > 6 && (
                <div className="mb-2 flex items-center gap-2 rounded-xl border border-ink-200 px-3 py-2">
                  <Search className="h-4 w-4 text-ink-400" aria-hidden />
                  <label htmlFor={`${ids}-filter`} className="sr-only">
                    Filter resources
                  </label>
                  <input id={`${ids}-filter`} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter resources" className="w-full bg-transparent text-sm outline-none" />
                </div>
              )}
              <div className="grid max-h-48 gap-1.5 overflow-y-auto sm:grid-cols-2">
                {visible.map((r) => (
                  <label key={r.id} className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${selected.includes(r.id) ? "border-brand-400 bg-brand-50" : "border-ink-200"}`}>
                    <input type="checkbox" checked={selected.includes(r.id)} onChange={() => toggle(r.id)} className="h-4 w-4 accent-[#7c3aed]" />
                    <span className="min-w-0 flex-1 truncate text-ink-800">{r.name}</span>
                    <TypeBadge type={r.type} />
                  </label>
                ))}
              </div>
            </>
          )}
        </fieldset>
        <div>
          <label htmlFor={`${ids}-q`} className="mb-1.5 block text-sm font-medium text-ink-700">
            Question
          </label>
          <textarea
            id={`${ids}-q`}
            className={`${inputCls} min-h-[72px]`}
            value={question}
            maxLength={TESTER_MAX_QUESTION}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. How much does teeth whitening cost?"
          />
        </div>
        {error && <NoticeLine notice={{ tone: "error", text: error }} />}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className={btnSecondary}>
            Close
          </button>
          <button type="submit" disabled={busy || resources.length === 0} className={btnPrimary}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <FlaskConical className="h-4 w-4" aria-hidden />}
            {busy ? "Searching…" : "Test"}
          </button>
        </div>
      </form>

      {view && (
        <section aria-live="polite" className="mt-6 space-y-4 border-t border-ink-200 pt-5">
          <div
            className={`rounded-xl border px-4 py-3 ${
              view.tone === "success" ? "border-emerald-500/30 bg-emerald-500/10" : view.tone === "warning" ? "border-amber-500/30 bg-amber-500/10" : "border-ink-200 bg-ink-50"
            }`}
          >
            <h3 className="text-sm font-semibold text-ink-900">{view.heading}</h3>
            {view.answer && <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-ink-800">{view.answer}</p>}
            {view.note && <p className="mt-1.5 text-xs text-ink-600">{view.note}</p>}
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-ink-900">
              Matched knowledge <span className="font-normal text-ink-400">({view.sources.length})</span>
            </h3>
            {view.sources.length === 0 ? (
              <p className="text-sm text-ink-500">No matching passages.</p>
            ) : (
              <ol className="space-y-2">
                {view.sources.map((s) => (
                  <li key={s.key} className="rounded-xl border border-ink-200 px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-500">
                      <span className="font-semibold text-ink-700">#{s.rank}</span>
                      <span className="font-medium text-ink-800">{s.resourceName}</span>
                      <span aria-hidden>·</span>
                      <span className="min-w-0 break-all">{s.documentLabel}</span>
                      {s.section !== s.documentLabel && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="break-all">{s.section}</span>
                        </>
                      )}
                      <span aria-hidden>·</span>
                      <span>Part {s.chunk}</span>
                      <span className="ml-auto rounded-full bg-ink-100 px-2 py-0.5 font-medium text-ink-600">Score {s.score}</span>
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-ink-700">{s.preview}
                      {s.truncated && "…"}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
      )}
    </Modal>
  );
}
