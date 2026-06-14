"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Bot, Send, Sparkles, UserCheck, Inbox as InboxIcon, Users, CircleSlash, FileText, ChevronDown } from "lucide-react";
import { Card, ChannelBadge, Avatar, StatusBadge } from "@/components/ui";
import { toast } from "@/components/toast";
import { fetchAgents, fetchAssignments, assignAgent, fetchChannelDefaults, type AiAgent, type ChannelDefault } from "@/lib/db";
import { conversations, channelMeta, patients, type Channel, type Message } from "@/lib/mock-data";

const ME = "Dana Reyes";

let _seq = 0;
const nextId = (prefix: string) => `${prefix}-${++_seq}`;

const CHANNEL_TABS: { key: Channel | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "instagram", label: "Instagram" },
  { key: "messenger", label: "Messenger" },
  { key: "sms", label: "SMS" },
  { key: "email", label: "Email" },
];

const LIFECYCLE: { key: string; tone: "blue" | "amber" | "violet" | "green" }[] = [
  { key: "New Lead", tone: "blue" },
  { key: "Hot Lead", tone: "amber" },
  { key: "Payment", tone: "violet" },
  { key: "Customer", tone: "green" },
];

// Seed a sensible lifecycle stage per conversation from its tags (demo).
function seedLifecycle(): Record<string, string> {
  const map: Record<string, string> = {};
  conversations.forEach((c) => {
    if (c.tags.includes("high-value")) map[c.id] = "Hot Lead";
    else if (c.tags.includes("billing")) map[c.id] = "Payment";
    else if (c.tags.includes("confirmation")) map[c.id] = "Customer";
    else map[c.id] = "New Lead";
  });
  return map;
}

export default function InboxPage() {
  const [channel, setChannel] = useState<Channel | "all">("all");
  const [view, setView] = useState<"all" | "mine" | "unassigned">("all");
  const [lifecycleFilter, setLifecycleFilter] = useState<string | null>(null);
  const [unrepliedOnly, setUnrepliedOnly] = useState(false);
  const [activeId, setActiveId] = useState(conversations[0].id);
  const [draft, setDraft] = useState("");
  const [extraMessages, setExtraMessages] = useState<Record<string, Message[]>>({});
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [channelDefaults, setChannelDefaults] = useState<ChannelDefault[]>([]);
  const [lifecycle, setLifecycle] = useState<Record<string, string>>(seedLifecycle);
  const [mineSet, setMineSet] = useState<Set<string>>(new Set());
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  useEffect(() => {
    fetchAgents().then((r) => setAgents(r.agents.filter((a) => a.kind === "chat")));
    fetchAssignments().then(setAssignments);
    fetchChannelDefaults().then(setChannelDefaults);
  }, []);

  const isUnreplied = (id: string, base: Message[]) => {
    const thread = [...base, ...(extraMessages[id] ?? [])];
    return thread.length > 0 && thread[thread.length - 1].direction === "inbound";
  };
  const isMine = (cId: string, assignedTo: string | null) => mineSet.has(cId) || assignedTo === ME;
  const isUnassigned = (c: (typeof conversations)[number]) => !c.assignedTo && !assignments[c.id] && !mineSet.has(c.id);

  const list = useMemo(
    () =>
      conversations.filter((c) => {
        if (channel !== "all" && c.channel !== channel) return false;
        if (view === "mine" && !isMine(c.id, c.assignedTo)) return false;
        if (view === "unassigned" && !isUnassigned(c)) return false;
        if (lifecycleFilter && lifecycle[c.id] !== lifecycleFilter) return false;
        if (unrepliedOnly && !isUnreplied(c.id, c.messages)) return false;
        return true;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channel, view, lifecycleFilter, unrepliedOnly, assignments, mineSet, lifecycle, extraMessages]
  );

  const counts = {
    all: conversations.length,
    mine: conversations.filter((c) => isMine(c.id, c.assignedTo)).length,
    unassigned: conversations.filter((c) => isUnassigned(c)).length,
  };
  const lifecycleCounts = (stage: string) => conversations.filter((c) => lifecycle[c.id] === stage).length;

  const active = conversations.find((c) => c.id === activeId) ?? conversations[0];
  const patient = patients.find((p) => p.id === active.patientId);
  const thread = [...active.messages, ...(extraMessages[active.id] ?? [])];
  const hubDefault = channelDefaults.find((d) => d.channel === active.channel && d.enabled && d.agentId);
  const assignedAgent =
    agents.find((a) => a.id === assignments[active.id]) ?? agents.find((a) => a.id === hubDefault?.agentId) ?? null;
  const windowClosed = active.channel === "whatsapp" && thread.length > 0 && thread[thread.length - 1].direction === "outbound";

  function send() {
    if (!draft.trim()) return;
    const msg: Message = { id: nextId("local"), direction: "outbound", author: ME, body: draft.trim(), time: "Just now" };
    setExtraMessages((prev) => ({ ...prev, [active.id]: [...(prev[active.id] ?? []), msg] }));
    setDraft("");
  }

  async function onAssign(agentId: string) {
    setAssignments((prev) => ({ ...prev, [active.id]: agentId }));
    if (agentId) await assignAgent(active.id, agentId);
  }

  function assignToMe() {
    setMineSet((prev) => new Set(prev).add(active.id));
    setAssignments((prev) => {
      const next = { ...prev };
      delete next[active.id];
      return next;
    });
    toast(`${active.patientName}'s conversation is assigned to you — the AI agent steps back until you hand it back.`);
  }

  function setStage(stage: string) {
    setLifecycle((prev) => ({ ...prev, [active.id]: stage }));
    toast(`${active.patientName} moved to “${stage}”.`);
  }

  async function aiReply() {
    const agent = assignedAgent;
    if (!agent) {
      setAiError("Assign an agent to this chat, or set a default for this channel in AI Agents → Agent Hub.");
      return;
    }
    setAiBusy(true);
    setAiError(null);
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
          patientContext: patient
            ? `Name: ${patient.name}. Insurance: ${patient.insurance}. Last visit: ${patient.lastVisit}. Next appointment: ${patient.nextAppointment ?? "none"}. Balance: $${patient.balance}.`
            : "",
          messages: thread.map((m) => ({ role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const), content: m.body })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "AI request failed");
      const msg: Message = { id: nextId("ai"), direction: "outbound", author: `${agent.name} (AI)`, byBot: true, body: data.reply, time: "Just now" };
      setExtraMessages((prev) => ({ ...prev, [active.id]: [...(prev[active.id] ?? []), msg] }));
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "AI reply failed.");
    } finally {
      setAiBusy(false);
    }
  }

  const stageTone = (id: string) => LIFECYCLE.find((l) => l.key === lifecycle[id])?.tone ?? "blue";

  return (
    <Card className="flex h-[calc(100vh-106px)] overflow-hidden">
      {/* 1 — rail: views + lifecycle */}
      <div className="hidden w-52 shrink-0 flex-col border-r border-ink-200 bg-ink-50/40 md:flex">
        <div className="border-b border-ink-200 px-4 py-3.5">
          <h1 className="flex items-center gap-2 font-semibold text-ink-900"><InboxIcon className="h-4 w-4 text-brand-500" /> Inbox</h1>
        </div>
        <div className="space-y-0.5 p-2">
          {([
            ["all", "All", InboxIcon, counts.all],
            ["mine", "Mine", UserCheck, counts.mine],
            ["unassigned", "Unassigned", CircleSlash, counts.unassigned],
          ] as const).map(([key, label, Icon, count]) => (
            <button
              key={key}
              onClick={() => setView(key)}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                view === key ? "bg-brand-50 text-brand-600 dark:text-brand-300" : "text-ink-600 hover:bg-ink-100"
              }`}
            >
              <span className="flex items-center gap-2.5"><Icon className="h-4 w-4 text-ink-400" /> {label}</span>
              <span className="text-xs text-ink-400">{count.toLocaleString()}</span>
            </button>
          ))}
        </div>
        <div className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-400">Lifecycle</div>
        <div className="space-y-0.5 p-2 pt-1">
          {LIFECYCLE.map((l) => (
            <button
              key={l.key}
              onClick={() => setLifecycleFilter((cur) => (cur === l.key ? null : l.key))}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                lifecycleFilter === l.key ? "bg-brand-50 text-brand-600 dark:text-brand-300" : "text-ink-600 hover:bg-ink-100"
              }`}
            >
              <span className="flex items-center gap-2"><StatusBadge status={l.key} tone={l.tone} /></span>
              <span className="text-xs text-ink-400">{lifecycleCounts(l.key)}</span>
            </button>
          ))}
        </div>
        <Link href="/dashboard/agents/chat" className="mt-auto m-2 flex items-center justify-center gap-2 rounded-lg border border-dashed border-ink-300 px-3 py-2 text-sm font-medium text-ink-500 hover:border-brand-400 hover:text-brand-600 dark:hover:text-brand-300">
          <Bot className="h-4 w-4" /> Create AI agent
        </Link>
      </div>

      {/* 2 — chat list with channel tabs */}
      <div className="flex w-full shrink-0 flex-col border-r border-ink-200 sm:w-80">
        <div className="flex items-center gap-1 overflow-x-auto border-b border-ink-200 px-2 py-2">
          {CHANNEL_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setChannel(t.key)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                channel === t.key ? "bg-brand-600 text-white" : "text-ink-500 hover:bg-ink-100"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between border-b border-ink-100 px-3 py-2 text-xs text-ink-500">
          <span className="flex items-center gap-1 font-medium">Open, newest <ChevronDown className="h-3 w-3" /></span>
          <button onClick={() => setUnrepliedOnly((v) => !v)} className="flex items-center gap-1.5">
            <span className={`relative h-4 w-7 rounded-full transition-colors ${unrepliedOnly ? "bg-brand-600" : "bg-ink-200"}`}>
              <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${unrepliedOnly ? "left-3.5" : "left-0.5"}`} />
            </span>
            Unreplied
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {list.length === 0 && <p className="px-4 py-10 text-center text-sm text-ink-400">No conversations match these filters.</p>}
          {list.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveId(c.id)}
              className={`flex w-full items-start gap-3 border-b border-ink-100 px-3.5 py-3 text-left transition-colors ${
                c.id === active.id ? "bg-brand-50/60" : "hover:bg-ink-50"
              }`}
            >
              <Avatar name={c.patientName} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-medium text-ink-900">{c.patientName}</p>
                  <span className="shrink-0 text-[11px] text-ink-400">{c.time}</span>
                </div>
                <p className="mt-0.5 truncate text-xs text-ink-500">{c.preview}</p>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <ChannelBadge channel={c.channel} />
                  <StatusBadge status={lifecycle[c.id]} tone={stageTone(c.id)} />
                  {c.unread > 0 && (
                    <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[10px] font-semibold text-white">{c.unread}</span>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* 3 — thread */}
      <div className="hidden flex-1 flex-col sm:flex">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-200 px-5 py-3">
          <div className="flex items-center gap-3">
            <Avatar name={active.patientName} size="sm" />
            <div>
              <p className="flex items-center gap-2 text-sm font-semibold text-ink-900">
                {active.patientName} <StatusBadge status={lifecycle[active.id]} tone={stageTone(active.id)} />
              </p>
              <p className="text-xs text-ink-400">via {channelMeta[active.channel].label}{active.assignedTo ? ` · ${active.assignedTo}` : mineSet.has(active.id) ? " · you" : " · unassigned"}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={lifecycle[active.id]}
              onChange={(e) => setStage(e.target.value)}
              className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-700 outline-none"
              title="Lifecycle stage"
            >
              {LIFECYCLE.map((l) => <option key={l.key} value={l.key}>{l.key}</option>)}
            </select>
            <select
              value={assignments[active.id] ?? ""}
              onChange={(e) => onAssign(e.target.value)}
              className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-700 outline-none"
              title="Assign an AI agent"
            >
              <option value="">{hubDefault ? `Hub default — ${agents.find((a) => a.id === hubDefault.agentId)?.name ?? "agent"}` : "No AI agent"}</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name} — {a.role}</option>)}
            </select>
            <button onClick={assignToMe} className="flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50">
              <UserCheck className="h-3.5 w-3.5" /> Assign to me
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto bg-ink-50/40 p-5">
          {thread.map((m) => (
            <div key={m.id} className={`flex ${m.direction === "outbound" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${m.direction === "outbound" ? "rounded-br-sm bg-brand-600 text-white" : "rounded-bl-sm border border-ink-200 bg-surface text-ink-800"}`}>
                <p className={`mb-1 flex items-center gap-1 text-[11px] font-semibold ${m.direction === "outbound" ? "text-brand-100" : "text-ink-400"}`}>
                  {m.byBot && <Bot className="h-3 w-3" />} {m.author} · {m.time}
                </p>
                {m.body}
              </div>
            </div>
          ))}
        </div>

        <div className="border-t border-ink-200 p-4">
          {windowClosed && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-700">
              <span className="font-semibold">WhatsApp 24-hour window closed.</span>
              <span className="text-amber-600/90">Meta only allows an approved template until the contact replies again.</span>
              <Link href="/dashboard/whatsapp/templates" className="ml-auto rounded-lg bg-amber-500 px-2.5 py-1 font-semibold text-white hover:bg-amber-600">Send template</Link>
            </div>
          )}
          {aiError && <p className="mb-2 text-xs text-amber-600">{aiError}</p>}
          <div className="flex items-end gap-2">
            <button
              onClick={() => toast("Template picker opens here — choose an approved WhatsApp/Email template.", "info")}
              title="Insert a template"
              className="rounded-xl border border-ink-200 p-2.5 text-ink-500 hover:bg-ink-50"
            >
              <FileText className="h-5 w-5" />
            </button>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              rows={2}
              placeholder={`Reply on ${channelMeta[active.channel].label}…`}
              className="flex-1 resize-none rounded-xl border border-ink-200 bg-surface px-3.5 py-2.5 text-sm text-ink-800 outline-none placeholder:text-ink-400 focus:border-brand-400"
            />
            <button
              onClick={aiReply}
              disabled={aiBusy}
              title={assignedAgent ? `Let ${assignedAgent.name} reply` : "Let the AI agent reply"}
              className="flex items-center gap-1.5 rounded-xl border border-ink-200 px-3 py-2.5 text-sm font-medium text-brand-600 hover:bg-brand-50 disabled:opacity-50 dark:text-brand-300"
            >
              <Sparkles className={`h-5 w-5 ${aiBusy ? "animate-pulse" : ""}`} /> {aiBusy ? "Thinking…" : "AI reply"}
            </button>
            <button onClick={send} className="rounded-xl bg-brand-600 p-2.5 text-white hover:bg-brand-700"><Send className="h-5 w-5" /></button>
          </div>
        </div>
      </div>

      {/* 4 — contact panel */}
      <div className="hidden w-64 shrink-0 border-l border-ink-200 p-5 xl:block">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ink-400"><Users className="h-3.5 w-3.5" /> Contact</p>
        {patient ? (
          <div className="mt-4 space-y-4 text-sm">
            <div className="flex items-center gap-3">
              <Avatar name={patient.name} />
              <div>
                <Link href={`/dashboard/patients/${patient.id}`} className="font-semibold text-ink-900 hover:text-brand-600">{patient.name}</Link>
                <p className="text-xs text-ink-400">PatNum {patient.patNum}</p>
              </div>
            </div>
            {[["Phone", patient.phone], ["Email", patient.email], ["Insurance", patient.insurance], ["Next appt", patient.nextAppointment ?? "None"], ["Balance", patient.balance > 0 ? `$${patient.balance.toFixed(2)}` : "$0.00"]].map(([k, v]) => (
              <div key={k}><p className="text-xs text-ink-400">{k}</p><p className="text-ink-800">{v}</p></div>
            ))}
            <div className="flex flex-wrap gap-1.5 pt-1">
              {active.tags.map((t) => <span key={t} className="rounded-full bg-ink-100 px-2 py-0.5 text-xs text-ink-600">#{t}</span>)}
            </div>
          </div>
        ) : (
          <div className="mt-4">
            <p className="text-sm text-ink-500">New lead — no patient record yet.</p>
            <Link href="/dashboard/patients" className="mt-3 inline-block rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700">Create contact</Link>
          </div>
        )}
      </div>
    </Card>
  );
}
