"use client";

import { useEffect, useMemo, useState } from "react";
import { Bot, Send, Sparkles, UserCheck } from "lucide-react";
import { Card, ChannelBadge, Avatar, DemoBanner, PageHeader } from "@/components/ui";
import { toast } from "@/components/toast";
import { fetchAgents, fetchAssignments, assignAgent, fetchChannelDefaults, type AiAgent, type ChannelDefault } from "@/lib/db";
import { conversations, channelMeta, patients, type Channel, type Message } from "@/lib/mock-data";

const filters: { key: Channel | "all"; label: string }[] = [
  { key: "all", label: "All channels" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "instagram", label: "Instagram" },
  { key: "messenger", label: "Messenger" },
  { key: "sms", label: "SMS" },
  { key: "email", label: "Email" },
  { key: "voice", label: "Voice" },
];

export default function InboxPage() {
  const [filter, setFilter] = useState<Channel | "all">("all");
  const [activeId, setActiveId] = useState(conversations[0].id);
  const [draft, setDraft] = useState("");
  const [extraMessages, setExtraMessages] = useState<Record<string, Message[]>>({});
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const [channelDefaults, setChannelDefaults] = useState<ChannelDefault[]>([]);

  useEffect(() => {
    fetchAgents().then((r) => setAgents(r.agents.filter((a) => a.kind === "chat")));
    fetchAssignments().then(setAssignments);
    fetchChannelDefaults().then(setChannelDefaults);
  }, []);

  const list = useMemo(
    () => (filter === "all" ? conversations : conversations.filter((c) => c.channel === filter)),
    [filter]
  );
  const active = conversations.find((c) => c.id === activeId) ?? conversations[0];
  const patient = patients.find((p) => p.id === active.patientId);
  const thread = [...active.messages, ...(extraMessages[active.id] ?? [])];
  // Per-conversation assignment wins; otherwise the Agent Hub default for this channel
  const hubDefault = channelDefaults.find((d) => d.channel === active.channel && d.enabled && d.agentId);
  const assignedAgent =
    agents.find((a) => a.id === assignments[active.id]) ??
    agents.find((a) => a.id === hubDefault?.agentId) ??
    null;

  function send() {
    if (!draft.trim()) return;
    const msg: Message = {
      id: `local-${Date.now()}`,
      direction: "outbound",
      author: "Dana Reyes",
      body: draft.trim(),
      time: "Just now",
    };
    setExtraMessages((prev) => ({ ...prev, [active.id]: [...(prev[active.id] ?? []), msg] }));
    setDraft("");
  }

  async function onAssign(agentId: string) {
    setAssignments((prev) => ({ ...prev, [active.id]: agentId }));
    if (agentId) await assignAgent(active.id, agentId);
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
          messages: thread.map((m) => ({
            role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const),
            content: m.body,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "AI request failed");
      const msg: Message = {
        id: `ai-${Date.now()}`,
        direction: "outbound",
        author: `${agent.name} (AI)`,
        byBot: true,
        body: data.reply,
        time: "Just now",
      };
      setExtraMessages((prev) => ({ ...prev, [active.id]: [...(prev[active.id] ?? []), msg] }));
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "AI reply failed.");
    } finally {
      setAiBusy(false);
    }
  }

  return (
    <>
      <DemoBanner context="Replies you send here stay local to the demo — nothing is delivered." />
      <PageHeader
        title="Omnichannel Inbox"
        subtitle="Every WhatsApp, Instagram, Messenger, SMS, email and voice conversation in one calm queue."
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
              filter === f.key
                ? "bg-brand-600 text-white"
                : "border border-ink-200 bg-surface text-ink-600 hover:bg-ink-50"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <Card className="grid min-h-[600px] overflow-hidden lg:grid-cols-[320px_1fr_260px]">
        {/* Conversation list */}
        <div className="border-r border-ink-200">
          {list.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveId(c.id)}
              className={`flex w-full items-start gap-3 border-b border-ink-100 px-4 py-3.5 text-left transition-colors ${
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
                  {c.unread > 0 && (
                    <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[10px] font-semibold text-white">
                      {c.unread}
                    </span>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>

        {/* Thread */}
        <div className="flex flex-col">
          <div className="flex items-center justify-between border-b border-ink-200 px-5 py-3.5">
            <div className="flex items-center gap-3">
              <Avatar name={active.patientName} size="sm" />
              <div>
                <p className="text-sm font-semibold text-ink-900">{active.patientName}</p>
                <p className="text-xs text-ink-400">
                  via {channelMeta[active.channel].label}
                  {active.assignedTo ? ` · assigned to ${active.assignedTo}` : " · unassigned"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-ink-400" />
              <select
                value={assignments[active.id] ?? ""}
                onChange={(e) => onAssign(e.target.value)}
                className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-700 outline-none"
                title="Assign an AI agent to this conversation"
              >
                <option value="">
                  {hubDefault
                    ? `Hub default — ${agents.find((a) => a.id === hubDefault.agentId)?.name ?? "agent"}`
                    : "No AI agent — humans reply"}
                </option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {a.role}
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  onAssign("");
                  toast(`${active.patientName}'s conversation is assigned to you — the AI agent steps back until you hand it back.`);
                }}
                className="flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50"
              >
                <UserCheck className="h-3.5 w-3.5" /> Assign to me
              </button>
            </div>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto bg-ink-50/40 p-5">
            {thread.map((m) => (
              <div key={m.id} className={`flex ${m.direction === "outbound" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    m.direction === "outbound"
                      ? "rounded-br-sm bg-brand-600 text-white"
                      : "rounded-bl-sm border border-ink-200 bg-surface text-ink-800"
                  }`}
                >
                  <p className={`mb-1 flex items-center gap-1 text-[11px] font-semibold ${m.direction === "outbound" ? "text-brand-100" : "text-ink-400"}`}>
                    {m.byBot && <Bot className="h-3 w-3" />} {m.author} · {m.time}
                  </p>
                  {m.body}
                </div>
              </div>
            ))}
          </div>

          <div className="border-t border-ink-200 p-4">
            {aiError && <p className="mb-2 text-xs text-amber-600">{aiError}</p>}
            <div className="flex items-end gap-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
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
                <Sparkles className={`h-5 w-5 ${aiBusy ? "animate-pulse" : ""}`} />
                {aiBusy ? "Thinking…" : "AI reply"}
              </button>
              <button onClick={send} className="rounded-xl bg-brand-600 p-2.5 text-white hover:bg-brand-700">
                <Send className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>

        {/* Patient context panel */}
        <div className="hidden border-l border-ink-200 p-5 lg:block">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Patient chart</p>
          {patient ? (
            <div className="mt-4 space-y-4 text-sm">
              <div className="flex items-center gap-3">
                <Avatar name={patient.name} />
                <div>
                  <p className="font-semibold text-ink-900">{patient.name}</p>
                  <p className="text-xs text-ink-400">PatNum {patient.patNum}</p>
                </div>
              </div>
              {[
                ["Phone", patient.phone],
                ["Email", patient.email],
                ["Insurance", patient.insurance],
                ["Last visit", patient.lastVisit],
                ["Next appt", patient.nextAppointment ?? "None scheduled"],
                ["Balance", patient.balance > 0 ? `$${patient.balance.toFixed(2)}` : "$0.00"],
              ].map(([k, v]) => (
                <div key={k}>
                  <p className="text-xs text-ink-400">{k}</p>
                  <p className="text-ink-800">{v}</p>
                </div>
              ))}
              <div className="flex flex-wrap gap-1.5 pt-1">
                {active.tags.map((t) => (
                  <span key={t} className="rounded-full bg-ink-100 px-2 py-0.5 text-xs text-ink-600">
                    #{t}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <p className="mt-4 text-sm text-ink-500">No matched patient record.</p>
          )}
        </div>
      </Card>
    </>
  );
}
