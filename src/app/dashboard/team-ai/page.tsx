"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Sparkles, Send, ArrowLeft, Bot, Lock, Megaphone, Search, Radio, Mail, Check, Plug, Plus, History, Pencil, Trash2, FileText, Activity, Clock, Play, Pause, LayoutGrid, Paperclip, Mic, X } from "lucide-react";
import Link from "next/link";
import { Card, PageHeader } from "@/components/ui";
import { Modal, Field, ModalFooter, inputCls } from "@/components/modal";
import { templatesFor, type AgentTemplate } from "@/lib/agent-templates";
import { toast } from "@/components/toast";
import {
  fetchClinicSettings,
  fetchConnections,
  getWorkspaceId,
  fetchBrandKnowledge,
  saveBrandKnowledge,
  fetchBrandDocuments,
  addBrandDocument,
  deleteBrandDocument,
  listTeamChats,
  createTeamChat,
  fetchTeamChatMessages,
  appendTeamChatMessage,
  deleteTeamChat,
  fetchReports,
  fetchAgentActivity,
  listScheduledTasks,
  createScheduledTask,
  setScheduledTaskStatus,
  deleteScheduledTask,
  type BrandKnowledge,
  type TeamChat,
  type AgentReport,
  type AgentActivity,
  type ScheduledTask,
  type BrandDocument,
} from "@/lib/db";

// A chat message can be plain text or multimodal (text + attached photos) —
// the same shape OpenRouter accepts, so attachments flow straight through.
type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type ChatContent = string | ContentPart[];

// Downscale photos client-side so a phone photo doesn't blow past body limits.
async function downscaleImage(file: File): Promise<string> {
  const dataUrl: string = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  try {
    const img = document.createElement("img");
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
    const max = 1280;
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    if (scale >= 1 && file.size < 900_000) return dataUrl;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return dataUrl;
  }
}

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
        title="AI Marketing"
        subtitle="Your AI marketing department — four specialists who know your brand, powered by the marketing engine: ads, SEO & AI-search, reputation, campaigns. Chat with them like teammates."
      />
      <div className="grid gap-5 md:grid-cols-2">
        {AGENTS.map((a) => {
          const unlocked = UNLOCKED.has(a.key);
          const Icon = a.icon;
          return (
            <div key={a.key} className={`relative overflow-hidden rounded-2xl bg-gradient-to-br ${a.gradient} p-6`}>
              <div className="relative z-10 max-w-[72%]">
                <p className="text-xs font-medium text-slate-600">{a.role}</p>
                <h2 className="mt-1 text-2xl font-semibold text-slate-900">{a.name}</h2>
                <p className="mt-2 text-sm text-slate-700">{a.blurb}</p>
                <button
                  onClick={() => unlocked && setActive(a)}
                  disabled={!unlocked}
                  className={`mt-5 flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold shadow-sm ${unlocked ? "bg-white text-slate-900 hover:bg-white/90" : "cursor-not-allowed bg-white/60 text-slate-400"}`}
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
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: ChatContent }[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [brand, setBrand] = useState<BrandKnowledge>({ profile: "", logoUrl: "", colors: "" });
  const [brandDocs, setBrandDocs] = useState<BrandDocument[]>([]);
  const [brandOpen, setBrandOpen] = useState(false);
  const [chats, setChats] = useState<TeamChat[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [reports, setReports] = useState<AgentReport[]>([]);
  const [activity, setActivity] = useState<AgentActivity[]>([]);
  const [docsOpen, setDocsOpen] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [schedOpen, setSchedOpen] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const templates = templatesFor(agent.key);
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [pendingDocs, setPendingDocs] = useState<{ name: string; text: string }[]>([]);
  const [attaching, setAttaching] = useState(false);
  const attachRef = useRef<HTMLInputElement>(null);
  const [listening, setListening] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Grow the input with its content (wrapped lines included) up to a max, then scroll.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recRef = useRef<any>(null);

  // Attach photos (sent to the agent as images) and documents (text extracted
  // and included with the message) — PDFs/Word go through /api/kb/extract.
  async function onAttach(list: FileList | null) {
    if (!list || list.length === 0) return;
    setAttaching(true);
    try {
      for (const file of Array.from(list)) {
        if (/^image\//.test(file.type)) {
          const url = await downscaleImage(file);
          setPendingImages((p) => [...p, url]);
        } else if (/\.(txt|md|csv|json|html)$/i.test(file.name)) {
          const text = await file.text();
          setPendingDocs((p) => [...p, { name: file.name, text }]);
        } else if (/\.(pdf|docx|doc)$/i.test(file.name)) {
          const fd = new FormData();
          fd.append("file", file, file.name);
          fd.append("name", file.name);
          const res = await fetch("/api/kb/extract", { method: "POST", body: fd });
          const data = await res.json().catch(() => ({}));
          setPendingDocs((p) => [...p, { name: file.name, text: res.ok ? String(data.text ?? "") : `[Could not read ${file.name}]` }]);
        } else {
          toast(`"${file.name}" isn't supported — attach photos, PDF, Word or text files.`, "info");
        }
      }
    } finally {
      setAttaching(false);
      if (attachRef.current) attachRef.current.value = "";
    }
  }

  // Voice dictation (browser speech-to-text) — click to talk, click to stop;
  // the transcript lands in the input box and is sent manually.
  function toggleVoice() {
    if (listening) {
      try { recRef.current?.stop(); } catch { /* ignore */ }
      setListening(false);
      return;
    }
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const w = window as any;
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) { toast("Voice input isn't supported in this browser — try Chrome or Edge.", "info"); return; }
    const rec = new SR();
    rec.lang = navigator.language || "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    const base = draft ? draft.replace(/\s+$/, "") + " " : "";
    rec.onresult = (e: any) => {
      let t = "";
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      setDraft(base + t);
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    rec.start();
  }

  function refreshChats() { listTeamChats(agent.key).then(setChats); }
  function refreshWork() { fetchReports(agent.key).then(setReports); fetchAgentActivity(agent.key).then(setActivity); }
  function refreshTasks() { listScheduledTasks(agent.key).then(setTasks); }

  useEffect(() => {
    fetchConnections().then((c) => setConnected(new Set(c.map((x) => x.provider))));
    fetchClinicSettings().then((s) => setWebsite(s.website));
    fetchBrandKnowledge().then(setBrand);
    fetchBrandDocuments().then(setBrandDocs);
    getWorkspaceId().then(setWs);
    refreshChats();
    refreshWork();
    refreshTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.key]);
  // Keep the chat pinned to the latest message WITHIN the chat box only — never
  // scroll the whole page (which caused the jump on the first message).
  useEffect(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, [messages]);

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

  const docsText = brandDocs.map((d) => `--- ${d.name} ---\n${d.content}`).filter(Boolean).join("\n\n").slice(0, 12000);
  const brandContext = [brand.profile, brand.colors && `Brand colours: ${brand.colors}`, docsText && `BRAND DOCUMENTS:\n${docsText}`].filter(Boolean).join("\n\n");

  async function send() {
    const text = draft.trim();
    const imagesNow = pendingImages;
    const docsNow = pendingDocs;
    if ((!text && imagesNow.length === 0 && docsNow.length === 0) || busy) return;
    if (listening) { try { recRef.current?.stop(); } catch { /* ignore */ } }
    setDraft("");
    setError(null);
    setPendingImages([]);
    setPendingDocs([]);

    // Fold attached documents' text into the message; photos ride along as images.
    let fullText = text;
    if (docsNow.length) {
      fullText = [text, ...docsNow.map((d) => `--- Attached file: ${d.name} ---\n${d.text.slice(0, 8000)}`)].filter(Boolean).join("\n\n");
    }
    if (!fullText) fullText = "Please look at the attached image(s).";
    const content: ChatContent = imagesNow.length
      ? [{ type: "text", text: fullText }, ...imagesNow.map((url) => ({ type: "image_url" as const, image_url: { url } }))]
      : fullText;

    const next = [...messages, { role: "user" as const, content }];
    setMessages(next);
    setBusy(true);

    // Persist the conversation (create a session on the first message).
    let cid = chatId;
    if (!cid) { cid = await createTeamChat(agent.key, text || docsNow[0]?.name || "Attachment"); setChatId(cid); refreshChats(); }
    if (cid) appendTeamChatMessage(cid, "user", fullText + (imagesNow.length ? `\n[${imagesNow.length} photo(s) attached]` : ""));

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
      refreshWork(); // a tool may have created a report / activity
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {brandOpen && <BrandModal brand={brand} onClose={() => setBrandOpen(false)} onSaved={(b) => { setBrand(b); setBrandOpen(false); }} onDocsChanged={() => fetchBrandDocuments().then(setBrandDocs)} />}
      {schedOpen && <ScheduleModal agentKey={agent.key} agentName={agent.name} onClose={() => setSchedOpen(false)} onSaved={() => { setSchedOpen(false); refreshTasks(); }} />}
      {tplOpen && <TemplatesModal agentName={agent.name} templates={templates} onUse={(t) => { setDraft(t.prompt); setTplOpen(false); }} onClose={() => setTplOpen(false)} />}
      {docsOpen && (
        <div className="fixed inset-0 z-[60] flex">
          <div className="flex-1 bg-black/40" onClick={() => setDocsOpen(false)} />
          <div className="flex h-full w-full max-w-3xl flex-col bg-surface shadow-2xl">
            <div className="flex items-center justify-between border-b border-ink-200 px-5 py-3">
              <p className="flex items-center gap-2 font-semibold text-ink-900"><FileText className="h-4 w-4 text-brand-500" /> {agent.name}&apos;s documents</p>
              <button onClick={() => setDocsOpen(false)} className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100">✕</button>
            </div>
            <div className="flex min-h-0 flex-1">
              <div className="w-56 shrink-0 overflow-y-auto border-r border-ink-100 p-2">
                {reports.map((r) => (
                  <button key={r.id} onClick={() => setPreviewId(r.id)} className={`mb-1 block w-full rounded-lg px-2.5 py-2 text-left text-sm ${previewId === r.id ? "bg-brand-50 text-brand-700" : "hover:bg-ink-50 text-ink-700"}`}>
                    <span className="block truncate">{r.title}</span>
                    <span className="text-[11px] text-ink-400">{(r.createdAt ?? "").slice(0, 10)}</span>
                  </button>
                ))}
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                {previewId ? (
                  <>
                    <div className="flex items-center gap-2 border-b border-ink-100 px-4 py-2">
                      <a href={`/api/team/report/${previewId}?format=docx`} className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700">Download Word</a>
                      <a href={`/api/team/report/${previewId}`} target="_blank" rel="noopener noreferrer" className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50">Open / Save as PDF</a>
                    </div>
                    <iframe src={`/api/team/report/${previewId}`} className="min-h-0 flex-1 w-full" title="Report preview" />
                  </>
                ) : (
                  <p className="m-auto text-sm text-ink-400">Select a document to preview.</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      <button onClick={onBack} className="mb-4 flex items-center gap-1.5 text-sm font-medium text-ink-500 hover:text-ink-800">
        <ArrowLeft className="h-4 w-4" /> Back to AI Marketing
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
            {brandDocs.length > 0 && <p className="mt-1 text-xs text-ink-400">📎 {brandDocs.length} document{brandDocs.length > 1 ? "s" : ""} uploaded</p>}
          </Card>

        </div>

        {/* Right: chat on top, work boxes beneath (uses the bottom space) */}
        <div className="flex min-w-0 flex-col gap-5">
        <Card className="flex h-[74vh] min-h-[580px] flex-col">
          <div className="flex items-center justify-between gap-2 border-b border-ink-200 px-5 py-2.5">
            <span className="flex items-center gap-2 text-sm font-medium text-ink-600"><Bot className="h-4 w-4 text-brand-500" /> {agent.name}</span>
            <div className="relative flex items-center gap-1.5">
              <button onClick={() => setTplOpen(true)} className="flex items-center gap-1 rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50">
                <LayoutGrid className="h-3.5 w-3.5" /> Templates
              </button>
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
          <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto bg-ink-50/40 p-5">
            {messages.length === 0 && (
              <div className="m-auto max-w-md pt-10 text-center">
                <p className="text-sm font-medium text-ink-700">Hi! I&apos;m {agent.name}, your {agent.role}.</p>
                <p className="mt-1 text-sm text-ink-400">Pick a ready-made template, or just tell me what you need.</p>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  {templates.slice(0, 3).map((t) => (
                    <button key={t.id} onClick={() => setDraft(t.prompt)} className="rounded-full border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-600 hover:border-brand-400 hover:text-brand-600">{t.title}</button>
                  ))}
                  <button onClick={() => setTplOpen(true)} className="rounded-full bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700">All templates</button>
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${m.role === "user" ? "rounded-br-sm bg-brand-600 text-white" : "rounded-bl-sm border border-ink-200 bg-surface text-ink-800"}`}>
                  {typeof m.content === "string" ? (
                    m.role === "assistant" ? renderMarkdown(m.content) : linkify(m.content)
                  ) : (
                    <>
                      {m.content.filter((pt) => pt.type === "image_url").map((pt, j) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img key={j} src={(pt as { image_url: { url: string } }).image_url.url} alt="attachment" className="mb-2 max-h-56 rounded-xl" />
                      ))}
                      {(() => {
                        const joined = m.content.filter((pt) => pt.type === "text").map((pt) => (pt as { text: string }).text).join("\n");
                        return m.role === "assistant" ? renderMarkdown(joined) : linkify(joined);
                      })()}
                    </>
                  )}
                </div>
              </div>
            ))}
            {busy && <div className="flex justify-start"><div className="flex items-center gap-1.5 rounded-2xl rounded-bl-sm border border-ink-200 bg-surface px-3.5 py-2 text-sm text-ink-400"><Bot className="h-4 w-4 animate-pulse" /> {agent.name} is thinking…</div></div>}
          </div>
          {error && <p className="px-5 pt-2 text-sm text-amber-600">{error}</p>}
          <div className="border-t border-ink-200 p-4">
            {(pendingImages.length > 0 || pendingDocs.length > 0 || attaching) && (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {pendingImages.map((url, i) => (
                  <span key={i} className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={url} alt="attachment" className="h-14 w-14 rounded-lg border border-ink-200 object-cover" />
                    <button onClick={() => setPendingImages((p) => p.filter((_, j) => j !== i))} className="absolute -right-1.5 -top-1.5 rounded-full bg-ink-900/80 p-0.5 text-white" title="Remove"><X className="h-3 w-3" /></button>
                  </span>
                ))}
                {pendingDocs.map((d, i) => (
                  <span key={`${d.name}-${i}`} className="flex items-center gap-1.5 rounded-lg border border-ink-200 bg-ink-50 px-2.5 py-1.5 text-xs text-ink-700">
                    <FileText className="h-3.5 w-3.5 text-brand-500" /> {d.name}
                    <button onClick={() => setPendingDocs((p) => p.filter((_, j) => j !== i))} className="text-ink-400 hover:text-rose-500" title="Remove"><X className="h-3 w-3" /></button>
                  </span>
                ))}
                {attaching && <span className="text-xs text-brand-600">Reading attachment…</span>}
              </div>
            )}
            <div className="flex items-end gap-2">
              <input ref={attachRef} type="file" multiple accept="image/*,.pdf,.doc,.docx,.txt,.md,.csv,.json,.html" className="hidden" onChange={(e) => onAttach(e.target.files)} />
              <button onClick={() => attachRef.current?.click()} title="Attach a photo or document" className="rounded-xl border border-ink-200 p-2.5 text-ink-500 hover:bg-ink-50"><Paperclip className="h-5 w-5" /></button>
              <button onClick={toggleVoice} title={listening ? "Stop dictating" : "Dictate your message (speech-to-text)"} className={`rounded-xl border p-2.5 ${listening ? "border-rose-400 bg-rose-500/10 text-rose-500" : "border-ink-200 text-ink-500 hover:bg-ink-50"}`}><Mic className={`h-5 w-5 ${listening ? "animate-pulse" : ""}`} /></button>
              <textarea
                ref={taRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                rows={1}
                placeholder={listening ? "Listening… speak now" : `Message ${agent.name}…  (Shift+Enter for a new line)`}
                className={`${inputCls} max-h-[220px] resize-none overflow-y-auto`}
              />
              <button onClick={send} disabled={busy} className="rounded-xl bg-brand-600 px-4 py-2.5 text-white hover:bg-brand-700 disabled:opacity-50"><Send className="h-5 w-5" /></button>
            </div>
          </div>
        </Card>
        <div className="grid gap-4 lg:grid-cols-3">
<Card className="p-5">
            <div className="mb-2 flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400"><FileText className="h-3.5 w-3.5" /> Documents</p>
              {reports.length > 0 && <button onClick={() => { setPreviewId(reports[0].id); setDocsOpen(true); }} className="text-xs font-medium text-brand-600 hover:text-brand-700">View all ({reports.length})</button>}
            </div>
            {reports.length === 0 ? (
              <p className="text-sm text-ink-400">Reports {agent.name} creates show up here. Ask for a report to download as Word or PDF.</p>
            ) : (
              <div className="space-y-1.5">
                {reports.slice(0, 3).map((r) => (
                  <button key={r.id} onClick={() => { setPreviewId(r.id); setDocsOpen(true); }} className="flex w-full items-center gap-2 rounded-lg border border-ink-100 px-2.5 py-2 text-left text-sm hover:bg-ink-50">
                    <FileText className="h-4 w-4 shrink-0 text-brand-500" />
                    <span className="min-w-0 flex-1"><span className="block truncate text-ink-800">{r.title}</span><span className="text-[11px] text-ink-400">{(r.createdAt ?? "").slice(0, 10)}</span></span>
                  </button>
                ))}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400"><Activity className="h-3.5 w-3.5" /> Activity</p>
            {activity.length === 0 ? (
              <p className="text-sm text-ink-400">What {agent.name} does — published posts, reports, etc. — appears here.</p>
            ) : (
              <ul className="space-y-2">
                {activity.slice(0, 6).map((a) => (
                  <li key={a.id} className="text-sm">
                    <span className="font-medium text-ink-800">{a.action}</span>
                    {a.detail && <span className="text-ink-500"> — {a.detail}</span>}
                    <span className="block text-[11px] text-ink-400">{(a.createdAt ?? "").replace("T", " ").slice(0, 16)}{a.link && <> · <a href={a.link} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline">open</a></>}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-5">
            <div className="mb-2 flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400"><Clock className="h-3.5 w-3.5" /> Autopilot</p>
              <button onClick={() => setSchedOpen(true)} className="flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"><Plus className="h-3 w-3" /> Schedule</button>
            </div>
            {tasks.length === 0 ? (
              <p className="text-sm text-ink-400">Schedule recurring work — e.g. &ldquo;every Monday, draft a blog&rdquo; or &ldquo;daily, draft an Instagram post&rdquo;. {agent.name} runs it automatically.</p>
            ) : (
              <ul className="space-y-2">
                {tasks.map((t) => (
                  <li key={t.id} className="rounded-lg border border-ink-100 px-2.5 py-2 text-sm">
                    <div className="flex items-start gap-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-ink-800">{t.title || t.instruction}</span>
                        <span className="text-[11px] text-ink-400 capitalize">{t.cadence} · next {(t.nextRun ?? "").replace("T", " ").slice(0, 16)} · {t.status}</span>
                      </span>
                      <button onClick={() => { setScheduledTaskStatus(t.id, t.status === "active" ? "paused" : "active").then(refreshTasks); }} className="rounded p-1 text-ink-400 hover:text-brand-600" title={t.status === "active" ? "Pause" : "Resume"}>
                        {t.status === "active" ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                      </button>
                      <button onClick={() => deleteScheduledTask(t.id).then(refreshTasks)} className="rounded p-1 text-ink-300 hover:text-rose-500"><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        </div>
      </div>
    </>
  );
}

function BrandModal({ brand, onClose, onSaved, onDocsChanged }: { brand: BrandKnowledge; onClose: () => void; onSaved: (b: BrandKnowledge) => void; onDocsChanged: () => void }) {
  const [profile, setProfile] = useState(brand.profile);
  const [colors, setColors] = useState(brand.colors);
  const [logoUrl, setLogoUrl] = useState(brand.logoUrl);
  const [saving, setSaving] = useState(false);
  const [docs, setDocs] = useState<BrandDocument[]>([]);
  const [uploading, setUploading] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { fetchBrandDocuments().then(setDocs); }, []);

  async function onFiles(list: FileList | null) {
    if (!list) return;
    for (const file of Array.from(list)) {
      setUploading((p) => [...p, file.name]);
      try {
        let text = "";
        if (/\.(txt|md|csv|json)$/i.test(file.name)) text = await file.text();
        else if (/\.(pdf|docx|doc)$/i.test(file.name)) {
          const fd = new FormData(); fd.append("file", file, file.name); fd.append("name", file.name);
          const res = await fetch("/api/kb/extract", { method: "POST", body: fd });
          const data = await res.json();
          text = res.ok ? data.text : `[Could not read ${file.name}: ${data.error ?? "extraction failed"}]`;
        } else text = `[Uploaded file: ${file.name}]`;
        await addBrandDocument(file.name, text);
      } catch { /* skip */ } finally {
        setUploading((p) => p.filter((n) => n !== file.name));
      }
    }
    fetchBrandDocuments().then(setDocs);
    onDocsChanged();
    if (fileRef.current) fileRef.current.value = "";
  }

  async function removeDoc(id: string) {
    await deleteBrandDocument(id);
    fetchBrandDocuments().then(setDocs);
    onDocsChanged();
  }

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

        <div>
          <p className="mb-1.5 text-sm font-medium text-ink-700">Brand documents — upload as many as you like</p>
          <p className="mb-2 text-xs text-ink-400">Price lists, treatment guides, brand guidelines, FAQs… the team reads their text. PDF/Word text is extracted automatically.</p>
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => onFiles(e.target.files)} />
          <button onClick={() => fileRef.current?.click()} className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-ink-300 py-3 text-sm font-medium text-ink-500 hover:border-brand-400 hover:text-brand-600">
            <FileText className="h-4 w-4" /> Upload documents (any type)
          </button>
          {uploading.length > 0 && <p className="mt-2 text-xs text-brand-600">Reading {uploading.join(", ")}…</p>}
          {docs.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {docs.map((d) => (
                <li key={d.id} className="flex items-center justify-between rounded-lg border border-ink-100 bg-ink-50 px-3 py-2 text-sm text-ink-700">
                  <span className="flex min-w-0 items-center gap-2"><FileText className="h-4 w-4 shrink-0 text-brand-500" /> <span className="truncate">{d.name}</span></span>
                  <button onClick={() => removeDoc(d.id)} className="rounded p-1 text-ink-400 hover:text-rose-500"><Trash2 className="h-4 w-4" /></button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <ModalFooter onClose={onClose} submitLabel={saving ? "Saving…" : "Save brand knowledge"} onSubmit={submit} />
    </Modal>
  );
}

// Turn URLs in agent replies into clickable links (download links, post URLs).
function linkify(text: string) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return parts.map((p, i) =>
    /^https?:\/\//.test(p) ? (
      <a key={i} href={p} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-600 underline underline-offset-2 hover:text-brand-700">{p}</a>
    ) : (
      <span key={i}>{p}</span>
    )
  );
}

// Inline markdown inside one line: [links](url), **bold**, `code`, bare URLs.
function inlineMd(text: string): ReactNode[] {
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|(https?:\/\/[^\s)]+)/g;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(<span key={k++}>{text.slice(last, m.index)}</span>);
    if (m[1] !== undefined) out.push(<a key={k++} href={m[2]} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-600 underline underline-offset-2 hover:text-brand-700">{m[1]}</a>);
    else if (m[3] !== undefined) out.push(<strong key={k++} className="font-semibold">{m[3]}</strong>);
    else if (m[4] !== undefined) out.push(<code key={k++} className="rounded bg-ink-100 px-1 py-0.5 font-mono text-[12px]">{m[4]}</code>);
    else if (m[5] !== undefined) out.push(<a key={k++} href={m[5]} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-600 underline underline-offset-2 hover:text-brand-700">{m[5]}</a>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(<span key={k++}>{text.slice(last)}</span>);
  return out;
}

// Render agent replies as formatted text — headings, bullets, numbered lists,
// bold, code, links — so raw markdown symbols (#, **, `) never show in chat.
function renderMarkdown(text: string) {
  return text.split("\n").map((line, i) => {
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const cls = h[1].length <= 2 ? "mt-2 text-[15px] font-bold text-ink-900" : "mt-1.5 text-sm font-semibold text-ink-900";
      return <div key={i} className={cls}>{inlineMd(h[2])}</div>;
    }
    if (/^\s*([-*_]){3,}\s*$/.test(line)) return <hr key={i} className="my-2 border-ink-200" />;
    const b = line.match(/^(\s*)[-*•]\s+(.*)$/);
    if (b) {
      return (
        <div key={i} className="flex gap-2" style={{ paddingLeft: Math.min(b[1].length, 8) * 6 }}>
          <span className="select-none text-ink-400">•</span>
          <span className="min-w-0 flex-1">{inlineMd(b[2])}</span>
        </div>
      );
    }
    const n = line.match(/^\s*(\d{1,3})[.)]\s+(.*)$/);
    if (n) {
      return (
        <div key={i} className="flex gap-2">
          <span className="select-none font-medium text-ink-500">{n[1]}.</span>
          <span className="min-w-0 flex-1">{inlineMd(n[2])}</span>
        </div>
      );
    }
    if (!line.trim()) return <div key={i} className="h-2" />;
    return <div key={i}>{inlineMd(line)}</div>;
  });
}

function ScheduleModal({ agentKey, agentName, onClose, onSaved }: { agentKey: string; agentName: string; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [cadence, setCadence] = useState("weekly");
  const [firstRun, setFirstRun] = useState(() => {
    const d = new Date(Date.now() + 86400000);
    d.setMinutes(0, 0, 0);
    return d.toISOString().slice(0, 16);
  });
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!instruction.trim()) { toast("Describe what to do.", "info"); return; }
    setSaving(true);
    const res = await createScheduledTask({ agentKey, title: title.trim() || instruction.slice(0, 60), instruction: instruction.trim(), cadence, firstRun: new Date(firstRun).toISOString() });
    setSaving(false);
    if (!res.ok) { toast(res.message, "info"); return; }
    toast("Autopilot task scheduled.", "success");
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title={`Schedule ${agentName}`} subtitle="Recurring work — runs automatically.">
      <div className="space-y-4">
        <Field label="Name (optional)"><input className={inputCls} placeholder="Weekly blog" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="What should it do? (plain English)">
          <textarea rows={3} className={inputCls} placeholder="Write an SEO blog about a dental topic and draft it to WordPress with a featured image." value={instruction} onChange={(e) => setInstruction(e.target.value)} />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="How often">
            <select className={inputCls} value={cadence} onChange={(e) => setCadence(e.target.value)}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </Field>
          <Field label="First run"><input type="datetime-local" className={inputCls} value={firstRun} onChange={(e) => setFirstRun(e.target.value)} /></Field>
        </div>
        <p className="text-xs text-ink-400">Runs need the autopilot scheduler enabled (point a cron at /api/cron/run — see AI_TEAM.md). Until then, scheduled tasks are saved but won&apos;t fire.</p>
      </div>
      <ModalFooter onClose={onClose} submitLabel={saving ? "Scheduling…" : "Schedule"} onSubmit={submit} />
    </Modal>
  );
}

// Hyperfx-style template gallery: boxes → click for a full-prompt preview →
// "Use this template" puts the prompt in the chat input (never auto-sends).
function TemplatesModal({ agentName, templates, onUse, onClose }: { agentName: string; templates: AgentTemplate[]; onUse: (t: AgentTemplate) => void; onClose: () => void }) {
  const [preview, setPreview] = useState<AgentTemplate | null>(null);
  return (
    <Modal
      open
      onClose={onClose}
      title={preview ? preview.title : `${agentName}'s templates`}
      subtitle={preview ? preview.description : "Ready-made tasks — preview one, then use it. The prompt lands in the chat box for you to review and send."}
      wide
    >
      {preview ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {preview.apps.map((a) => (
              <span key={a} className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-600 dark:text-brand-300">{a}</span>
            ))}
          </div>
          <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-xl border border-ink-200 bg-ink-50 p-4 font-sans text-sm leading-relaxed text-ink-800">{preview.prompt}</pre>
          <div className="flex items-center justify-between">
            <button onClick={() => setPreview(null)} className="flex items-center gap-1.5 rounded-xl border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50">
              <ArrowLeft className="h-4 w-4" /> All templates
            </button>
            <button onClick={() => onUse(preview)} className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">Use this template</button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {templates.map((t) => (
            <button key={t.id} onClick={() => setPreview(t)} className="rounded-xl border border-ink-200 p-4 text-left transition-colors hover:border-brand-400 hover:bg-brand-50/40">
              <p className="text-sm font-semibold text-ink-900">{t.title}</p>
              <p className="mt-1 text-xs text-ink-500">{t.description}</p>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {t.apps.map((a) => (
                  <span key={a} className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-medium text-ink-500">{a}</span>
                ))}
              </div>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
