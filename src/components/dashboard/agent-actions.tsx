"use client";

// Agent card "…" menu: Rename, Duplicate, Delete. Every action goes through the
// protected server routes /api/agents/[id]/* (owner / manager only; workspace
// from the session). Nothing here touches phone numbers, LiveKit or any
// provider — those checks and guarantees live server-side in
// lib/agent-management.ts.

import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, Pencil, Copy, Trash2, AlertTriangle, Loader2 } from "lucide-react";
import { Modal, Field, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import { authFetch } from "@/lib/auth-fetch";
import { MAX_AGENT_NAME_LENGTH, RESERVED_AGENT_NAME, NOVA_SYSTEM_MANAGED_MESSAGE, defaultDuplicateName, isSystemManagedNova } from "@/lib/agent-management";
import type { AiAgent } from "@/lib/db";

type Action = "rename" | "duplicate" | "delete" | null;

async function callApi(url: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  try {
    const res = await authFetch(url, init);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok && data.ok !== false, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "Could not reach the server. No changes were made." } };
  }
}

const errorOf = (d: Record<string, unknown>) => String(d.error ?? d.message ?? "Something went wrong. No changes were made.");

function localNameProblem(raw: string): string | null {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) return "Enter a name for the agent.";
  if (name.length > MAX_AGENT_NAME_LENGTH) return `Keep the name to ${MAX_AGENT_NAME_LENGTH} characters or fewer.`;
  return null;
}

function Buttons({ onCancel, onSubmit, label, busy, disabled, destructive }: { onCancel: () => void; onSubmit: () => void; label: string; busy: boolean; disabled?: boolean; destructive?: boolean }) {
  return (
    <div className="mt-6 flex justify-end gap-2">
      <button onClick={onCancel} className="rounded-xl border border-ink-200 px-4 py-2.5 text-sm font-semibold text-ink-700 hover:bg-ink-50">
        Cancel
      </button>
      <button
        onClick={onSubmit}
        disabled={busy || disabled}
        className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 ${destructive ? "bg-rose-600 hover:bg-rose-700" : "bg-brand-600 hover:bg-brand-700"}`}
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />} {label}
      </button>
    </div>
  );
}

function ErrorNote({ text }: { text: string | null }) {
  if (!text) return null;
  return <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{text}</p>;
}

// ------------------------------------------------------------------ rename

function RenameModal({ agent, onClose, onDone }: { agent: AiAgent; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(agent.name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const systemManaged = isSystemManagedNova(agent);

  async function submit() {
    if (systemManaged) return setErr(NOVA_SYSTEM_MANAGED_MESSAGE);
    const problem = localNameProblem(name);
    if (problem) return setErr(problem);
    setBusy(true);
    setErr(null);
    const r = await callApi(`/api/agents/${agent.id}/rename`, { method: "POST", body: JSON.stringify({ name }) });
    setBusy(false);
    if (!r.ok) return setErr(errorOf(r.data));
    toast(String(r.data.message ?? "Agent renamed."));
    onDone();
  }

  return (
    <Modal open onClose={onClose} title="Rename agent">
      <p className="text-sm text-ink-600">
        Current name: <strong className="font-semibold text-ink-900">{agent.name}</strong>
      </p>
      <div className="mt-4">
        <Field label="New name">
          <input className={inputCls} value={name} maxLength={MAX_AGENT_NAME_LENGTH + 20} autoFocus disabled={systemManaged} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        </Field>
      </div>
      <p className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        The agent may introduce itself using this new name on its next call. Phone routing, LiveKit and provider settings are not changed.
      </p>
      {systemManaged && <ErrorNote text={NOVA_SYSTEM_MANAGED_MESSAGE} />}
      <ErrorNote text={systemManaged ? null : err} />
      <Buttons onCancel={onClose} onSubmit={submit} label="Rename" busy={busy} disabled={systemManaged} />
    </Modal>
  );
}

// ------------------------------------------------------------------ duplicate

const SECTION_LABELS = [
  ["instructions", "Instructions & prompts"],
  ["voice", "Voice/model settings"],
  ["tools", "Tools"],
  ["knowledge", "Knowledge base"],
  ["callEnding", "Call-ending settings"],
] as const;

function DuplicateModal({ agent, onClose, onDone }: { agent: AiAgent; onClose: () => void; onDone: () => void }) {
  const suggested = defaultDuplicateName(agent.name);
  const [name, setName] = useState(suggested);
  const [sections, setSections] = useState<Record<string, boolean>>({ instructions: true, voice: true, tools: true, knowledge: true, callEnding: true });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reservedSource = RESERVED_AGENT_NAME.test(agent.name);

  async function submit() {
    const problem = localNameProblem(name);
    if (problem) return setErr(problem);
    setBusy(true);
    setErr(null);
    const r = await callApi(`/api/agents/${agent.id}/duplicate`, { method: "POST", body: JSON.stringify({ name, sections }) });
    setBusy(false);
    if (!r.ok) return setErr(errorOf(r.data));
    toast(String(r.data.message ?? "Agent duplicated."));
    onDone();
  }

  return (
    <Modal open onClose={onClose} title={`Duplicate ${agent.name}`}>
      <Field label="New agent name">
        <input className={inputCls} value={name} maxLength={MAX_AGENT_NAME_LENGTH + 20} autoFocus placeholder="Enter a name" onChange={(e) => setName(e.target.value)} />
      </Field>
      {reservedSource && (
        <p className="mt-2 text-xs text-amber-700">Names containing &quot;Nova&quot; or &quot;Phoenix&quot; are reserved for the built-in Nova agent — enter a different name for the copy.</p>
      )}
      <p className="mt-4 mb-2 text-sm font-medium text-ink-700">Copy:</p>
      <div className="space-y-2">
        {SECTION_LABELS.map(([key, label]) => (
          <label key={key} className="flex items-center gap-2 text-sm text-ink-700">
            <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={sections[key]} onChange={(e) => setSections((s) => ({ ...s, [key]: e.target.checked }))} />
            {label}
          </label>
        ))}
      </div>
      <p className="mt-4 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
        Phone routing and provider routing are never copied. The copy is created as a <strong>Draft</strong> that runs on the Pydent worker — it is not bound to any LiveKit console agent.
      </p>
      <ErrorNote text={err} />
      <Buttons onCancel={onClose} onSubmit={submit} label="Duplicate" busy={busy} />
    </Modal>
  );
}

// ------------------------------------------------------------------ delete

interface DeleteCheck {
  blockers: { code: string; message: string }[];
  requiresTypedConfirmation: boolean;
  typedConfirmationReasons: string[];
  cascade: { conversationAssignments: number; followUps: number };
}

function DeleteModal({ agent, onClose, onDone }: { agent: AiAgent; onClose: () => void; onDone: () => void }) {
  const [check, setCheck] = useState<DeleteCheck | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    callApi(`/api/agents/${agent.id}/delete`).then((r) => {
      if (!live) return;
      if (!r.ok) setLoadErr(errorOf(r.data));
      else setCheck(r.data as unknown as DeleteCheck);
    });
    return () => {
      live = false;
    };
  }, [agent.id]);

  async function submit() {
    setBusy(true);
    setErr(null);
    const r = await callApi(`/api/agents/${agent.id}/delete`, { method: "POST", body: JSON.stringify({ confirm: true, confirmName: typed }) });
    setBusy(false);
    if (!r.ok) {
      const blockers = Array.isArray(r.data.blockers) ? (r.data.blockers as DeleteCheck["blockers"]) : null;
      if (blockers && check) setCheck({ ...check, blockers });
      return setErr(errorOf(r.data));
    }
    toast(String(r.data.message ?? "Agent deleted."));
    onDone();
  }

  const blocked = !!check && check.blockers.length > 0;
  const typedOk = !check?.requiresTypedConfirmation || typed.trim() === agent.name;
  const cascadeTotal = check ? check.cascade.conversationAssignments + check.cascade.followUps : 0;

  return (
    <Modal open onClose={onClose} title={blocked ? `Cannot delete ${agent.name}` : `Delete ${agent.name}?`}>
      {!check && !loadErr && (
        <p className="flex items-center gap-2 text-sm text-ink-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking phone numbers and LiveKit routing…
        </p>
      )}
      {loadErr && (
        <>
          <ErrorNote text={loadErr} />
          <div className="mt-6 flex justify-end">
            <button onClick={onClose} className="rounded-xl border border-ink-200 px-4 py-2.5 text-sm font-semibold text-ink-700 hover:bg-ink-50">Close</button>
          </div>
        </>
      )}
      {check && blocked && (
        <>
          <ul className="space-y-2">
            {check.blockers.map((b) => (
              <li key={b.code} className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {b.message}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-500">Nothing was changed. Pydent never reassigns numbers or edits LiveKit routing automatically.</p>
          <div className="mt-6 flex justify-end">
            <button onClick={onClose} className="rounded-xl border border-ink-200 px-4 py-2.5 text-sm font-semibold text-ink-700 hover:bg-ink-50">Close</button>
          </div>
        </>
      )}
      {check && !blocked && (
        <>
          <p className="text-sm text-ink-700">This removes the agent from Pydent.</p>
          <p className="mt-2 text-sm text-ink-600">
            It does not delete LiveKit trunks, dispatch rules, phone-number routes, or external provider resources.
          </p>
          {cascadeTotal > 0 && (
            <p className="mt-3 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
              Also removed with it: {check.cascade.conversationAssignments} conversation assignment(s) and {check.cascade.followUps} follow-up(s) owned by this agent. Call logs are kept.
            </p>
          )}
          {check.requiresTypedConfirmation && (
            <div className="mt-4">
              <p className="mb-2 text-xs text-ink-600">This agent is {check.typedConfirmationReasons.join("; ")}. Type its name to confirm:</p>
              <input className={inputCls} value={typed} placeholder={agent.name} onChange={(e) => setTyped(e.target.value)} />
            </div>
          )}
          <ErrorNote text={err} />
          <Buttons onCancel={onClose} onSubmit={submit} label="Delete agent" busy={busy} disabled={!typedOk} destructive />
        </>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ menu

export function AgentActionsMenu({ agent, onChanged }: { agent: AiAgent; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<Action>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (a: Action) => {
    setOpen(false);
    setAction(a);
  };
  const done = () => {
    setAction(null);
    onChanged();
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="More actions"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-full items-center justify-center rounded-xl border border-ink-200 px-3 py-2 text-ink-500 hover:bg-ink-50"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div role="menu" className="absolute bottom-full right-0 z-20 mb-2 w-40 overflow-hidden rounded-xl border border-ink-200 bg-surface py-1 shadow-lg">
          <button role="menuitem" onClick={() => pick("rename")} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-700 hover:bg-ink-50">
            <Pencil className="h-4 w-4" /> Rename
          </button>
          <button role="menuitem" onClick={() => pick("duplicate")} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-700 hover:bg-ink-50">
            <Copy className="h-4 w-4" /> Duplicate
          </button>
          <div className="my-1 border-t border-ink-100" />
          <button role="menuitem" onClick={() => pick("delete")} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-rose-600 hover:bg-rose-500/10">
            <Trash2 className="h-4 w-4" /> Delete
          </button>
        </div>
      )}
      {action === "rename" && <RenameModal agent={agent} onClose={() => setAction(null)} onDone={done} />}
      {action === "duplicate" && <DuplicateModal agent={agent} onClose={() => setAction(null)} onDone={done} />}
      {action === "delete" && <DeleteModal agent={agent} onClose={() => setAction(null)} onDone={done} />}
    </div>
  );
}
