"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, Send, ArrowLeft, Bot, Lock, Megaphone, Search, Radio, Mail } from "lucide-react";
import { Card, PageHeader } from "@/components/ui";
import { inputCls } from "@/components/modal";
import { fetchClinicSettings } from "@/lib/db";

// The four pre-built marketing agents (enrichlabs-style). Each has a persona and a
// system brief. `locked` is controlled by the clinic's package (all open for now).
interface MarketingAgent {
  key: string;
  name: string;
  role: string;
  blurb: string;
  gradient: string;
  icon: typeof Megaphone;
  brief: string;
}

const AGENTS: MarketingAgent[] = [
  {
    key: "helena",
    name: "Helena",
    role: "AI Digital Marketer",
    blurb: "Plans campaigns, writes posts & blogs, and turns your brand docs into content.",
    gradient: "from-violet-100 to-fuchsia-100",
    icon: Megaphone,
    brief:
      "You are Helena, an AI Digital Marketer for a dental clinic. You plan campaigns, write social posts and blog drafts, suggest content calendars, and adapt everything to the clinic's brand. Be practical and concise; produce ready-to-use copy when asked.",
  },
  {
    key: "sam",
    name: "Sam",
    role: "AI SEO / GEO Manager",
    blurb: "Improves search rankings, local SEO and Google Business presence.",
    gradient: "from-emerald-100 to-teal-100",
    icon: Search,
    brief:
      "You are Sam, an AI SEO/GEO Manager for a dental clinic. You advise on keywords, on-page SEO, local SEO, Google Business Profile, and content that ranks. Give specific, actionable recommendations and example titles/meta descriptions.",
  },
  {
    key: "kai",
    name: "Kai",
    role: "AI Social Listening Manager",
    blurb: "Tracks mentions, reviews and trends, and drafts replies.",
    gradient: "from-sky-100 to-blue-100",
    icon: Radio,
    brief:
      "You are Kai, an AI Social Listening Manager for a dental clinic. You summarize what patients say online, monitor reviews and trends, flag issues, and draft on-brand replies to comments and reviews.",
  },
  {
    key: "angela",
    name: "Angela",
    role: "AI Email Marketer",
    blurb: "Writes recalls, newsletters and follow-up email sequences.",
    gradient: "from-lime-100 to-green-100",
    icon: Mail,
    brief:
      "You are Angela, an AI Email Marketer for a dental clinic. You write recall reminders, newsletters, promotions and follow-up sequences. Produce subject lines + body copy, friendly and compliant, ready to send.",
  },
];

// All unlocked for now. Later this comes from the clinic's package/entitlements.
const UNLOCKED = new Set(AGENTS.map((a) => a.key));

export default function MarketingAgentsPage() {
  const [active, setActive] = useState<MarketingAgent | null>(null);
  const [website, setWebsite] = useState("");

  useEffect(() => {
    fetchClinicSettings().then((s) => setWebsite(s.website));
  }, []);

  if (active) return <AgentChat agent={active} website={website} onBack={() => setActive(null)} />;

  return (
    <>
      <PageHeader
        title="Marketing AI team"
        subtitle="Pre-built AI specialists that know your clinic and do the work — chat with them like a teammate."
      />
      <div className="grid gap-5 md:grid-cols-2">
        {AGENTS.map((a) => {
          const unlocked = UNLOCKED.has(a.key);
          const Icon = a.icon;
          return (
            <div key={a.key} className={`relative overflow-hidden rounded-2xl bg-gradient-to-br ${a.gradient} p-6`}>
              <div className="relative z-10 max-w-[70%]">
                <p className="text-xs font-medium text-ink-500">{a.role}</p>
                <h2 className="mt-1 text-2xl font-semibold text-ink-900">{a.name}</h2>
                <p className="mt-2 text-sm text-ink-600">{a.blurb}</p>
                <button
                  onClick={() => unlocked && setActive(a)}
                  disabled={!unlocked}
                  className={`mt-5 flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold ${
                    unlocked ? "bg-white/80 text-ink-900 hover:bg-white" : "cursor-not-allowed bg-white/50 text-ink-400"
                  }`}
                >
                  {unlocked ? (<><Sparkles className="h-4 w-4" /> Open chat</>) : (<><Lock className="h-4 w-4" /> Locked — upgrade</>)}
                </button>
              </div>
              <Icon className="absolute -bottom-6 -right-6 h-40 w-40 text-white/40" strokeWidth={1} />
            </div>
          );
        })}
      </div>

      <Card className="mt-6 flex items-start gap-2 p-4 text-sm text-ink-500">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
        <span>
          These specialists chat and draft content now. Connecting your channels (WordPress, Instagram, Google) lets them
          <strong> publish and pull reports</strong> too — that&apos;s the next step. Lock/unlock is controlled by each clinic&apos;s package.
        </span>
      </Card>
    </>
  );
}

function AgentChat({ agent, website, onBack }: { agent: MarketingAgent; website: string; onBack: () => void }) {
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

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
          model: "openai/gpt-4o-mini",
          agentName: agent.name,
          instructions: agent.brief,
          knowledgeBase: website ? `The clinic's website is ${website}. Reference its services and brand when relevant.` : "",
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
    <>
      <button onClick={onBack} className="mb-4 flex items-center gap-1.5 text-sm font-medium text-ink-500 hover:text-ink-800">
        <ArrowLeft className="h-4 w-4" /> Back to team
      </button>
      <Card className="flex h-[calc(100vh-160px)] flex-col">
        <div className="flex items-center gap-3 border-b border-ink-200 px-5 py-3.5">
          <div className={`flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br ${agent.gradient}`}>
            <agent.icon className="h-4 w-4 text-ink-700" />
          </div>
          <div>
            <p className="text-sm font-semibold text-ink-900">{agent.name}</p>
            <p className="text-xs text-ink-400">{agent.role}</p>
          </div>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto bg-ink-50/40 p-5">
          {messages.length === 0 && (
            <div className="m-auto max-w-md pt-10 text-center">
              <p className="text-sm font-medium text-ink-700">Hi! I&apos;m {agent.name}, your {agent.role}.</p>
              <p className="mt-1 text-sm text-ink-400">Ask me to plan a campaign, write a blog or post, draft emails — whatever your clinic needs.</p>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${m.role === "user" ? "rounded-br-sm bg-brand-600 text-white" : "rounded-bl-sm border border-ink-200 bg-surface text-ink-800"}`}>
                {m.content}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-sm border border-ink-200 bg-surface px-3.5 py-2 text-sm text-ink-400">
                <Bot className="h-4 w-4 animate-pulse" /> {agent.name} is thinking…
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {error && <p className="px-5 pt-2 text-sm text-amber-600">{error}</p>}
        <div className="flex gap-2 border-t border-ink-200 p-4">
          <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder={`Message ${agent.name}…`} className={inputCls} />
          <button onClick={send} disabled={busy} className="rounded-xl bg-brand-600 px-4 text-white hover:bg-brand-700 disabled:opacity-50"><Send className="h-5 w-5" /></button>
        </div>
      </Card>
    </>
  );
}
