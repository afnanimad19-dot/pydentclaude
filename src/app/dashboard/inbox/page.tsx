"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Bot, Send, Sparkles, UserCheck, Inbox as InboxIcon, Users, CircleSlash, FileText, ChevronDown, RefreshCw, ArrowDown, Mic } from "lucide-react";
import { Card, ChannelBadge, Avatar, StatusBadge } from "@/components/ui";
import { toast } from "@/components/toast";
import {
  fetchAgents,
  fetchAssignments,
  assignAgent,
  fetchChannelDefaults,
  fetchPatients,
  fetchWaConversations,
  fetchWaMessages,
  markWaRead,
  assignWaAgent,
  setWaLifecycle,
  setWaAssignee,
  fetchTeamMembers,
  fetchCustomVoices,
  sendWaReply,
  type AiAgent,
  type ChannelDefault,
  type WaConversation,
  type WaMessage,
  type TeamMember,
} from "@/lib/db";
import { conversations, channelMeta, patients as mockPatients, type Channel, type Message, type Patient } from "@/lib/mock-data";

const ME = "Dana Reyes";
let _seq = 0;
const nextId = (prefix: string) => `${prefix}-${++_seq}`;
const fmtTime = (iso: string) => (iso && iso.length >= 16 ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : iso || "");

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

interface ThreadItem {
  id: string;
  direction: "inbound" | "outbound";
  author: string;
  body: string;
  time: string;
  byBot?: boolean;
  audioUrl?: string;
}

interface VoiceOption {
  id: string;
  label: string;
}

interface UnifiedConvo {
  id: string;
  live: boolean;
  channel: Channel;
  name: string;
  phone?: string;
  preview: string;
  time: string;
  unread: number;
  lifecycle: string;
  tags: string[];
  patientId?: string;
}

function seedDemoLifecycle(): Record<string, string> {
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
  const [activeId, setActiveId] = useState<string>("");
  const userPicked = useRef(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  // demo state
  const [extraMessages, setExtraMessages] = useState<Record<string, Message[]>>({});
  const [demoLifecycle, setDemoLifecycle] = useState<Record<string, string>>(seedDemoLifecycle);
  const [demoAssignments, setDemoAssignments] = useState<Record<string, string>>({});
  const [mineSet, setMineSet] = useState<Set<string>>(new Set());

  // live state
  const [liveConvos, setLiveConvos] = useState<WaConversation[]>([]);
  const [liveMessages, setLiveMessages] = useState<WaMessage[]>([]);
  const [liveAssign, setLiveAssign] = useState<Record<string, string | null>>({});
  const [liveStage, setLiveStage] = useState<Record<string, string>>({});
  const [liveStatus, setLiveStatus] = useState<Record<string, string>>({});
  const [liveAssignee, setLiveAssignee] = useState<Record<string, string | null>>({});
  const [livePatients, setLivePatients] = useState<Patient[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);

  // Voice notes (ElevenLabs): pick a voice — premade or your own cloned voice — and
  // turn the typed message into a voice note when you're handling the chat yourself.
  const [voiceNotes, setVoiceNotes] = useState<Record<string, ThreadItem[]>>({});
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voiceId, setVoiceId] = useState<string>("");
  const [voiceBusy, setVoiceBusy] = useState(false);

  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [channelDefaults, setChannelDefaults] = useState<ChannelDefault[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const activeIdRef = useRef(activeId);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  // Scroll the thread to the latest message; show a "jump to latest" button when
  // the user has scrolled up to read history.
  const threadRef = useRef<HTMLDivElement>(null);
  const [showJump, setShowJump] = useState(false);
  function scrollToBottom() {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }
  function onThreadScroll() {
    const el = threadRef.current;
    if (!el) return;
    setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > 120);
  }

  useEffect(() => {
    fetchAgents().then((r) => setAgents(r.agents.filter((a) => a.kind === "chat")));
    fetchAssignments().then(setDemoAssignments);
    fetchChannelDefaults().then(setChannelDefaults);
    fetchTeamMembers().then(setTeam);
    // Voice list for voice notes: your own cloned voices first, then premade.
    Promise.all([
      fetchCustomVoices().catch(() => []),
      fetch("/api/voice/list").then((r) => r.json()).catch(() => ({ voices: [] })),
    ]).then(([custom, lib]) => {
      const mine: VoiceOption[] = custom.map((v) => ({ id: v.voiceId, label: `★ ${v.name} (your voice)` }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const premade: VoiceOption[] = (lib.voices ?? []).map((v: any) => ({ id: v.id, label: `${v.name}${v.gender ? ` · ${v.gender}` : ""}` }));
      const all = [...mine, ...premade];
      setVoices(all);
      setVoiceId((cur) => cur || all[0]?.id || "");
    });
  }, []);

  const refreshLive = useCallback(() => {
    fetchWaConversations().then((cs) => {
      setLiveConvos(cs);
      setLiveAssign((prev) => ({ ...Object.fromEntries(cs.map((c) => [c.id, c.assignedAgentId])), ...prev }));
      setLiveStage((prev) => ({ ...Object.fromEntries(cs.map((c) => [c.id, c.lifecycle])), ...prev }));
      setLiveStatus((prev) => ({ ...Object.fromEntries(cs.map((c) => [c.id, c.status])), ...prev }));
      setLiveAssignee((prev) => ({ ...Object.fromEntries(cs.map((c) => [c.id, c.assignedTo])), ...prev }));
      const id = activeIdRef.current;
      if (cs.some((c) => c.id === id)) fetchWaMessages(id).then(setLiveMessages);
    });
    fetchPatients().then((r) => setLivePatients(r.patients));
  }, []);

  // Poll live conversations + active thread every 7s.
  useEffect(() => {
    refreshLive();
    const t = setInterval(refreshLive, 7000);
    return () => clearInterval(t);
  }, [refreshLive]);

  const isLiveId = (id: string) => liveConvos.some((c) => c.id === id);

  // Load + mark-read when opening a live conversation.
  useEffect(() => {
    if (isLiveId(activeId)) {
      fetchWaMessages(activeId).then(setLiveMessages);
      markWaRead(activeId).then(() => setLiveConvos((prev) => prev.map((c) => (c.id === activeId ? { ...c, unread: 0 } : c))));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Build the unified conversation list.
  const unified: UnifiedConvo[] = useMemo(() => {
    const live: UnifiedConvo[] = liveConvos.map((c) => ({
      id: c.id,
      live: true,
      channel: (["whatsapp", "instagram", "messenger", "sms", "email", "voice"].includes(c.channel) ? c.channel : "whatsapp") as Channel,
      name: c.contactName,
      phone: c.contactPhone,
      preview: c.lastMessage,
      time: fmtTime(c.lastTime),
      unread: c.unread,
      lifecycle: liveStage[c.id] ?? c.lifecycle,
      tags: ["whatsapp"],
      patientId: c.patientId ?? undefined,
    }));
    const demo: UnifiedConvo[] = conversations.map((c) => ({
      id: c.id,
      live: false,
      channel: c.channel,
      name: c.patientName,
      preview: c.preview,
      time: c.time,
      unread: c.unread,
      lifecycle: demoLifecycle[c.id] ?? "New Lead",
      tags: c.tags,
      patientId: c.patientId,
    }));
    return [...live, ...demo];
  }, [liveConvos, liveStage, demoLifecycle]);

  // Open straight on the most recent conversation (live ones come first, newest
  // first) instead of a blank/empty thread. Keeps following the newest until the
  // user clicks a conversation, so it lands on the latest live chat once it loads.
  useEffect(() => {
    if (userPicked.current || unified.length === 0) return;
    setActiveId(unified[0].id);
  }, [unified]);

  const demoUnreplied = (id: string, base: Message[]) => {
    const thread = [...base, ...(extraMessages[id] ?? [])];
    return thread.length > 0 && thread[thread.length - 1].direction === "inbound";
  };
  const isMine = (u: UnifiedConvo) => mineSet.has(u.id) || (!u.live && conversations.find((c) => c.id === u.id)?.assignedTo === ME);
  const isUnassigned = (u: UnifiedConvo) => {
    if (u.live) return !liveAssign[u.id];
    const c = conversations.find((x) => x.id === u.id)!;
    return !c.assignedTo && !demoAssignments[u.id] && !mineSet.has(u.id);
  };
  const unreplied = (u: UnifiedConvo) => {
    if (u.live) return u.unread > 0;
    const c = conversations.find((x) => x.id === u.id)!;
    return demoUnreplied(u.id, c.messages);
  };

  const list = unified.filter((u) => {
    if (channel !== "all" && u.channel !== channel) return false;
    if (view === "mine" && !isMine(u)) return false;
    if (view === "unassigned" && !isUnassigned(u)) return false;
    if (lifecycleFilter && u.lifecycle !== lifecycleFilter) return false;
    if (unrepliedOnly && !unreplied(u)) return false;
    return true;
  });

  const counts = {
    all: unified.length,
    mine: unified.filter(isMine).length,
    unassigned: unified.filter(isUnassigned).length,
  };
  const lifecycleCounts = (stage: string) => unified.filter((u) => u.lifecycle === stage).length;

  const active = unified.find((u) => u.id === activeId) ?? unified[0];
  const demoConvo = active && !active.live ? conversations.find((c) => c.id === active.id) : undefined;
  const patient = active?.patientId ? [...livePatients, ...mockPatients].find((p) => p.id === active.patientId) : undefined;

  // Active thread (normalized). `audioUrl` carries voice notes generated with ElevenLabs.
  const baseThread: ThreadItem[] = active?.live
    ? liveMessages.map((m) => ({ id: m.id, direction: m.direction, author: m.author, body: m.body, time: fmtTime(m.createdAt), byBot: m.byBot }))
    : demoConvo
      ? [...demoConvo.messages, ...(extraMessages[active!.id] ?? [])]
      : [];
  const thread: ThreadItem[] = active ? [...baseThread, ...(voiceNotes[active.id] ?? [])] : baseThread;

  // Always open on the latest message; re-scroll as new ones arrive.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight; // onScroll then clears the jump button
  }, [activeId, thread.length]);

  const humanHandled = !!active?.live && liveStatus[active.id] === "human";
  const currentAssignee = active?.live ? liveAssignee[active.id] ?? null : null;
  const hubDefault = active && !humanHandled ? channelDefaults.find((d) => d.channel === active.channel && d.enabled && d.agentId) : undefined;
  const activeAgentId = active?.live ? liveAssign[active.id] ?? null : demoAssignments[active?.id ?? ""] ?? null;
  const assignedAgent = humanHandled ? null : agents.find((a) => a.id === activeAgentId) ?? agents.find((a) => a.id === hubDefault?.agentId) ?? null;
  const windowClosed = active?.channel === "whatsapp" && thread.length > 0 && thread[thread.length - 1].direction === "outbound";

  // One "Assign to" control covering both AI agents and people (Me / teammates).
  const assignValue = humanHandled
    ? currentAssignee === ME
      ? "me"
      : currentAssignee
        ? `person:${currentAssignee}`
        : ""
    : activeAgentId
      ? `agent:${activeAgentId}`
      : "";
  function onAssign(v: string) {
    if (v === "me") return assignToMe();
    if (v.startsWith("agent:")) return assignAgentForActive(v.slice(6));
    if (v.startsWith("person:")) return assignToPerson(v.slice(7));
    assignAgentForActive(""); // Unassigned / back to hub default
  }

  async function send() {
    if (!draft.trim() || !active) return;
    const text = draft.trim();
    setSendError(null);
    if (active.live) {
      setSending(true);
      const res = await sendWaReply(active.id, text, ME);
      setSending(false);
      if (!res.ok) {
        // Keep the text so it can be retried, and show why it failed (often the 24h window).
        setSendError(res.error ?? "Send failed — the message was not delivered.");
        return;
      }
      setDraft("");
      fetchWaMessages(active.id).then(setLiveMessages);
    } else {
      setDraft("");
      const msg: Message = { id: nextId("local"), direction: "outbound", author: ME, body: text, time: "Just now" };
      setExtraMessages((prev) => ({ ...prev, [active.id]: [...(prev[active.id] ?? []), msg] }));
    }
  }

  // Turn the typed message into a voice note with the selected ElevenLabs voice
  // (premade or your own cloned voice) and drop it into the thread.
  async function sendVoiceNote() {
    const text = draft.trim();
    if (!text || !active || voiceBusy) return;
    if (!voiceId) { toast("Pick a voice first — add ELEVENLABS_API_KEY in Netlify if the list is empty.", "info"); return; }
    setVoiceBusy(true);
    try {
      const res = await fetch("/api/voice/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voiceId, text }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error ?? "Voice note failed");
      }
      const audioUrl = URL.createObjectURL(await res.blob());
      const note: ThreadItem = { id: nextId("vn"), direction: "outbound", author: ME, body: text, time: "Just now", audioUrl };
      setVoiceNotes((prev) => ({ ...prev, [active.id]: [...(prev[active.id] ?? []), note] }));
      setDraft("");
      toast("Voice note ready — recorded in your selected voice.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not create the voice note", "info");
    } finally {
      setVoiceBusy(false);
    }
  }

  function assignAgentForActive(agentId: string) {
    if (!active) return;
    if (active.live) {
      // Handing (back) to an AI agent re-opens the conversation for auto-replies.
      setLiveAssign((prev) => ({ ...prev, [active.id]: agentId || null }));
      setLiveStatus((prev) => ({ ...prev, [active.id]: "open" }));
      setLiveAssignee((prev) => ({ ...prev, [active.id]: null }));
      setMineSet((prev) => { const n = new Set(prev); n.delete(active.id); return n; });
      assignWaAgent(active.id, agentId || null);
      setWaAssignee(active.id, null);
      if (agentId) toast(`Handed back to ${agents.find((a) => a.id === agentId)?.name ?? "the agent"} — AI will reply again.`);
    } else {
      setDemoAssignments((prev) => ({ ...prev, [active.id]: agentId }));
      if (agentId) assignAgent(active.id, agentId);
    }
  }

  function assignToMe() {
    if (!active) return;
    setMineSet((prev) => new Set(prev).add(active.id));
    if (active.live) {
      // Mark the conversation human-handled so the webhook stops auto-replying.
      setLiveAssign((prev) => ({ ...prev, [active.id]: null }));
      setLiveStatus((prev) => ({ ...prev, [active.id]: "human" }));
      setLiveAssignee((prev) => ({ ...prev, [active.id]: ME }));
      assignWaAgent(active.id, null);
      setWaAssignee(active.id, ME);
    } else {
      setDemoAssignments((prev) => { const n = { ...prev }; delete n[active.id]; return n; });
    }
    toast(`${active.name}'s conversation is assigned to you — the AI agent steps back until you hand it back.`);
  }

  // Assign a live conversation to a teammate (by name/email). The AI steps back so
  // that teammate handles the patient personally. Empty value clears the assignee.
  function assignToPerson(person: string) {
    if (!active) return;
    if (!person) { assignAgentForActive(""); setLiveAssignee((prev) => ({ ...prev, [active.id]: null })); return; }
    if (active.live) {
      setLiveAssign((prev) => ({ ...prev, [active.id]: null }));
      setLiveStatus((prev) => ({ ...prev, [active.id]: "human" }));
      setLiveAssignee((prev) => ({ ...prev, [active.id]: person }));
      setMineSet((prev) => { const n = new Set(prev); n.delete(active.id); return n; });
      assignWaAgent(active.id, null);
      setWaAssignee(active.id, person);
    } else {
      setDemoAssignments((prev) => { const n = { ...prev }; delete n[active.id]; return n; });
    }
    toast(`${active.name}'s conversation is assigned to ${person} — they'll handle the reply.`);
  }

  function setStage(stage: string) {
    if (!active) return;
    if (active.live) { setLiveStage((prev) => ({ ...prev, [active.id]: stage })); setWaLifecycle(active.id, stage); }
    else setDemoLifecycle((prev) => ({ ...prev, [active.id]: stage }));
    toast(`${active.name} moved to “${stage}”.`);
  }

  async function aiReply() {
    if (!active) return;
    const agent = assignedAgent;
    if (!agent) { setAiError("Assign an agent to this chat, or set a default for this channel in AI Agents → Agent Hub."); return; }
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
          behavior: agent.behavior,
          knowledgeBase: agent.knowledgeBase,
          capabilities: { canBook: agent.canBook, canReschedule: agent.canReschedule, canCancel: agent.canCancel },
          patientContext: patient ? `Name: ${patient.name}. Insurance: ${patient.insurance}. Last visit: ${patient.lastVisit}. Next appointment: ${patient.nextAppointment ?? "none"}. Balance: $${patient.balance}.` : "",
          messages: thread.map((m) => ({ role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const), content: m.body })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "AI request failed");
      if (active.live) {
        await sendWaReply(active.id, data.reply, `${agent.name} (AI)`);
        fetchWaMessages(active.id).then(setLiveMessages);
      } else {
        const msg: Message = { id: nextId("ai"), direction: "outbound", author: `${agent.name} (AI)`, byBot: true, body: data.reply, time: "Just now" };
        setExtraMessages((prev) => ({ ...prev, [active.id]: [...(prev[active.id] ?? []), msg] }));
      }
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "AI reply failed.");
    } finally {
      setAiBusy(false);
    }
  }

  const stageTone = (stage: string) => LIFECYCLE.find((l) => l.key === stage)?.tone ?? "blue";
  if (!active) return null;

  return (
    <Card className="flex h-[calc(100vh-106px)] overflow-hidden">
      {/* 1 — rail */}
      <div className="hidden w-52 shrink-0 flex-col border-r border-ink-200 bg-ink-50/40 md:flex">
        <div className="flex items-center justify-between border-b border-ink-200 px-4 py-3.5">
          <h1 className="flex items-center gap-2 font-semibold text-ink-900"><InboxIcon className="h-4 w-4 text-brand-500" /> Inbox</h1>
          <button onClick={refreshLive} title="Refresh" className="rounded-lg p-1 text-ink-400 hover:bg-ink-100"><RefreshCw className="h-3.5 w-3.5" /></button>
        </div>
        <div className="space-y-0.5 p-2">
          {([["all", "All", InboxIcon, counts.all], ["mine", "Mine", UserCheck, counts.mine], ["unassigned", "Unassigned", CircleSlash, counts.unassigned]] as const).map(([key, label, Icon, count]) => (
            <button key={key} onClick={() => setView(key)} className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-colors ${view === key ? "bg-brand-50 text-brand-600 dark:text-brand-300" : "text-ink-600 hover:bg-ink-100"}`}>
              <span className="flex items-center gap-2.5"><Icon className="h-4 w-4 text-ink-400" /> {label}</span>
              <span className="text-xs text-ink-400">{count.toLocaleString()}</span>
            </button>
          ))}
        </div>
        <div className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-400">Lifecycle</div>
        <div className="space-y-0.5 p-2 pt-1">
          {LIFECYCLE.map((l) => (
            <button key={l.key} onClick={() => setLifecycleFilter((cur) => (cur === l.key ? null : l.key))} className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-colors ${lifecycleFilter === l.key ? "bg-brand-50" : "hover:bg-ink-100"}`}>
              <StatusBadge status={l.key} tone={l.tone} />
              <span className="text-xs text-ink-400">{lifecycleCounts(l.key)}</span>
            </button>
          ))}
        </div>
        <Link href="/dashboard/agents/chat" className="m-2 mt-auto flex items-center justify-center gap-2 rounded-lg border border-dashed border-ink-300 px-3 py-2 text-sm font-medium text-ink-500 hover:border-brand-400 hover:text-brand-600 dark:hover:text-brand-300">
          <Bot className="h-4 w-4" /> Create AI agent
        </Link>
      </div>

      {/* 2 — chat list */}
      <div className="flex w-full shrink-0 flex-col border-r border-ink-200 sm:w-80">
        <div className="flex items-center gap-1 overflow-x-auto border-b border-ink-200 px-2 py-2">
          {CHANNEL_TABS.map((t) => (
            <button key={t.key} onClick={() => setChannel(t.key)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${channel === t.key ? "bg-brand-600 text-white" : "text-ink-500 hover:bg-ink-100"}`}>{t.label}</button>
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
          {list.map((u) => (
            <button key={u.id} onClick={() => { userPicked.current = true; setActiveId(u.id); }} className={`flex w-full items-start gap-3 border-b border-ink-100 px-3.5 py-3 text-left transition-colors ${u.id === active.id ? "bg-brand-50/60" : "hover:bg-ink-50"}`}>
              <Avatar name={u.name} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-medium text-ink-900">{u.name}{u.live && <span className="ml-1.5 rounded bg-emerald-500/15 px-1 text-[9px] font-semibold uppercase text-emerald-600">live</span>}</p>
                  <span className="shrink-0 text-[11px] text-ink-400">{u.time}</span>
                </div>
                <p className="mt-0.5 truncate text-xs text-ink-500">{u.preview}</p>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <ChannelBadge channel={u.channel} />
                  <StatusBadge status={u.lifecycle} tone={stageTone(u.lifecycle)} />
                  {u.unread > 0 && <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[10px] font-semibold text-white">{u.unread}</span>}
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
            <Avatar name={active.name} size="sm" />
            <div>
              <p className="flex items-center gap-2 text-sm font-semibold text-ink-900">
                {active.name} <StatusBadge status={active.lifecycle} tone={stageTone(active.lifecycle)} />
                {humanHandled && <StatusBadge status={currentAssignee === ME ? "You" : currentAssignee ? currentAssignee : "Human"} tone="blue" />}
              </p>
              <p className="text-xs text-ink-400">via {channelMeta[active.channel].label}{active.phone ? ` · +${active.phone}` : ""}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label className="px-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-400">Lifecycle</label>
              <select value={active.lifecycle} onChange={(e) => setStage(e.target.value)} className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-700 outline-none" title="Lifecycle stage">
                {LIFECYCLE.map((l) => <option key={l.key} value={l.key}>{l.key}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="px-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-400">Assign to</label>
              <select
                value={assignValue}
                onChange={(e) => onAssign(e.target.value)}
                className="min-w-44 rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-700 outline-none"
                title="Assign this conversation to an AI agent or a teammate"
              >
                <option value="">{hubDefault ? `Hub default — ${agents.find((a) => a.id === hubDefault.agentId)?.name ?? "agent"}` : "Unassigned"}</option>
                <optgroup label="AI agents">
                  {agents.map((a) => <option key={a.id} value={`agent:${a.id}`}>🤖 {a.name} — {a.role}</option>)}
                </optgroup>
                <optgroup label="Team">
                  <option value="me">Me ({ME})</option>
                  {team.map((m) => <option key={m.id} value={`person:${m.name || m.email}`}>{m.name || m.email}{m.role ? ` — ${m.role}` : ""}</option>)}
                </optgroup>
              </select>
            </div>
          </div>
        </div>

        <div className="relative flex-1 overflow-hidden">
        <div ref={threadRef} onScroll={onThreadScroll} className="h-full space-y-4 overflow-y-auto bg-ink-50/40 p-5">
          {thread.length === 0 && <p className="py-10 text-center text-sm text-ink-400">No messages yet.</p>}
          {thread.map((m) => (
            <div key={m.id} className={`flex ${m.direction === "outbound" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${m.direction === "outbound" ? "rounded-br-sm bg-brand-600 text-white" : "rounded-bl-sm border border-ink-200 bg-surface text-ink-800"}`}>
                <p className={`mb-1 flex items-center gap-1 text-[11px] font-semibold ${m.direction === "outbound" ? "text-brand-100" : "text-ink-400"}`}>{m.byBot && <Bot className="h-3 w-3" />}{m.audioUrl && <Mic className="h-3 w-3" />} {m.author} · {m.time}{m.audioUrl ? " · voice note" : ""}</p>
                {m.audioUrl && <audio controls src={m.audioUrl} className="mb-1.5 w-56 max-w-full" />}
                {m.body}
              </div>
            </div>
          ))}
        </div>
        {showJump && (
          <button
            onClick={scrollToBottom}
            title="Jump to latest"
            className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white shadow-lg hover:bg-brand-700"
          >
            <ArrowDown className="h-3.5 w-3.5" /> Latest
          </button>
        )}
        </div>

        <div className="border-t border-ink-200 p-4">
          {windowClosed && active.channel === "whatsapp" && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-700">
              <span className="font-semibold">WhatsApp 24-hour window may be closed.</span>
              <span className="text-amber-600/90">If the contact hasn&apos;t replied in 24h, Meta only allows an approved template.</span>
              <Link href="/dashboard/whatsapp/templates" className="ml-auto rounded-lg bg-amber-500 px-2.5 py-1 font-semibold text-white hover:bg-amber-600">Send template</Link>
            </div>
          )}
          {aiError && <p className="mb-2 text-xs text-amber-600">{aiError}</p>}
          {sendError && (
            <p className="mb-2 rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-600">
              Not delivered: {sendError}
            </p>
          )}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs font-medium text-ink-500"><Mic className="h-3.5 w-3.5 text-brand-500" /> Voice note</span>
            <select
              value={voiceId}
              onChange={(e) => setVoiceId(e.target.value)}
              className="rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-xs font-medium text-ink-700 outline-none"
              title="Voice for the note (your cloned voice or a premade one)"
            >
              {voices.length === 0 && <option value="">No voices — add ELEVENLABS_API_KEY</option>}
              {voices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
            <button
              onClick={sendVoiceNote}
              disabled={voiceBusy || !draft.trim()}
              title="Turn your typed message into a voice note in the selected voice"
              className="flex items-center gap-1.5 rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-brand-600 hover:bg-brand-50 disabled:opacity-50 dark:text-brand-300"
            >
              <Mic className={`h-3.5 w-3.5 ${voiceBusy ? "animate-pulse" : ""}`} /> {voiceBusy ? "Generating…" : "Send as voice note"}
            </button>
            <Link href="/dashboard/agents/voice" className="text-xs text-ink-400 hover:text-brand-600">+ Create your own voice</Link>
          </div>
          <div className="flex items-end gap-2">
            <button onClick={() => toast("Template picker opens here — choose an approved WhatsApp/Email template.", "info")} title="Insert a template" className="rounded-xl border border-ink-200 p-2.5 text-ink-500 hover:bg-ink-50"><FileText className="h-5 w-5" /></button>
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} rows={2} placeholder={`Reply on ${channelMeta[active.channel].label}…`} className="flex-1 resize-none rounded-xl border border-ink-200 bg-surface px-3.5 py-2.5 text-sm text-ink-800 outline-none placeholder:text-ink-400 focus:border-brand-400" />
            <button onClick={aiReply} disabled={aiBusy} title={assignedAgent ? `Let ${assignedAgent.name} reply` : "Let the AI agent reply"} className="flex items-center gap-1.5 rounded-xl border border-ink-200 px-3 py-2.5 text-sm font-medium text-brand-600 hover:bg-brand-50 disabled:opacity-50 dark:text-brand-300"><Sparkles className={`h-5 w-5 ${aiBusy ? "animate-pulse" : ""}`} /> {aiBusy ? "Thinking…" : "AI reply"}</button>
            <button onClick={send} disabled={sending} className="rounded-xl bg-brand-600 p-2.5 text-white hover:bg-brand-700 disabled:opacity-50"><Send className="h-5 w-5" /></button>
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
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="flex items-center gap-3">
              <Avatar name={active.name} />
              <div>
                <p className="font-semibold text-ink-900">{active.name}</p>
                {active.phone && <p className="text-xs text-ink-400">+{active.phone}</p>}
              </div>
            </div>
            <p className="text-sm text-ink-500">{active.live ? "Live WhatsApp lead — not yet a patient record." : "New lead — no patient record yet."}</p>
            <Link href="/dashboard/patients" className="inline-block rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700">Create contact</Link>
          </div>
        )}
      </div>
    </Card>
  );
}
