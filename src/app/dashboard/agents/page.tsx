"use client";

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
} from "lucide-react";
import { Card, PageHeader, DemoBanner, StatusBadge } from "@/components/ui";
import { Modal, Field, ModalFooter, inputCls } from "@/components/modal";
import { fetchAgents, createAgent, updateAgentStatus, type AiAgent, type DataSource } from "@/lib/db";

const CHAT_MODELS = [
  "openai/gpt-4o-mini",
  "openai/gpt-4o",
  "anthropic/claude-3.5-haiku",
  "anthropic/claude-sonnet-4",
  "google/gemini-2.0-flash-001",
  "meta-llama/llama-3.1-70b-instruct",
];

const VOICES = [
  "Warm female · US English",
  "Friendly male · US English",
  "Neutral female · US English",
  "Calm male · US English",
];

const ROLES = ["Receptionist", "Sales", "Knowledge base", "Appointment setter", "Follow-up"] as const;
const CHANNELS = ["whatsapp", "sms", "email", "voice"] as const;

function emptyForm(): Omit<AiAgent, "id" | "vapiAssistantId"> {
  return {
    name: "",
    kind: "chat",
    role: "Knowledge base",
    status: "Draft",
    model: CHAT_MODELS[0],
    voice: VOICES[0],
    firstMessage: "",
    language: "English",
    instructions: "",
    knowledgeBase: "",
    canBook: true,
    canReschedule: true,
    canCancel: false,
    channels: ["whatsapp"],
  };
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [source, setSource] = useState<DataSource>("demo");
  const [modalOpen, setModalOpen] = useState(false);
  const [testAgent, setTestAgent] = useState<AiAgent | null>(null);

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

  return (
    <>
      <CreateAgentModal open={modalOpen} onClose={() => setModalOpen(false)} onCreated={refresh} />
      {testAgent && <TestChatModal agent={testAgent} onClose={() => setTestAgent(null)} />}

      {source === "live" ? (
        <div className="mb-6 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-600">
          <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500" />
          <span><strong className="font-semibold">Live</strong> — agents are stored in your database. Chat agents reply through the AI gateway; voice agents run on Vapi.</span>
        </div>
      ) : (
        <DemoBanner context="Agents table not found — run supabase/migrations/0002_agents.sql in the SQL Editor." />
      )}

      <PageHeader
        title="AI Agents"
        subtitle="Voice and chat agents with their own knowledge base — they answer, book, reschedule and follow up on their own."
        actions={
          <button
            onClick={() => setModalOpen(true)}
            className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" /> New agent
          </button>
        }
      />

      {agents.length === 0 ? (
        <Card className="p-10 text-center text-sm text-ink-500">
          No agents yet — create your first one, or run migration 0002 to load the starter team
          (Ava, Leo, Mila, Sam).
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {agents.map((a) => (
            <Card key={a.id} className="flex flex-col p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className={`rounded-xl p-2.5 ${a.kind === "voice" ? "bg-orange-500/15 text-orange-500" : "bg-violet-500/15 text-violet-500"}`}>
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
                {a.channels.map((c) => (
                  <span key={c} className="rounded-full bg-ink-100 px-2 py-0.5 text-xs text-ink-500 capitalize">{c}</span>
                ))}
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

              {a.knowledgeBase && (
                <div className="mt-3 rounded-xl border border-ink-100 bg-ink-50 p-3">
                  <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-ink-500">
                    <BookOpen className="h-3.5 w-3.5" /> Knowledge base
                  </p>
                  <p className="line-clamp-2 text-xs leading-relaxed text-ink-500">{a.knowledgeBase}</p>
                </div>
              )}

              <div className="mt-4 flex gap-2 border-t border-ink-100 pt-4">
                {a.kind === "chat" ? (
                  <button
                    onClick={() => setTestAgent(a)}
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand-600 py-2 text-sm font-semibold text-white hover:bg-brand-700"
                  >
                    <Sparkles className="h-4 w-4" /> Test chat with {a.name}
                  </button>
                ) : (
                  <span className="flex flex-1 items-center justify-center rounded-xl border border-ink-200 py-2 text-sm text-ink-500">
                    Runs on Vapi — assign a phone number to test
                  </span>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

// --------------------------------------------------------- creation modal

function CreateAgentModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  function set<K extends keyof ReturnType<typeof emptyForm>>(k: K, v: ReturnType<typeof emptyForm>[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function close() {
    setForm(emptyForm());
    setResult(null);
    onClose();
  }

  async function submit() {
    if (!form.name.trim()) {
      setResult({ ok: false, message: "Give your agent a name." });
      return;
    }
    setSaving(true);
    const res = await createAgent(form);
    let message = res.message;
    if (res.ok && form.kind === "voice") {
      // Best-effort: also create the assistant in Vapi (needs the private key on the server).
      try {
        const vapiRes = await fetch("/api/vapi/assistants", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: form.name,
            firstMessage: form.firstMessage,
            instructions: form.instructions,
            knowledgeBase: form.knowledgeBase,
            language: form.language,
          }),
        });
        const vapiData = await vapiRes.json();
        message = vapiRes.ok
          ? "Agent saved and created in Vapi."
          : `Agent saved locally. Vapi: ${vapiData.error ?? vapiData.message ?? "not connected yet"}`;
      } catch {
        message = "Agent saved locally. Vapi could not be reached.";
      }
    }
    setSaving(false);
    setResult({ ok: res.ok, message });
    if (res.ok) onCreated();
  }

  return (
    <Modal open={open} onClose={close} title="New AI agent" subtitle="Give it a role and a knowledge base — it handles patients on its own and hands off when unsure." wide>
      {result?.ok ? (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600">{result.message}</div>
      ) : (
        <>
          {result && (
            <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-600">{result.message}</div>
          )}

          {/* Kind selector */}
          <div className="mb-5 grid grid-cols-2 gap-2">
            {(
              [
                { kind: "chat", icon: MessageCircle, label: "Chat agent", sub: "WhatsApp · SMS · Email — replies in the inbox" },
                { kind: "voice", icon: PhoneCall, label: "Voice agent", sub: "Phone calls — runs on Vapi" },
              ] as const
            ).map((k) => (
              <button
                key={k.kind}
                onClick={() => set("kind", k.kind)}
                className={`rounded-xl border p-4 text-left transition-colors ${
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
              <select className={inputCls} value={form.role} onChange={(e) => set("role", e.target.value as (typeof ROLES)[number])}>
                {ROLES.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </Field>
            {form.kind === "chat" ? (
              <Field label="AI model">
                <select className={inputCls} value={form.model} onChange={(e) => set("model", e.target.value)}>
                  {CHAT_MODELS.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </Field>
            ) : (
              <Field label="Voice">
                <select className={inputCls} value={form.voice} onChange={(e) => set("voice", e.target.value)}>
                  {VOICES.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Languages">
              <select className={inputCls} value={form.language} onChange={(e) => set("language", e.target.value)}>
                <option>English</option>
                <option>English + Spanish</option>
                <option>Spanish</option>
              </select>
            </Field>
          </div>

          {form.kind === "voice" && (
            <div className="mt-4">
              <Field label="First message (how the agent answers the phone)">
                <input
                  className={inputCls}
                  placeholder="Thank you for calling Bright Smile Dental, this is Nora. How can I help?"
                  value={form.firstMessage}
                  onChange={(e) => set("firstMessage", e.target.value)}
                />
              </Field>
            </div>
          )}

          <div className="mt-4">
            <Field label="Instructions / personality">
              <textarea
                rows={3}
                className={inputCls}
                placeholder="You are the friendly receptionist… Always offer to book. Hand off to a human if unsure."
                value={form.instructions}
                onChange={(e) => set("instructions", e.target.value)}
              />
            </Field>
          </div>
          <div className="mt-4">
            <Field label="Knowledge base (hours, pricing, insurance, promos — the agent answers ONLY from this)">
              <textarea
                rows={5}
                className={inputCls}
                placeholder={"Office hours: Mon–Fri 8am–6pm…\nInsurance accepted: …\nPricing: …\nCurrent promos: …"}
                value={form.knowledgeBase}
                onChange={(e) => set("knowledgeBase", e.target.value)}
              />
            </Field>
          </div>

          <p className="mb-2 mt-5 text-sm font-medium text-ink-700">Abilities</p>
          <div className="flex flex-wrap gap-4">
            {(
              [
                ["canBook", "Book appointments"],
                ["canReschedule", "Reschedule / change times"],
                ["canCancel", "Cancel appointments"],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 text-sm text-ink-600">
                <input
                  type="checkbox"
                  checked={form[k]}
                  onChange={(e) => set(k, e.target.checked)}
                  className="h-4 w-4 accent-[#207e84]"
                />
                {label}
              </label>
            ))}
          </div>

          <p className="mb-2 mt-5 text-sm font-medium text-ink-700">Channels this agent covers</p>
          <div className="flex flex-wrap gap-2">
            {CHANNELS.map((c) => {
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

          <div className="mt-5">
            <Field label="Status">
              <select className={inputCls} value={form.status} onChange={(e) => set("status", e.target.value as AiAgent["status"])}>
                <option>Draft</option>
                <option>Live</option>
                <option>Paused</option>
              </select>
            </Field>
          </div>

          <ModalFooter onClose={close} submitLabel={saving ? "Creating…" : "Create agent"} onSubmit={submit} />
        </>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------ test chat

function TestChatModal({ agent, onClose }: { agent: AiAgent; onClose: () => void }) {
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
