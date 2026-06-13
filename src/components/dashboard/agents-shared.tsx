"use client";

// Shared building blocks for the AI Agents section: agent grid, create/edit
// modal, in-browser test chat (OpenRouter) and test call (Vapi Web SDK),
// and the Agent Hub (channel defaults + phone lines).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  PhoneCall,
  Plus,
  MessageCircle,
  BookOpen,
  Send,
  Sparkles,
  CalendarCheck2,
  RefreshCcw,
  XCircle,
  Pencil,
  FileText,
  Upload,
  Trash2,
  Camera,
  Mail,
  MessageSquareText,
  Mic,
  PhoneOff,
  MessagesSquare,
} from "lucide-react";
import { Card, PageHeader, DemoBanner, StatusBadge } from "@/components/ui";
import { Modal, Field, ModalFooter, inputCls } from "@/components/modal";
import {
  fetchAgents,
  createAgent,
  updateAgent,
  updateAgentStatus,
  setAgentVapiId,
  fetchChannelDefaults,
  setChannelDefault,
  fetchPhoneLines,
  addPhoneLine,
  removePhoneLine,
  type AiAgent,
  type DataSource,
  type ChannelDefault,
  type PhoneLine,
} from "@/lib/db";

const OPENAI_MODELS = ["openai/gpt-4o-mini", "openai/gpt-4o", "openai/gpt-4.1", "openai/gpt-4.1-mini"];
const ANTHROPIC_MODELS = ["anthropic/claude-3.5-haiku", "anthropic/claude-sonnet-4", "anthropic/claude-opus-4.1"];
const VAPI_MODELS = ["gpt-4o-mini", "gpt-4o", "gpt-4.1"];

const VOICES = [
  "Warm female · US English",
  "Friendly male · US English",
  "Neutral female · US English",
  "Calm male · US English",
];

// Mirrors the server-side mapping in /api/vapi/assistants
const VOICE_IDS: Record<string, string> = {
  "Warm female · US English": "Leah",
  "Friendly male · US English": "Elliot",
  "Neutral female · US English": "Savannah",
  "Calm male · US English": "Rohan",
};

const VAPI_PUBLIC_KEY =
  process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY ?? "5cdbcfe9-1819-48ae-bac0-38a1db8a6a9d";

const LANGUAGES = [
  "English", "Spanish", "Arabic", "French", "Portuguese", "German", "Italian", "Mandarin Chinese",
  "Hindi", "Urdu", "Bengali", "Russian", "Japanese", "Korean", "Turkish", "Vietnamese",
  "Indonesian", "Dutch", "Polish", "Tagalog", "English + Spanish",
];

const ROLES = ["Receptionist", "Sales", "Appointment setter", "Follow-up"] as const;

const ABILITIES_BY_ROLE: Record<string, ("canBook" | "canReschedule" | "canCancel")[]> = {
  Receptionist: ["canBook", "canReschedule", "canCancel"],
  Sales: ["canBook"],
  "Appointment setter": ["canBook", "canReschedule", "canCancel"],
  "Follow-up": ["canBook", "canReschedule"],
  "Knowledge base": ["canBook", "canReschedule", "canCancel"],
};

const CHAT_CHANNELS = ["whatsapp", "instagram", "messenger", "sms", "email"] as const;

const CHANNEL_ICONS: Record<string, typeof MessageCircle> = {
  whatsapp: MessageCircle,
  instagram: Camera,
  messenger: MessagesSquare,
  sms: MessageSquareText,
  email: Mail,
};

function emptyForm(): Omit<AiAgent, "id" | "vapiAssistantId"> {
  return {
    name: "",
    kind: "chat",
    role: "Receptionist",
    status: "Draft",
    model: OPENAI_MODELS[0],
    voice: VOICES[0],
    firstMessage: "",
    language: "English",
    instructions: "",
    knowledgeBase: "",
    canBook: true,
    canReschedule: true,
    canCancel: false,
    channels: ["whatsapp"],
    purpose: "both",
    firstMessageMode: "assistant_first",
    kbFiles: [],
  };
}

// ---------------------------------------------------------------- main view

export function AgentsView({
  filter,
  title,
  subtitle,
  defaultKind = "chat",
}: {
  filter: "all" | "chat" | "voice";
  title: string;
  subtitle: string;
  defaultKind?: "chat" | "voice";
}) {
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [source, setSource] = useState<DataSource>("demo");
  const [modalOpen, setModalOpen] = useState(false);
  const [editAgent, setEditAgent] = useState<AiAgent | null>(null);
  const [testAgent, setTestAgent] = useState<AiAgent | null>(null);
  const [callAgent, setCallAgent] = useState<AiAgent | null>(null);

  const refresh = useCallback(() => {
    fetchAgents().then((r) => {
      setAgents(r.agents);
      setSource(r.source);
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function toggleStatus(a: AiAgent) {
    const next = a.status === "Live" ? "Paused" : "Live";
    setAgents((prev) => prev.map((x) => (x.id === a.id ? { ...x, status: next } : x)));
    await updateAgentStatus(a.id, next);
  }

  const visible = filter === "all" ? agents : agents.filter((a) => a.kind === filter);

  return (
    <>
      {(modalOpen || editAgent) && (
        <AgentModal
          initial={editAgent}
          defaultKind={defaultKind}
          onClose={() => {
            setModalOpen(false);
            setEditAgent(null);
          }}
          onSaved={refresh}
        />
      )}
      {testAgent && <TestChatModal agent={testAgent} onClose={() => setTestAgent(null)} />}
      {callAgent && <TestCallModal agent={callAgent} onClose={() => setCallAgent(null)} />}

      {source === "live" ? (
        <div className="mb-6 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-600">
          <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500" />
          <span><strong className="font-semibold">Live</strong> — agents are stored in your database. Chat agents reply through the AI gateway; voice agents run on Vapi.</span>
        </div>
      ) : (
        <DemoBanner context="Agents table not found — run supabase/migrations/0002 and 0003 in the SQL Editor." />
      )}

      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          <button
            onClick={() => setModalOpen(true)}
            className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" /> New agent
          </button>
        }
      />

      {visible.length === 0 ? (
        <Card className="p-10 text-center text-sm text-ink-500">
          No agents here yet — create one with the New agent button.
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {visible.map((a) => (
            <Card key={a.id} className="flex flex-col p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className={`rounded-xl p-2.5 ${a.kind === "voice" ? "bg-orange-500/15 text-orange-500" : "bg-brand-500/15 text-brand-500"}`}>
                    {a.kind === "voice" ? <PhoneCall className="h-5 w-5" /> : <MessageCircle className="h-5 w-5" />}
                  </div>
                  <div>
                    <p className="font-semibold text-ink-900">{a.name}</p>
                    <p className="text-xs text-ink-400">
                      {a.kind === "voice" ? `Voice agent · ${a.voice}` : `Chat agent · ${a.model}`} · {a.language}
                    </p>
                  </div>
                </div>
                <button onClick={() => toggleStatus(a)} title="Toggle live/paused">
                  <StatusBadge status={a.status} tone={a.status === "Live" ? "green" : a.status === "Paused" ? "amber" : "gray"} />
                </button>
              </div>

              <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-ink-600">{a.instructions || "No instructions yet."}</p>

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-600">{a.role}</span>
                {a.kind === "voice" ? (
                  <span className="rounded-full bg-orange-500/15 px-2 py-0.5 text-xs text-orange-500 capitalize">{a.purpose} calls</span>
                ) : (
                  a.channels.map((c) => (
                    <span key={c} className="rounded-full bg-ink-100 px-2 py-0.5 text-xs text-ink-500 capitalize">{c}</span>
                  ))
                )}
                {a.canBook && (
                  <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-600">
                    <CalendarCheck2 className="h-3 w-3" /> books
                  </span>
                )}
                {a.canReschedule && (
                  <span className="flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-xs text-blue-600">
                    <RefreshCcw className="h-3 w-3" /> reschedules
                  </span>
                )}
                {a.canCancel && (
                  <span className="flex items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5 text-xs text-rose-600">
                    <XCircle className="h-3 w-3" /> cancels
                  </span>
                )}
              </div>

              {(a.knowledgeBase || a.kbFiles.length > 0) && (
                <div className="mt-3 rounded-xl border border-ink-100 bg-ink-50 p-3">
                  <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-ink-500">
                    <BookOpen className="h-3.5 w-3.5" /> Knowledge base
                    {a.kbFiles.length > 0 && ` · ${a.kbFiles.length} document${a.kbFiles.length > 1 ? "s" : ""}`}
                  </p>
                  {a.kbFiles.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {a.kbFiles.map((f) => (
                        <span key={f} className="flex items-center gap-1 rounded-md bg-surface px-2 py-0.5 text-xs text-ink-600">
                          <FileText className="h-3 w-3" /> {f}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="line-clamp-2 text-xs leading-relaxed text-ink-500">{a.knowledgeBase}</p>
                  )}
                </div>
              )}

              <div className="mt-4 flex gap-2 border-t border-ink-100 pt-4">
                {a.kind === "chat" ? (
                  <button
                    onClick={() => setTestAgent(a)}
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand-600 py-2 text-sm font-semibold text-white hover:bg-brand-700"
                  >
                    <Sparkles className="h-4 w-4" /> Test chat
                  </button>
                ) : (
                  <button
                    onClick={() => setCallAgent(a)}
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand-600 py-2 text-sm font-semibold text-white hover:bg-brand-700"
                  >
                    <Mic className="h-4 w-4" /> Test call (talk to {a.name})
                  </button>
                )}
                <button
                  onClick={() => setEditAgent(a)}
                  className="flex items-center justify-center gap-2 rounded-xl border border-ink-200 px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"
                >
                  <Pencil className="h-4 w-4" /> Edit
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

// ----------------------------------------------------------- agent hub view

export function AgentHubView() {
  const [agents, setAgents] = useState<AiAgent[]>([]);
  useEffect(() => {
    fetchAgents().then((r) => setAgents(r.agents));
  }, []);

  const chatAgents = agents.filter((a) => a.kind === "chat");
  const voiceAgents = agents.filter((a) => a.kind === "voice");
  const [defaults, setDefaults] = useState<Record<string, ChannelDefault>>({});
  const [lines, setLines] = useState<PhoneLine[]>([]);
  const [newNumber, setNewNumber] = useState("");
  const [newLineAgent, setNewLineAgent] = useState("");
  const [newLineDirection, setNewLineDirection] = useState<PhoneLine["direction"]>("inbound");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    fetchChannelDefaults().then((d) => setDefaults(Object.fromEntries(d.map((x) => [x.channel, x]))));
    fetchPhoneLines().then(setLines);
  }, []);

  async function saveDefault(channel: string, agentId: string | null, enabled: boolean) {
    setDefaults((prev) => ({ ...prev, [channel]: { channel, agentId, enabled } }));
    const res = await setChannelDefault(channel, agentId, enabled);
    if (!res.ok) setNote(`Could not save (${res.message}) — run migration 0003 in the SQL Editor.`);
  }

  async function addLine() {
    if (!newNumber.trim()) return;
    const res = await addPhoneLine(newNumber.trim(), newLineAgent || null, newLineDirection);
    if (!res.ok) {
      setNote(`Could not save (${res.message}) — run migration 0003 in the SQL Editor.`);
      return;
    }
    setNewNumber("");
    fetchPhoneLines().then(setLines);
  }

  return (
    <>
      <PageHeader
        title="Agent Hub"
        subtitle="Route every channel and phone line to the right agent — automatically."
      />
      <div className="space-y-6">
        {note && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-600">{note}</div>
        )}

        <Card className="p-6">
          <h2 className="flex items-center gap-2 font-semibold text-ink-900">
            <MessageCircle className="h-5 w-5 text-brand-500" /> Routing rules — default agent per platform
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            Set a condition per channel: <em>when</em> a message arrives on a platform, <em>route it to</em>
            {" "}the chosen agent automatically. Mix and match — e.g. WhatsApp → your booking agent,
            Instagram → your sales agent. Toggle a rule off to hand that channel to your team instead.
            Changes save instantly and can be edited any time.
          </p>
          <div className="mt-5 space-y-2.5">
            {CHAT_CHANNELS.map((ch) => {
              const d = defaults[ch] ?? { channel: ch, agentId: null, enabled: false };
              const Icon = CHANNEL_ICONS[ch];
              return (
                <div key={ch} className="flex flex-wrap items-center gap-3 rounded-xl border border-ink-100 px-4 py-3">
                  <div className="flex min-w-36 items-center gap-2.5">
                    <Icon className="h-4 w-4 text-ink-400" />
                    <span className="text-sm font-medium capitalize text-ink-900">{ch}</span>
                  </div>
                  <select
                    value={d.agentId ?? ""}
                    onChange={(e) => saveDefault(ch, e.target.value || null, d.enabled)}
                    className="flex-1 rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-700 outline-none"
                  >
                    <option value="">No agent — humans reply</option>
                    {chatAgents.map((a) => (
                      <option key={a.id} value={a.id}>{a.name} — {a.role}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => saveDefault(ch, d.agentId, !d.enabled)}
                    className={`relative h-6 w-11 rounded-full transition-colors ${d.enabled && d.agentId ? "bg-brand-600" : "bg-ink-200"}`}
                    title={d.enabled ? "On — agent answers automatically" : "Off"}
                  >
                    <span
                      className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${d.enabled && d.agentId ? "left-[22px]" : "left-0.5"}`}
                    />
                  </button>
                </div>
              );
            })}
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="flex items-center gap-2 font-semibold text-ink-900">
            <PhoneCall className="h-5 w-5 text-orange-500" /> Voice — phone lines
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            Connect a number and route it: inbound calls, outbound campaigns, or both. You can run
            different agents on the same number for different directions.
          </p>

          <div className="mt-5 space-y-2.5">
            {lines.map((l) => (
              <div key={l.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-ink-100 px-4 py-3">
                <span className="min-w-36 text-sm font-medium text-ink-900">{l.number}</span>
                <span className="rounded-full bg-orange-500/15 px-2.5 py-0.5 text-xs font-medium capitalize text-orange-500">{l.direction}</span>
                <span className="flex-1 text-sm text-ink-600">
                  {voiceAgents.find((a) => a.id === l.agentId)?.name ?? "No agent assigned"}
                </span>
                <button
                  onClick={async () => {
                    await removePhoneLine(l.id);
                    setLines((prev) => prev.filter((x) => x.id !== l.id));
                  }}
                  className="rounded-lg p-1.5 text-ink-400 hover:bg-rose-500/10 hover:text-rose-500"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            {lines.length === 0 && (
              <p className="rounded-xl border border-dashed border-ink-200 px-4 py-5 text-center text-sm text-ink-400">
                No phone lines connected yet.
              </p>
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-ink-100 pt-4">
            <div className="flex-1">
              <Field label="Phone number">
                <input className={inputCls} placeholder="+1 (305) 555-0100" value={newNumber} onChange={(e) => setNewNumber(e.target.value)} />
              </Field>
            </div>
            <div className="flex-1">
              <Field label="Voice agent">
                <select className={inputCls} value={newLineAgent} onChange={(e) => setNewLineAgent(e.target.value)}>
                  <option value="">Choose agent…</option>
                  {voiceAgents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name} — {a.role}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div>
              <Field label="Direction">
                <select className={inputCls} value={newLineDirection} onChange={(e) => setNewLineDirection(e.target.value as PhoneLine["direction"])}>
                  <option value="inbound">Inbound</option>
                  <option value="outbound">Outbound</option>
                  <option value="both">Both</option>
                </select>
              </Field>
            </div>
            <button onClick={addLine} className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700">
              Connect line
            </button>
          </div>
        </Card>
      </div>
    </>
  );
}

// ------------------------------------------------------ create/edit modal

export function AgentModal({
  initial,
  defaultKind = "chat",
  onClose,
  onSaved,
}: {
  initial: AiAgent | null;
  defaultKind?: "chat" | "voice";
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<Omit<AiAgent, "id" | "vapiAssistantId">>(
    initial ? { ...initial } : { ...emptyForm(), kind: defaultKind }
  );
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileTexts, setFileTexts] = useState<Record<string, string>>({});

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function onFiles(list: FileList | null) {
    if (!list) return;
    const remaining = 10 - form.kbFiles.length;
    const files = Array.from(list).slice(0, remaining);
    for (const file of files) {
      if (form.kbFiles.includes(file.name)) continue;
      let text = "";
      if (/\.(txt|md|csv|json)$/i.test(file.name)) {
        text = await file.text();
      } else {
        text = `[Document on file: ${file.name} — full text extraction for PDF/Word coming soon]`;
      }
      setFileTexts((prev) => ({ ...prev, [file.name]: text.slice(0, 20000) }));
      setForm((f) => ({ ...f, kbFiles: [...f.kbFiles, file.name] }));
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeFile(name: string) {
    setForm((f) => ({ ...f, kbFiles: f.kbFiles.filter((x) => x !== name) }));
    setFileTexts((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }

  async function submit() {
    if (!form.name.trim()) {
      setResult({ ok: false, message: "Give your agent a name." });
      return;
    }
    setSaving(true);
    const uploadedText = form.kbFiles
      .map((name) => (fileTexts[name] ? `--- ${name} ---\n${fileTexts[name]}` : ""))
      .filter(Boolean)
      .join("\n\n");
    const payload = {
      ...form,
      knowledgeBase: [form.knowledgeBase, uploadedText].filter(Boolean).join("\n\n"),
    };

    let res: { ok: boolean; message: string; id?: string };
    if (initial) {
      res = await updateAgent(initial.id, payload);
    } else {
      res = await createAgent(payload);
    }

    let message = res.message;
    if (res.ok && form.kind === "voice") {
      try {
        const vapiRes = await fetch("/api/vapi/assistants", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: form.name,
            voice: form.voice,
            model: form.model.replace(/^openai\//, ""),
            firstMessage: form.firstMessage,
            instructions: form.instructions,
            knowledgeBase: payload.knowledgeBase,
            language: form.language,
          }),
        });
        const vapiData = await vapiRes.json();
        const agentId = res.id ?? initial?.id;
        if (vapiRes.ok && vapiData.id && agentId) await setAgentVapiId(agentId, vapiData.id);
        message = vapiRes.ok
          ? `Agent saved${initial ? " and re-synced to Vapi" : " and created in Vapi"}.`
          : `Agent saved locally. Vapi: ${vapiData.error ?? vapiData.message ?? "not connected yet"}`;
      } catch {
        message = "Agent saved locally. Vapi could not be reached.";
      }
    }
    setSaving(false);
    setResult({ ok: res.ok, message });
    if (res.ok) onSaved();
  }

  const abilities = ABILITIES_BY_ROLE[form.role] ?? ["canBook", "canReschedule", "canCancel"];
  const abilityLabels = { canBook: "Book appointments", canReschedule: "Reschedule / change times", canCancel: "Cancel appointments" } as const;

  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? `Edit agent — ${initial.name}` : "New AI agent"}
      subtitle="Its knowledge base is its brain — it answers only from what you give it, and hands off when unsure."
      wide
    >
      {result?.ok ? (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600">{result.message}</div>
      ) : (
        <>
          {result && (
            <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-600">{result.message}</div>
          )}

          <div className="mb-5 grid grid-cols-2 gap-2">
            {(
              [
                { kind: "chat", icon: MessageCircle, label: "Chat agent", sub: "WhatsApp · Instagram · SMS · Email — replies in the inbox" },
                { kind: "voice", icon: PhoneCall, label: "Voice agent", sub: "Phone calls — everything runs on Vapi" },
              ] as const
            ).map((k) => (
              <button
                key={k.kind}
                disabled={!!initial}
                onClick={() => set("kind", k.kind)}
                className={`rounded-xl border p-4 text-left transition-colors disabled:opacity-60 ${
                  form.kind === k.kind ? "border-brand-500 bg-brand-50" : "border-ink-200 hover:border-ink-300"
                }`}
              >
                <k.icon className={`h-5 w-5 ${form.kind === k.kind ? "text-brand-600 dark:text-brand-300" : "text-ink-400"}`} />
                <p className="mt-2 text-sm font-semibold text-ink-900">{k.label}</p>
                <p className="text-xs text-ink-500">{k.sub}</p>
              </button>
            ))}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Agent name">
              <input className={inputCls} placeholder="Nora" value={form.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
            <Field label="Agent type">
              <select
                className={inputCls}
                value={form.role}
                onChange={(e) => {
                  const role = e.target.value as (typeof ROLES)[number];
                  const allowed = ABILITIES_BY_ROLE[role];
                  setForm((f) => ({
                    ...f,
                    role,
                    canBook: allowed.includes("canBook") ? f.canBook : false,
                    canReschedule: allowed.includes("canReschedule") ? f.canReschedule : false,
                    canCancel: allowed.includes("canCancel") ? f.canCancel : false,
                  }));
                }}
              >
                {ROLES.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </Field>
            <Field label={form.kind === "chat" ? "AI model" : "Model (Vapi)"}>
              <select className={inputCls} value={form.model} onChange={(e) => set("model", e.target.value)}>
                {form.kind === "chat" ? (
                  <>
                    <optgroup label="OpenAI">
                      {OPENAI_MODELS.map((m) => <option key={m}>{m}</option>)}
                    </optgroup>
                    <optgroup label="Anthropic">
                      {ANTHROPIC_MODELS.map((m) => <option key={m}>{m}</option>)}
                    </optgroup>
                  </>
                ) : (
                  VAPI_MODELS.map((m) => <option key={m} value={`openai/${m}`}>{m}</option>)
                )}
              </select>
            </Field>
            <Field label="Language">
              <select className={inputCls} value={form.language} onChange={(e) => set("language", e.target.value)}>
                {LANGUAGES.map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </Field>
            {form.kind === "voice" && (
              <>
                <Field label="Voice">
                  <select className={inputCls} value={form.voice} onChange={(e) => set("voice", e.target.value)}>
                    {VOICES.map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Transcriber">
                  <select className={inputCls} defaultValue="Deepgram · Nova-2 (multilingual)">
                    <option>Deepgram · Nova-2 (multilingual)</option>
                    <option>Deepgram · Nova-3 (English)</option>
                  </select>
                </Field>
              </>
            )}
          </div>

          {form.kind === "voice" && (
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Field label="Who speaks first?">
                <select
                  className={inputCls}
                  value={form.firstMessageMode}
                  onChange={(e) => set("firstMessageMode", e.target.value as typeof form.firstMessageMode)}
                >
                  <option value="assistant_first">Assistant speaks first</option>
                  <option value="user_first">Assistant waits for caller</option>
                  <option value="assistant_first_generated">Assistant speaks first (AI-generated opening)</option>
                </select>
              </Field>
              <Field label="Use this agent for">
                <select className={inputCls} value={form.purpose} onChange={(e) => set("purpose", e.target.value as typeof form.purpose)}>
                  <option value="inbound">Inbound calls</option>
                  <option value="outbound">Outbound calls</option>
                  <option value="both">Both</option>
                </select>
              </Field>
              {form.firstMessageMode !== "user_first" && (
                <div className="md:col-span-2">
                  <Field label="First message">
                    <input
                      className={inputCls}
                      placeholder="Thank you for calling Bright Smile Dental, this is Nora. How can I help?"
                      value={form.firstMessage}
                      onChange={(e) => set("firstMessage", e.target.value)}
                    />
                  </Field>
                </div>
              )}
            </div>
          )}

          <div className="mt-4">
            <Field label={form.kind === "voice" ? "System prompt — personality, behavior, full script" : "Instructions / personality — greeting, behavior, full script"}>
              <textarea
                rows={4}
                className={inputCls}
                placeholder="You are the friendly receptionist for Bright Smile Dental. Greet warmly by name, answer questions about hours and insurance, always offer to book, and hand off to a human if unsure…"
                value={form.instructions}
                onChange={(e) => set("instructions", e.target.value)}
              />
            </Field>
          </div>

          <div className="mt-4">
            <p className="mb-1.5 text-sm font-medium text-ink-700">
              Knowledge base — upload documents ({form.kbFiles.length}/10)
            </p>
            <p className="mb-2 text-xs text-ink-400">
              The agent&apos;s brain: hours, pricing, insurance, FAQs, promos. It answers only from these documents.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".txt,.md,.csv,.json,.pdf,.doc,.docx"
              className="hidden"
              onChange={(e) => onFiles(e.target.files)}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={form.kbFiles.length >= 10}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-ink-300 py-4 text-sm font-medium text-ink-500 hover:border-brand-400 hover:text-brand-600 disabled:opacity-50 dark:hover:text-brand-300"
            >
              <Upload className="h-4 w-4" /> Upload documents (.txt, .md, .csv, .pdf, .docx — max 10)
            </button>
            {form.kbFiles.length > 0 && (
              <ul className="mt-2 space-y-1.5">
                {form.kbFiles.map((f) => (
                  <li key={f} className="flex items-center justify-between rounded-lg border border-ink-100 bg-ink-50 px-3 py-2 text-sm text-ink-700">
                    <span className="flex items-center gap-2"><FileText className="h-4 w-4 text-brand-500" /> {f}</span>
                    <button onClick={() => removeFile(f)} className="rounded p-1 text-ink-400 hover:text-rose-500">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {form.kind === "chat" && (
            <>
              <p className="mb-2 mt-5 text-sm font-medium text-ink-700">Abilities (based on agent type)</p>
              <div className="flex flex-wrap gap-4">
                {abilities.map((k) => (
                  <label key={k} className="flex items-center gap-2 text-sm text-ink-600">
                    <input
                      type="checkbox"
                      checked={form[k]}
                      onChange={(e) => set(k, e.target.checked)}
                      className="h-4 w-4 accent-[#7c3aed]"
                    />
                    {abilityLabels[k]}
                  </label>
                ))}
                <label className="flex items-center gap-2 text-sm text-ink-600">
                  <input type="checkbox" checked readOnly className="h-4 w-4 accent-[#7c3aed]" />
                  Answer FAQs from the knowledge base
                </label>
              </div>

              <p className="mb-2 mt-5 text-sm font-medium text-ink-700">Channels this agent covers</p>
              <div className="flex flex-wrap gap-2">
                {CHAT_CHANNELS.map((c) => {
                  const activeCh = form.channels.includes(c);
                  return (
                    <button
                      key={c}
                      onClick={() =>
                        set("channels", activeCh ? form.channels.filter((x) => x !== c) : [...form.channels, c])
                      }
                      className={`rounded-full px-3.5 py-1.5 text-sm font-medium capitalize transition-colors ${
                        activeCh ? "bg-brand-600 text-white" : "border border-ink-200 text-ink-600 hover:bg-ink-50"
                      }`}
                    >
                      {c}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          <div className="mt-5">
            <Field label="Status">
              <select className={inputCls} value={form.status} onChange={(e) => set("status", e.target.value as AiAgent["status"])}>
                <option>Draft</option>
                <option>Live</option>
                <option>Paused</option>
              </select>
            </Field>
          </div>

          <ModalFooter
            onClose={onClose}
            submitLabel={saving ? "Saving…" : initial ? "Save changes" : "Create agent"}
            onSubmit={submit}
          />
        </>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------ test chat

export function TestChatModal({ agent, onClose }: { agent: AiAgent; onClose: () => void }) {
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setError(null);
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: agent.model,
          agentName: agent.name,
          instructions: agent.instructions,
          knowledgeBase: agent.knowledgeBase,
          capabilities: { canBook: agent.canBook, canReschedule: agent.canReschedule, canCancel: agent.canCancel },
          messages: next,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "AI request failed");
      setMessages((m) => [...m, { role: "assistant", content: data.reply }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Test chat — ${agent.name}`} subtitle={`${agent.role} · ${agent.model} · answers only from its knowledge base`} wide>
      <div className="flex h-80 flex-col gap-3 overflow-y-auto rounded-xl border border-ink-100 bg-ink-50/50 p-4">
        {messages.length === 0 && (
          <p className="m-auto max-w-xs text-center text-sm text-ink-400">
            Pretend you&apos;re a patient — ask about hours, prices, insurance, or try to book an appointment.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                m.role === "user"
                  ? "rounded-br-sm bg-brand-600 text-white"
                  : "rounded-bl-sm border border-ink-200 bg-surface text-ink-800"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-sm border border-ink-200 bg-surface px-3.5 py-2 text-sm text-ink-400">
              <Bot className="h-4 w-4 animate-pulse" /> {agent.name} is typing…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      {error && <p className="mt-2 text-sm text-amber-600">{error}</p>}
      <div className="mt-3 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Message as a patient…"
          className={inputCls}
        />
        <button onClick={send} disabled={busy} className="rounded-xl bg-brand-600 px-4 text-white hover:bg-brand-700 disabled:opacity-50">
          <Send className="h-5 w-5" />
        </button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------- test voice call
// Talks to the agent live in the browser through the Vapi Web SDK — the call
// runs on Vapi's infrastructure; this UI just starts/stops and shows status.

type CallState = "idle" | "connecting" | "live" | "ended" | "error";

export function TestCallModal({ agent, onClose }: { agent: AiAgent; onClose: () => void }) {
  const [state, setState] = useState<CallState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<{ speaker: string; text: string }[]>([]);
  const [assistantSpeaking, setAssistantSpeaking] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vapiRef = useRef<any>(null);

  useEffect(() => {
    return () => {
      vapiRef.current?.stop?.();
    };
  }, []);

  async function start() {
    setState("connecting");
    setError(null);
    try {
      const { default: Vapi } = await import("@vapi-ai/web");
      const vapi = new Vapi(VAPI_PUBLIC_KEY);
      vapiRef.current = vapi;

      vapi.on("call-start", () => setState("live"));
      vapi.on("call-end", () => setState("ended"));
      vapi.on("speech-start", () => setAssistantSpeaking(true));
      vapi.on("speech-end", () => setAssistantSpeaking(false));
      vapi.on("error", (e: unknown) => {
        setState("error");
        setError(e instanceof Error ? e.message : JSON.stringify(e).slice(0, 200));
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vapi.on("message", (msg: any) => {
        if (msg.type === "transcript" && msg.transcriptType === "final") {
          setTranscript((t) => [...t, { speaker: msg.role === "assistant" ? agent.name : "You", text: msg.transcript }]);
        }
      });

      if (agent.vapiAssistantId) {
        await vapi.start(agent.vapiAssistantId);
      } else {
        // Agent not synced to Vapi yet — start with an inline assistant config
        await vapi.start({
          name: agent.name,
          firstMessage: agent.firstMessage || `Hi, this is ${agent.name} from the dental office. How can I help?`,
          model: {
            provider: "openai",
            model: agent.model.replace(/^openai\//, "") || "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content: [agent.instructions, agent.knowledgeBase && `KNOWLEDGE BASE:\n${agent.knowledgeBase}`]
                  .filter(Boolean)
                  .join("\n\n"),
              },
            ],
          },
          voice: { provider: "vapi", voiceId: VOICE_IDS[agent.voice] ?? "Leah" },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
      }
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : "Could not start the call.");
    }
  }

  function stop() {
    vapiRef.current?.stop?.();
    setState("ended");
  }

  return (
    <Modal
      open
      onClose={() => {
        stop();
        onClose();
      }}
      title={`Test call — talk to ${agent.name}`}
      subtitle="Live web call through Vapi — allow microphone access when your browser asks."
      wide
    >
      <div className="flex flex-col items-center gap-5 py-6">
        <div
          className={`flex h-24 w-24 items-center justify-center rounded-full transition-all ${
            state === "live"
              ? assistantSpeaking
                ? "scale-110 bg-brand-600 shadow-2xl shadow-brand-500/40"
                : "bg-brand-500/80"
              : state === "connecting"
              ? "animate-pulse bg-brand-500/40"
              : "bg-ink-200"
          }`}
        >
          <PhoneCall className="h-10 w-10 text-white" />
        </div>

        <p className="text-sm font-medium text-ink-700">
          {state === "idle" && "Ready — start the call and speak like a patient."}
          {state === "connecting" && "Connecting to Vapi…"}
          {state === "live" && (assistantSpeaking ? `${agent.name} is speaking…` : "Listening — say something!")}
          {state === "ended" && "Call ended."}
          {state === "error" && "Call failed."}
        </p>
        {error && <p className="max-w-md text-center text-xs text-amber-600">{error}</p>}

        {state === "live" || state === "connecting" ? (
          <button
            onClick={stop}
            className="flex items-center gap-2 rounded-xl bg-rose-600 px-6 py-3 text-sm font-semibold text-white hover:bg-rose-700"
          >
            <PhoneOff className="h-4 w-4" /> End call
          </button>
        ) : (
          <button
            onClick={start}
            className="flex items-center gap-2 rounded-xl bg-brand-600 px-6 py-3 text-sm font-semibold text-white hover:bg-brand-700"
          >
            <Mic className="h-4 w-4" /> {state === "ended" || state === "error" ? "Call again" : "Start test call"}
          </button>
        )}

        {transcript.length > 0 && (
          <div className="max-h-48 w-full space-y-2 overflow-y-auto rounded-xl border border-ink-100 bg-ink-50/50 p-4">
            {transcript.map((t, i) => (
              <p key={i} className="text-sm text-ink-700">
                <span className="font-semibold text-ink-900">{t.speaker}:</span> {t.text}
              </p>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
