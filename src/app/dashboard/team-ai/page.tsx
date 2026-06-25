"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, Send, ArrowLeft, Bot, Lock, Megaphone, Search, Radio, Mail, Check, Plug, Plus, History, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { Card, PageHeader } from "@/components/ui";
import { Modal, Field, ModalFooter, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import {
  fetchClinicSettings,
  fetchConnections,
  getWorkspaceId,
  fetchBrandKnowledge,
  saveBrandKnowledge,
  listTeamChats,
  createTeamChat,
  fetchTeamChatMessages,
  appendTeamChatMessage,
  deleteTeamChat,
  type BrandKnowledge,
  type TeamChat,
} from "@/lib/db";

// Four DENTAL-specific pre-built marketing specialists (enrichlabs-style, tuned for
// a clinic). Each lists what it can do and which connected channels it uses. Access
// is gated by the clinic's package later (admin lock/unlock); all open for now.
interface TeamAgent {
  key: string;
  name: string;
  role: string;
  blurb: string;
  gradient: string;
  icon: typeof Megaphone;
  brief: string;
  features: string[];
  channels: { key: string; label: string; builtin?: boolean }[];
}

const AGENTS: TeamAgent[] = [
  {
    key: "helena",
    name: "Helena",
    role: "AI Dental Marketing Manager",
    blurb: "Plans content, writes posts & blogs, makes visuals, and reviews your ads.",
    gradient: "from-violet-100 to-fuchsia-100",
    icon: Megaphone,
    brief:
      "You are Helena, an AI Dental Marketing Manager for a dental clinic. You plan content calendars around dental services (cleanings, implants, whitening, Invisalign, check-ups), write social posts and SEO blog drafts, create captions with hashtags and CTAs, suggest post visuals and before/after-style ideas, and review Meta/Google/TikTok ad performance with new ad copy. Always tailor to the clinic's brand and keep dental claims compliant (no guarantees, no medical advice).",
    features: [
      "Plan a monthly content calendar for your treatments & promos",
      "Write SEO blog posts and draft them to WordPress",
      "Create Instagram / Facebook / TikTok posts with captions, hashtags & CTAs",
      "Suggest post visuals and before/after-style concepts",
      "Review Meta / Google / TikTok ad performance and draft new ad copy",
      "Daily marketing summary with what to do next",
    ],
    channels: [
      { key: "instagram", label: "Instagram" },
      { key: "facebook", label: "Facebook" },
      { key: "tiktok", label: "TikTok" },
      { key: "wordpress_self", label: "WordPress" },
      { key: "meta_ads", label: "Meta Ads" },
      { key: "google_ads", label: "Google Ads" },
    ],
  },
  {
    key: "sam",
    name: "Sam",
    role: "AI Dental SEO / Local Search Manager",
    blurb: "Wins “dentist near me”, optimises your Google Business Profile & rankings.",
    gradient: "from-emerald-100 to-teal-100",
    icon: Search,
    brief:
      "You are Sam, an AI Dental SEO / Local Search Manager. You improve local search ('dentist near me', city + treatment keywords), optimise the Google Business Profile, do keyword research for dental services, audit and rewrite pages (titles/meta), track rankings/clicks/impressions, and structure content (FAQ schema) so AI search engines cite the clinic. Give specific, dental-relevant recommendations.",
    features: [
      "Keyword research — real volumes, competition & CPC (DataForSEO)",
      "Find your competitors & the keywords they rank for (gap analysis)",
      "Backlink profile — referring domains & authority",
      "Live SERP checks — see who ranks for any term",
      "Optimise your Google Business Profile + local 'dentist near me'",
      "Track Search Console rankings + audit & fix pages (titles, meta, schema)",
    ],
    channels: [
      { key: "google_search_console", label: "Search Console" },
      { key: "google_analytics", label: "Analytics" },
      { key: "google_business", label: "Business Profile" },
      { key: "wordpress_self", label: "WordPress" },
    ],
  },
  {
    key: "kai",
    name: "Kai",
    role: "AI Reputation & Social Listening",
    blurb: "Watches reviews & mentions, flags unhappy patients, drafts replies.",
    gradient: "from-sky-100 to-blue-100",
    icon: Radio,
    brief:
      "You are Kai, an AI Reputation & Social Listening manager for a dental clinic. You monitor reviews (Google, Facebook) and social mentions, track patient sentiment, flag unhappy patients early so the team can fix it, draft on-brand replies to reviews and comments, watch competitor clinics, and surface trending dental topics worth posting about.",
    features: [
      "Monitor Google & Facebook reviews and social mentions",
      "Track patient sentiment and flag unhappy patients early",
      "Draft on-brand replies to reviews and comments",
      "Watch competitor clinics & share of voice",
      "Spot trending dental topics to post about",
    ],
    channels: [
      { key: "google_business", label: "Reviews (GBP)" },
      { key: "instagram", label: "Instagram" },
      { key: "facebook", label: "Facebook" },
      { key: "reddit", label: "Reddit" },
    ],
  },
  {
    key: "angela",
    name: "Angela",
    role: "AI Patient Email & WhatsApp Marketing",
    blurb: "Writes recalls, newsletters, win-backs and WhatsApp broadcasts.",
    gradient: "from-lime-100 to-green-100",
    icon: Mail,
    brief:
      "You are Angela, an AI Patient Email & WhatsApp Marketing manager for a dental clinic. You write recall reminders ('time for your cleaning'), newsletters, seasonal promotions, reactivation/win-back messages for lapsed patients, post-treatment follow-up sequences, and WhatsApp broadcast copy that fits Meta's template rules. Produce subject lines + body, friendly and compliant, ready to send.",
    features: [
      "Recall reminders — “time for your cleaning”",
      "Newsletters & seasonal promotions",
      "Reactivation / win-back for lapsed patients",
      "Post-treatment follow-up sequences",
      "WhatsApp broadcast copy that fits Meta templates",
    ],
    channels: [
      { key: "whatsapp", label: "WhatsApp", builtin: true },
      { key: "email", label: "Email", builtin: true },
    ],
  },
];

const UNLOCKED = new Set(AGENTS.map((a) => a.key)); // package gating comes with the admin panel

export default function TeamAiPage() {
  const [active, setActive] = useState<TeamAgent | null>(null);

  if (active) return <AgentWorkspace agent={active} onBack={() => setActive(null)} />;

  return (
    <>
      <PageHeader
        title="AI Team"
        subtitle="Pre-built AI specialists for your clinic — they know your brand and do the marketing work. Chat with them like a teammate."
      />
      <div className="grid gap-5 md:grid-cols-2">
        {AGENTS.map((a) => {
          const unlocked = UNLOCKED.has(a.key);
          const Icon = a.icon;
          return (
            <div key={a.key} className={`relative overflow-hidden rounded-2xl bg-gradient-to-br ${a.gradient} p-6`}>
              <div className="relative z-10 max-w-[72%]">
                <p className="text-xs font-medium text-ink-500">{a.role}</p>
                <h2 className="mt-1 text-2xl font-semibold text-ink-900">{a.name}</h2>
                <p className="mt-2 text-sm text-ink-600">{a.blurb}</p>
                <button
                  onClick={() => unlocked && setActive(a)}
                  disabled={!unlocked}
                  className={`mt-5 flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold ${unlocked ? "bg-white/80 text-ink-900 hover:bg-white" : "cursor-not-allowed bg-white/50 text-ink-400"}`}
                >
                  {unlocked ? (<><Sparkles className="h-4 w-4" /> Open</>) : (<><Lock className="h-4 w-4" /> Locked — upgrade</>)}
                </button>
              </div>
              <Icon className="absolute -bottom-6 -right-6 h-40 w-40 text-white/40" strokeWidth={1} />
            </div>
          );
        })}
      </div>
      <Card className="mt-6 flex items-start gap-2 p-4 text-sm text-ink-500">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
        <span>These specialists chat and draft content now. As you connect channels (WordPress, Instagram, Google), they&apos;ll <strong>publish and pull reports</strong> too. Lock/unlock per package arrives with the admin panel.</span>
      </Card>
    </>
  );
}

function AgentWorkspace({ agent, onBack }: { agent: TeamAgent; onBack: () => void }) {
  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [website, setWebsite] = useState("");
  const [ws, setWs] = useState<string | null>(null);
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const [brand, setBrand] = useState<BrandKnowledge>({ profile: "", logoUrl: "", colors: "" });
  const [brandOpen, setBrandOpen] = useState(false);
  const [chats, setChats] = useState<TeamChat[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  function refreshChats() { listTeamChats(agent.key).then(setChats); }

  useEffect(() => {
    fetchConnections().then((c) => setConnected(new Set(c.map((x) => x.provider))));
    fetchClinicSettings().then((s) => setWebsite(s.website));
    fetchBrandKnowledge().then(setBrand);
    getWorkspaceId().then(setWs);
    refreshChats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.key]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  function newSession() {
    setChatId(null);
    setMessages([]);
    setShowHistory(false);
  }
  async function openChat(c: TeamChat) {
    setShowHistory(false);
    setChatId(c.id);
    setMessages(await fetchTeamChatMessages(c.id));
  }

  const brandContext = [brand.profile, brand.colors && `Brand colours: ${brand.colors}`].filter(Boolean).join("\n");

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setError(null);
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setBusy(true);

    // Persist the conversation (create a session on the first message).
    let cid = chatId;
    if (!cid) { cid = await createTeamChat(agent.key, text); setChatId(cid); refreshChats(); }
    if (cid) appendTeamChatMessage(cid, "user", text);

    try {
      const TOOL_ROUTES: Record<string, string> = { helena: "/api/team/helena", sam: "/api/team/sam", kai: "/api/team/kai", angela: "/api/team/angela" };
      const toolRoute = TOOL_ROUTES[agent.key];
      const res = await fetch(toolRoute ?? "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          toolRoute
            ? { workspaceId: ws, website, brand: brandContext, messages: next }
            : {
                model: "openai/gpt-4o-mini",
                agentName: agent.name,
                instructions: agent.brief,
                knowledgeBase: [website && `The clinic's website is ${website}.`, brandContext].filter(Boolean).join("\n"),
                messages: next,
              }
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "AI request failed");
      setMessages((m) => [...m, { role: "assistant", content: data.reply }]);
      if (cid) appendTeamChatMessage(cid, "assistant", data.reply);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {brandOpen && <BrandModal brand={brand} onClose={() => setBrandOpen(false)} onSaved={(b) => { setBrand(b); setBrandOpen(false); }} />}
      <button onClick={onBack} className="mb-4 flex items-center gap-1.5 text-sm font-medium text-ink-500 hover:text-ink-800">
        <ArrowLeft className="h-4 w-4" /> Back to AI Team
      </button>
      <div className="grid gap-5 lg:grid-cols-[340px_1fr]">
        {/* Left: identity + capabilities + channels + brand */}
        <div className="space-y-4">
          <Card className="p-5">
            <div className="flex items-center gap-3">
              <div className={`flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br ${agent.gradient}`}><agent.icon className="h-5 w-5 text-ink-700" /></div>
              <div>
                <p className="font-semibold text-ink-900">{agent.name}</p>
                <p className="text-xs text-ink-400">{agent.role}</p>
              </div>
            </div>
            <p className="mt-3 text-sm text-ink-600">{agent.blurb}</p>
          </Card>

          <Card className="p-5">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">What I can do</p>
            <ul className="space-y-2">
              {agent.features.map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm text-ink-700"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" /> {f}</li>
              ))}
            </ul>
          </Card>

          <Card className="p-5">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Channels</p>
            <div className="flex flex-wrap gap-1.5">
              {agent.channels.map((ch) => {
                const on = ch.builtin || connected.has(ch.key);
                return (
                  <span key={ch.key} className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${on ? "bg-emerald-500/15 text-emerald-600" : "bg-ink-100 text-ink-400"}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-emerald-500" : "bg-ink-300"}`} /> {ch.label}
                  </span>
                );
              })}
            </div>
            <Link href="/dashboard/settings?tab=connections" className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-brand-600 hover:text-brand-700"><Plug className="h-3.5 w-3.5" /> Manage connections</Link>
          </Card>

          <Card className="p-5">
            <div className="mb-1 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Brand knowledge</p>
              <button onClick={() => setBrandOpen(true)} className="flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"><Pencil className="h-3 w-3" /> Edit</button>
            </div>
            {brand.profile ? (
              <p className="line-clamp-4 whitespace-pre-wrap text-sm text-ink-600">{brand.profile}</p>
            ) : (
              <p className="text-sm text-ink-400">Tell {agent.name} about your clinic — name, services, tone, key facts — so every reply sounds like you.</p>
            )}
            {website && <p className="mt-2 truncate text-xs text-ink-400">Website: {website}</p>}
          </Card>
        </div>

        {/* Right: chat */}
        <Card className="flex h-[calc(100vh-180px)] flex-col">
          <div className="flex items-center justify-between gap-2 border-b border-ink-200 px-5 py-2.5">
            <span className="flex items-center gap-2 text-sm font-medium text-ink-600"><Bot className="h-4 w-4 text-brand-500" /> {agent.name}</span>
            <div className="relative flex items-center gap-1.5">
              <button onClick={() => setShowHistory((v) => !v)} className="flex items-center gap-1 rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50">
                <History className="h-3.5 w-3.5" /> History{chats.length ? ` (${chats.length})` : ""}
              </button>
              <button onClick={newSession} className="flex items-center gap-1 rounded-lg bg-brand-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-700">
                <Plus className="h-3.5 w-3.5" /> New chat
              </button>
              {showHistory && (
                <div className="absolute right-0 top-9 z-10 max-h-80 w-72 overflow-y-auto rounded-xl border border-ink-200 bg-surface p-1.5 shadow-xl">
                  {chats.length === 0 ? (
                    <p className="px-3 py-4 text-center text-xs text-ink-400">No previous chats yet.</p>
                  ) : (
                    chats.map((c) => (
                      <div key={c.id} className={`group flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-ink-50 ${c.id === chatId ? "bg-brand-50" : ""}`}>
                        <button onClick={() => openChat(c)} className="min-w-0 flex-1 text-left">
                          <p className="truncate text-ink-800">{c.title}</p>
                          <p className="text-[11px] text-ink-400">{(c.updatedAt ?? "").slice(0, 10)}</p>
                        </button>
                        <button onClick={async () => { await deleteTeamChat(c.id); if (c.id === chatId) newSession(); refreshChats(); }} className="rounded p-1 text-ink-300 opacity-0 hover:text-rose-500 group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="flex-1 space-y-4 overflow-y-auto bg-ink-50/40 p-5">
            {messages.length === 0 && (
              <div className="m-auto max-w-md pt-10 text-center">
                <p className="text-sm font-medium text-ink-700">Hi! I&apos;m {agent.name}, your {agent.role}.</p>
                <p className="mt-1 text-sm text-ink-400">Try: “Plan next month&apos;s posts”, “Write a blog about teeth whitening”, or “Draft a recall message”.</p>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${m.role === "user" ? "rounded-br-sm bg-brand-600 text-white" : "rounded-bl-sm border border-ink-200 bg-surface text-ink-800"}`}>{m.content}</div>
              </div>
            ))}
            {busy && <div className="flex justify-start"><div className="flex items-center gap-1.5 rounded-2xl rounded-bl-sm border border-ink-200 bg-surface px-3.5 py-2 text-sm text-ink-400"><Bot className="h-4 w-4 animate-pulse" /> {agent.name} is thinking…</div></div>}
            <div ref={bottomRef} />
          </div>
          {error && <p className="px-5 pt-2 text-sm text-amber-600">{error}</p>}
          <div className="flex gap-2 border-t border-ink-200 p-4">
            <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder={`Message ${agent.name}…`} className={inputCls} />
            <button onClick={send} disabled={busy} className="rounded-xl bg-brand-600 px-4 text-white hover:bg-brand-700 disabled:opacity-50"><Send className="h-5 w-5" /></button>
          </div>
        </Card>
      </div>
    </>
  );
}

function BrandModal({ brand, onClose, onSaved }: { brand: BrandKnowledge; onClose: () => void; onSaved: (b: BrandKnowledge) => void }) {
  const [profile, setProfile] = useState(brand.profile);
  const [colors, setColors] = useState(brand.colors);
  const [logoUrl, setLogoUrl] = useState(brand.logoUrl);
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    const next = { profile, colors, logoUrl };
    const res = await saveBrandKnowledge(next);
    setSaving(false);
    if (!res.ok) { toast(res.message, "info"); return; }
    toast("Brand knowledge saved — your AI team will use it.", "success");
    onSaved(next);
  }

  return (
    <Modal open onClose={onClose} title="Brand knowledge" subtitle="What your AI team should know about your clinic." wide>
      <div className="space-y-4">
        <Field label="About the clinic (name, services, tone, key facts, do's & don'ts)">
          <textarea
            rows={8}
            className={inputCls}
            placeholder={"Clinic: Bright Smile Dental, Dubai Marina. We offer cleanings, implants, Invisalign, whitening and emergency care.\nTone: warm, professional, reassuring. Dr. Leila Hariri leads cosmetic & implants.\nAlways mention free consultation for implants. Never give medical advice or guarantees."}
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
          />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Brand colours (optional)"><input className={inputCls} placeholder="#7c3aed, #10b981" value={colors} onChange={(e) => setColors(e.target.value)} /></Field>
          <Field label="Logo URL (optional)"><input className={inputCls} placeholder="https://…/logo.png" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} /></Field>
        </div>
      </div>
      <ModalFooter onClose={onClose} submitLabel={saving ? "Saving…" : "Save brand knowledge"} onSubmit={submit} />
    </Modal>
  );
}
