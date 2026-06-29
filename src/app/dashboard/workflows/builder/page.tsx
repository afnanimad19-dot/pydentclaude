"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Zap,
  MessageSquare,
  GitBranch,
  Bot,
  Clock,
  PlugZap,
  UserRound,
  Plus,
  Trash2,
  Save,
  ChevronDown,
} from "lucide-react";
import { toast } from "@/components/toast";
import { fetchWorkflow, saveWorkflow, fetchAgents, fetchVoiceNumbers, type WorkflowNode, type AiAgent, type VoiceNumber } from "@/lib/db";
import { WORKFLOW_TEMPLATES } from "@/lib/workflow-templates";

const NODE_META: Record<WorkflowNode["type"], { icon: typeof Zap; label: string; chip: string }> = {
  trigger: { icon: Zap, label: "Trigger", chip: "bg-amber-500/15 text-amber-500" },
  message: { icon: MessageSquare, label: "Send message", chip: "bg-emerald-500/15 text-emerald-500" },
  condition: { icon: GitBranch, label: "Condition", chip: "bg-blue-500/15 text-blue-500" },
  agent: { icon: Bot, label: "AI agent", chip: "bg-brand-500/15 text-brand-500" },
  wait: { icon: Clock, label: "Wait", chip: "bg-ink-300/30 text-ink-500" },
  action: { icon: PlugZap, label: "Action", chip: "bg-violet-500/15 text-violet-500" },
  handoff: { icon: UserRound, label: "Human handoff", chip: "bg-rose-500/15 text-rose-500" },
};

const ADDABLE: WorkflowNode["type"][] = ["message", "condition", "agent", "wait", "action", "handoff"];

const DEFAULTS: Record<WorkflowNode["type"], { title: string; detail: string; config?: Record<string, unknown> }> = {
  trigger: { title: "Trigger: conversation opened", detail: "A contact starts a conversation", config: { event: "conversation_opened" } },
  message: { title: "Send message", detail: "Hi {{first_name}}! …" },
  condition: { title: "Condition", detail: "Only continue if the message mentions a keyword", config: { contains: "" } },
  agent: { title: "AI agent takes over", detail: "Assigned chat agent answers from its knowledge base" },
  wait: { title: "Wait", detail: "Wait before the next step", config: { amount: 1, unit: "days" } },
  action: { title: "Action", detail: "Add to pipeline / tag the contact", config: { action: "add_to_pipeline", value: "" } },
  handoff: { title: "Human handoff", detail: "Assign to the Front Desk inbox with full context" },
};

function newNode(type: WorkflowNode["type"]): WorkflowNode {
  return { id: `n-${Date.now()}-${Math.floor(Math.random() * 1000)}`, type, ...DEFAULTS[type] };
}

export default function WorkflowBuilderPage() {
  const params = useSearchParams();
  const editId = params.get("id");
  const templateKey = params.get("template");
  // Templates are available synchronously, so prefill via lazy initializers
  const template = templateKey ? WORKFLOW_TEMPLATES.find((x) => x.key === templateKey) : undefined;

  const [name, setName] = useState(template?.name ?? "Untitled workflow");
  const [channel, setChannel] = useState(template?.channel ?? "whatsapp");
  const [status, setStatus] = useState<"Live" | "Paused" | "Draft">("Draft");
  const [nodes, setNodes] = useState<WorkflowNode[]>(() =>
    template
      ? // Fresh ids so edits don't collide between uses of the same template
        template.nodes.map((node) => ({ ...node, id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }))
      : [newNode("trigger")]
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addAfter, setAddAfter] = useState<number | null>(null);
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [voiceAgents, setVoiceAgents] = useState<AiAgent[]>([]);
  const [voiceNumbers, setVoiceNumbers] = useState<VoiceNumber[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(editId);

  useEffect(() => {
    fetchAgents().then((r) => {
      setAgents(r.agents.filter((a) => a.kind === "chat"));
      setVoiceAgents(r.agents.filter((a) => a.kind === "voice"));
    });
    fetchVoiceNumbers().then(setVoiceNumbers);
    if (editId) {
      fetchWorkflow(editId).then((w) => {
        if (!w) return;
        setName(w.name);
        setChannel(w.channel);
        setStatus(w.status);
        setNodes(w.nodes.length ? w.nodes : [newNode("trigger")]);
      });
    }
  }, [editId]);

  const selected = nodes.find((node) => node.id === selectedId) ?? null;

  function updateSelected(patch: Partial<WorkflowNode>) {
    setNodes((prev) => prev.map((node) => (node.id === selectedId ? { ...node, ...patch } : node)));
  }

  function setCfg(patch: Record<string, unknown>) {
    setNodes((prev) => prev.map((node) => (node.id === selectedId ? { ...node, config: { ...node.config, ...patch } } : node)));
  }

  function insertNode(index: number, type: WorkflowNode["type"]) {
    const node = newNode(type);
    setNodes((prev) => [...prev.slice(0, index + 1), node, ...prev.slice(index + 1)]);
    setSelectedId(node.id);
    setAddAfter(null);
  }

  function removeNode(id: string) {
    setNodes((prev) => prev.filter((node) => node.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  async function save() {
    if (!name.trim()) {
      toast("Give the workflow a name.", "info");
      return;
    }
    setSaving(true);
    const res = await saveWorkflow({ name, channel, status, nodes }, savedId ?? undefined);
    setSaving(false);
    if (res.ok) {
      if (res.id) setSavedId(res.id);
      toast(`Workflow saved${status === "Live" ? " and live" : ""}.`);
    } else {
      toast(`Could not save: ${res.message} — run migration 0005 in the SQL Editor.`, "info");
    }
  }

  return (
    <div className="-m-6 flex h-[calc(100vh-4rem)]">
      {/* Canvas */}
      <div
        className="relative flex-1 overflow-auto"
        style={{
          backgroundImage: "radial-gradient(circle, var(--ink-200) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
        }}
        onClick={() => {
          setSelectedId(null);
          setAddAfter(null);
        }}
      >
        {/* Top bar */}
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-ink-200 bg-surface/90 px-5 py-3 backdrop-blur">
          <div className="flex items-center gap-3">
            <Link href="/dashboard/workflows" className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100">
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              className="rounded-lg border border-transparent bg-transparent px-2 py-1 text-base font-semibold text-ink-900 outline-none hover:border-ink-200 focus:border-brand-400"
            />
          </div>
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-sm capitalize text-ink-700 outline-none"
            >
              {["whatsapp", "instagram", "sms", "email"].map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
              className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-sm text-ink-700 outline-none"
            >
              <option>Draft</option>
              <option>Live</option>
              <option>Paused</option>
            </select>
            <button
              onClick={save}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              <Save className="h-4 w-4" /> {saving ? "Saving…" : "Save workflow"}
            </button>
          </div>
        </div>

        {/* Node chain */}
        <div className="mx-auto flex max-w-md flex-col items-center px-6 py-10">
          {nodes.map((node, i) => {
            const meta = NODE_META[node.type];
            return (
              <div key={node.id} className="flex w-full flex-col items-center">
                <div
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedId(node.id);
                  }}
                  className={`w-full cursor-pointer rounded-2xl border-2 bg-surface p-4 shadow-sm transition-all ${
                    selectedId === node.id ? "border-brand-500 shadow-lg shadow-brand-500/10" : "border-ink-200 hover:border-ink-300"
                  } ${node.type === "trigger" ? "border-amber-400/60" : ""}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className={`rounded-lg p-1.5 ${meta.chip}`}>
                        <meta.icon className="h-4 w-4" />
                      </span>
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{meta.label}</span>
                    </div>
                    {node.type !== "trigger" && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeNode(node.id);
                        }}
                        className="rounded p-1 text-ink-300 hover:text-rose-500"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <p className="mt-2 text-sm font-semibold text-ink-900">{node.title}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-ink-500">{node.detail}</p>
                </div>

                {/* Connector + insert */}
                <div className="relative flex flex-col items-center py-1">
                  <div className="h-4 w-px bg-ink-300" />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setAddAfter(addAfter === i ? null : i);
                    }}
                    className="z-[5] flex h-6 w-6 items-center justify-center rounded-full border border-ink-300 bg-surface text-ink-400 transition-colors hover:border-brand-400 hover:text-brand-500"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                  {addAfter === i && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="absolute top-8 z-20 w-52 rounded-xl border border-ink-200 bg-surface p-1.5 shadow-xl"
                    >
                      {ADDABLE.map((t) => {
                        const m = NODE_META[t];
                        return (
                          <button
                            key={t}
                            onClick={() => insertNode(i, t)}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-ink-700 hover:bg-ink-50"
                          >
                            <span className={`rounded-md p-1 ${m.chip}`}>
                              <m.icon className="h-3.5 w-3.5" />
                            </span>
                            {m.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {i < nodes.length - 1 && (
                    <>
                      <div className="h-4 w-px bg-ink-300" />
                      <ChevronDown className="-mt-1.5 h-4 w-4 text-ink-300" />
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {nodes.length <= 1 && (
            <p className="mt-2 max-w-xs text-center text-xs text-ink-400">
              Click the + button to add steps: send messages, conditions, AI agents, waits, actions and handoffs.
            </p>
          )}
        </div>
      </div>

      {/* Side editor panel */}
      <div className="w-80 shrink-0 overflow-y-auto border-l border-ink-200 bg-surface p-5">
        {selected ? (
          <>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Edit step</p>
            <div className="mt-4 space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-ink-700">Step type</span>
                <select
                  value={selected.type}
                  disabled={selected.type === "trigger"}
                  onChange={(e) => {
                    const t = e.target.value as WorkflowNode["type"];
                    updateSelected({ type: t, ...(selected.title === DEFAULTS[selected.type].title ? DEFAULTS[t] : {}) });
                  }}
                  className="w-full rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-900 outline-none disabled:opacity-60"
                >
                  {(selected.type === "trigger" ? ["trigger" as const] : ADDABLE).map((t) => (
                    <option key={t} value={t}>{NODE_META[t].label}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-ink-700">Title</span>
                <input
                  value={selected.title}
                  onChange={(e) => updateSelected({ title: e.target.value })}
                  className="w-full rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-900 outline-none focus:border-brand-400"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-ink-700">
                  {selected.type === "message" ? "Message text" : selected.type === "condition" ? "Condition logic" : "Details"}
                </span>
                <textarea
                  rows={5}
                  value={selected.detail}
                  onChange={(e) => updateSelected({ detail: e.target.value })}
                  className="w-full rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-900 outline-none focus:border-brand-400"
                />
              </label>
              {selected.type === "agent" && (
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-ink-700">Which agent?</span>
                  <select
                    onChange={(e) => {
                      const a = agents.find((x) => x.id === e.target.value);
                      if (a) updateSelected({ title: `AI agent: ${a.name}`, detail: `${a.name} (${a.role}) answers from its knowledge base` });
                    }}
                    className="w-full rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-900 outline-none"
                    defaultValue=""
                  >
                    <option value="" disabled>Choose agent…</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>{a.name} — {a.role}</option>
                    ))}
                  </select>
                </label>
              )}
              {selected.type === "message" && (
                <p className="rounded-xl bg-ink-50 px-3 py-2.5 text-xs leading-relaxed text-ink-500">
                  Merge fields: {"{{first_name}}"}, {"{{name}}"}, {"{{phone}}"} — these are filled from the contact when the workflow runs.
                </p>
              )}

              {selected.type === "trigger" && (
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-ink-700">Starts when…</span>
                  <select
                    value={selected.config?.event ?? "conversation_opened"}
                    onChange={(e) => setCfg({ event: e.target.value })}
                    className="w-full rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-900 outline-none"
                  >
                    <option value="conversation_opened">A contact opens a conversation</option>
                    <option value="new_lead">A new lead is captured</option>
                    <option value="appointment_booked">An appointment is booked</option>
                    <option value="manual">Manually / test run only</option>
                  </select>
                </label>
              )}

              {selected.type === "wait" && (
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="mb-1.5 block text-sm font-medium text-ink-700">Wait</span>
                    <input
                      type="number"
                      min={1}
                      value={selected.config?.amount ?? 1}
                      onChange={(e) => setCfg({ amount: Math.max(1, Number(e.target.value) || 1) })}
                      className="w-full rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-900 outline-none"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-sm font-medium text-ink-700">Unit</span>
                    <select
                      value={selected.config?.unit ?? "days"}
                      onChange={(e) => setCfg({ unit: e.target.value })}
                      className="w-full rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-900 outline-none"
                    >
                      <option value="minutes">minutes</option>
                      <option value="hours">hours</option>
                      <option value="days">days</option>
                    </select>
                  </label>
                </div>
              )}

              {selected.type === "condition" && (
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-ink-700">Continue only if the message contains</span>
                  <input
                    value={selected.config?.contains ?? ""}
                    onChange={(e) => setCfg({ contains: e.target.value })}
                    placeholder="e.g. book, price, appointment"
                    className="w-full rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-900 outline-none focus:border-brand-400"
                  />
                </label>
              )}

              {selected.type === "action" && (
                <div className="space-y-3">
                  <label className="block">
                    <span className="mb-1.5 block text-sm font-medium text-ink-700">Action</span>
                    <select
                      value={selected.config?.action ?? "add_to_pipeline"}
                      onChange={(e) => setCfg({ action: e.target.value })}
                      className="w-full rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-900 outline-none"
                    >
                      <option value="add_to_pipeline">Add the contact to the pipeline</option>
                      <option value="tag">Set the contact&apos;s status</option>
                      <option value="call">Place a voice call (AI agent)</option>
                      <option value="none">Do nothing (placeholder)</option>
                    </select>
                  </label>
                  {selected.config?.action === "tag" && (
                    <label className="block">
                      <span className="mb-1.5 block text-sm font-medium text-ink-700">Set status to</span>
                      <select
                        value={selected.config?.value ?? "Active"}
                        onChange={(e) => setCfg({ value: e.target.value })}
                        className="w-full rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-900 outline-none"
                      >
                        <option>New</option>
                        <option>Active</option>
                        <option>Inactive</option>
                      </select>
                    </label>
                  )}
                  {selected.config?.action === "add_to_pipeline" && (
                    <label className="block">
                      <span className="mb-1.5 block text-sm font-medium text-ink-700">Pipeline stage</span>
                      <input
                        value={String(selected.config?.value ?? "")}
                        onChange={(e) => setCfg({ value: e.target.value })}
                        placeholder="New Lead"
                        className="w-full rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-900 outline-none"
                      />
                    </label>
                  )}
                  {selected.config?.action === "call" && (
                    <div className="space-y-3">
                      <label className="block">
                        <span className="mb-1.5 block text-sm font-medium text-ink-700">Voice agent (answers the call)</span>
                        <select
                          value={String(selected.config?.agentId ?? "")}
                          onChange={(e) => setCfg({ agentId: e.target.value })}
                          className="w-full rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-900 outline-none"
                        >
                          <option value="">Choose a voice agent…</option>
                          {voiceAgents.map((a) => <option key={a.id} value={a.id}>{a.name} — {a.role}</option>)}
                        </select>
                      </label>
                      <label className="block">
                        <span className="mb-1.5 block text-sm font-medium text-ink-700">Caller number</span>
                        <select
                          value={String(selected.config?.numberId ?? "")}
                          onChange={(e) => setCfg({ numberId: e.target.value })}
                          className="w-full rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-900 outline-none"
                        >
                          <option value="">Choose a number…</option>
                          {voiceNumbers.map((n) => <option key={n.id} value={n.id}>{n.number}{n.nickname ? ` (${n.nickname})` : ""}</option>)}
                        </select>
                      </label>
                      <p className="rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-500">The agent calls the contact&apos;s phone number on this step. The agent must be synced to Vapi and the number registered (assign it in Voice Agent Settings).</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <Zap className="h-8 w-8 text-ink-300" />
            <p className="mt-3 text-sm font-medium text-ink-600">Select a step to edit it</p>
            <p className="mt-1 max-w-[200px] text-xs text-ink-400">
              Or click a + button on the canvas to insert a new step at that point.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
