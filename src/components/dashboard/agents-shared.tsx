"use client";

// Shared building blocks for the AI Agents section: agent grid, create/edit
// modal, in-browser test chat (OpenRouter) and test call (Vapi Web SDK),
// and the Agent Hub (channel defaults + phone lines).

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bot,
  PhoneCall,
  Plus,
  MessageCircle,
  MessageSquare,
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
  Play,
  Square,
  Download,
  SlidersHorizontal,
  ChevronDown,
  ShieldCheck,
  Voicemail,
  Clock,
  Waves,
  ClipboardList,
} from "lucide-react";
import { Card, PageHeader, DemoBanner, StatusBadge } from "@/components/ui";
import { Modal, Field, ModalFooter, inputCls } from "@/components/modal";
import { VoiceLibrary } from "@/components/dashboard/voice-library";
import {
  fetchAgents,
  createAgent,
  updateAgent,
  updateAgentStatus,
  setAgentVapiId,
  deleteAgent,
  fetchChannelDefaults,
  setChannelDefault,
  fetchClinicSettings,
  defaultVoiceSettings,
  listTeamChats,
  createTeamChat,
  fetchTeamChatMessages,
  appendTeamChatMessage,
  deleteTeamChat,
  fetchVoiceProvider,
  getWorkspaceId,
  type VoiceProvider,
  type AiAgent,
  type DataSource,
  type ChannelDefault,
  type VoiceSettings,
  type ExtractionField,
  type TeamChat,
} from "@/lib/db";
import { History } from "lucide-react";

const OPENAI_MODELS = ["openai/gpt-4o-mini", "openai/gpt-4o", "openai/gpt-4.1", "openai/gpt-4.1-mini"];
const ANTHROPIC_MODELS = ["anthropic/claude-3.5-haiku", "anthropic/claude-sonnet-4", "anthropic/claude-opus-4.1"];
const VAPI_MODELS = ["gpt-4o-mini", "gpt-4o", "gpt-4.1"];

// Voice rosters per engine. Which one the builder/test call uses is decided by
// the Voice engine card in Settings (fetchVoiceProvider).
// Baseline built-in roster (kept in sync with XAI_VOICES in lib/xai-voice.ts);
// the picker also loads the live account list — custom voices included.
const XAI_VOICE_LABELS = [
  "Eve · natural female (default)",
  "Ara · warm friendly female",
  "Rex · confident clear male",
  "Sal · calm neutral male",
  "Leo · energetic male",
  "Gork · laid-back male",
  "Altair · flagship",
  "Atlas · flagship",
  "Carina · flagship",
  "Castor · flagship",
  "Celeste · flagship",
  "Cosmo · flagship",
  "Helios · flagship",
  "Helix · flagship",
  "Iris · flagship",
  "Kepler · flagship",
  "Lumen · flagship",
  "Luna · flagship",
  "Lux · flagship",
  "Naksh · flagship",
  "Orion · flagship",
  "Perseus · flagship",
  "Rigel · flagship",
  "Sirius · flagship",
  "Ursa · flagship",
  "Zagan · flagship",
  "Zenith · flagship",
];
const XAI_VOICE_MODELS = ["grok-voice-latest", "grok-voice-think-fast-1.0"];

const VOICES = XAI_VOICE_LABELS; // default roster (xAI is the default engine)

// Mirrors the server-side mapping in /api/vapi/assistants (Vapi engine only).
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
  messenger: MessageSquare,
  sms: MessageSquareText,
  email: Mail,
};

// xAI voice picker: a dropdown of EVERY voice on the clinic's xAI account —
// the built-in five plus any custom/cloned voices from their Voice Library
// (loaded live via /api/xai/voices) — with a Preview button that speaks a
// sample line in the selected voice (/api/xai/tts).
function XaiVoicePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [voices, setVoices] = useState<{ id: string; label: string }[]>(
    XAI_VOICE_LABELS.map((l) => ({ id: l.split(" ")[0].toLowerCase(), label: l }))
  );
  const [liveList, setLiveList] = useState<boolean | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlsRef = useRef<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/xai/voices")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.voices) && d.voices.length) setVoices(d.voices);
        setLiveList(d.live === true);
      })
      .catch(() => setLiveList(false));
    const urls = urlsRef.current;
    return () => {
      audioRef.current?.pause();
      for (const u of Object.values(urls)) URL.revokeObjectURL(u);
    };
  }, []);

  // The id of the currently selected voice (label match first, then embedded
  // custom id, then builtin-name match).
  function selectedId(): string {
    const hit = voices.find((v) => v.label === value);
    if (hit) return hit.id;
    const custom = /\(([A-Za-z0-9_-]{2,64})\)\s*$/.exec(value ?? "");
    if (custom) return custom[1];
    const l = (value ?? "").toLowerCase();
    for (const v of voices) if (l.includes(v.id.toLowerCase())) return v.id;
    return "eve";
  }

  async function preview() {
    audioRef.current?.pause();
    if (playing) {
      setPlaying(false);
      return;
    }
    const id = selectedId();
    setPreviewError(null);
    setLoadingPreview(true);
    try {
      let url = urlsRef.current[id];
      if (!url) {
        // v=2 busts browser copies cached before the per-voice fix.
        const res = await fetch(`/api/xai/tts?voice=${encodeURIComponent(id)}&v=2`);
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error ?? "Preview failed.");
        }
        url = URL.createObjectURL(await res.blob());
        urlsRef.current[id] = url;
      }
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => setPlaying(false);
      await audio.play();
      setPlaying(true);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : "Could not play the preview.");
      setPlaying(false);
    } finally {
      setLoadingPreview(false);
    }
  }

  const known = voices.some((v) => v.label === value);
  return (
    <div>
      <div className="flex items-center gap-2">
        <select
          className={`${inputCls} min-w-0 flex-1`}
          value={known ? value : ""}
          onChange={(e) => { audioRef.current?.pause(); setPlaying(false); onChange(e.target.value); }}
        >
          {!known && <option value="" disabled>{value ? `${value} (previous engine — pick a Grok voice)` : "Choose a voice…"}</option>}
          {voices.map((v) => (
            <option key={v.id} value={v.label}>{v.label}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void preview()}
          title={playing ? "Stop preview" : "Hear this voice"}
          className="flex shrink-0 items-center gap-1.5 rounded-xl border border-ink-200 px-3 py-2.5 text-sm font-medium text-brand-600 hover:bg-brand-50"
        >
          {loadingPreview ? (
            <span className="animate-pulse text-xs">Loading…</span>
          ) : playing ? (
            <><Square className="h-3.5 w-3.5 fill-current" /> Stop</>
          ) : (
            <><Play className="h-3.5 w-3.5" /> Preview</>
          )}
        </button>
      </div>
      <p className="mt-1 text-[11px] text-ink-400">
        {liveList === true
          ? "Live list from your xAI account — custom voices from the Voice Library appear here automatically."
          : liveList === false
          ? "Showing the built-in roster — couldn't load your xAI account's live list (check X_AI_VOICE_KEY / credits). Previews still work once the key is valid."
          : "All xAI voices — custom voices added in xAI's Voice Library appear here automatically."}
      </p>
      {previewError && <p className="mt-1 text-[11px] text-amber-600">{previewError}</p>}
    </div>
  );
}

function emptyForm(): Omit<AiAgent, "id" | "vapiAssistantId"> {
  return {
    name: "",
    kind: "chat",
    role: "Receptionist",
    status: "Draft",
    model: OPENAI_MODELS[0],
    voice: VOICES[0],
    voiceId: null,
    firstMessage: "",
    language: "English",
    agentIdentity: "",
    instructions: "",
    behavior: "",
    knowledgeBase: "",
    canBook: true,
    canReschedule: true,
    canCancel: false,
    channels: ["whatsapp"],
    purpose: "both",
    firstMessageMode: "assistant_first",
    kbFiles: [],
    voiceSettings: defaultVoiceSettings(),
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
          <span><strong className="font-semibold">Live</strong> — agents are stored in your database. Chat agents reply through the AI gateway; voice agents run on your selected voice engine (Settings → Voice engine).</span>
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
                <button
                  onClick={async () => {
                    if (!confirm(`Delete agent "${a.name}"? This cannot be undone.`)) return;
                    const res = await deleteAgent(a.id);
                    if (res.ok) { setAgents((prev) => prev.filter((x) => x.id !== a.id)); }
                    else alert(res.message);
                  }}
                  title="Delete agent"
                  className="flex items-center justify-center rounded-xl border border-ink-200 px-3 py-2 text-ink-400 hover:bg-rose-500/10 hover:text-rose-500"
                >
                  <Trash2 className="h-4 w-4" />
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
  const [defaults, setDefaults] = useState<Record<string, ChannelDefault>>({});
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    fetchChannelDefaults().then((d) => setDefaults(Object.fromEntries(d.map((x) => [x.channel, x]))));
  }, []);

  async function saveDefault(channel: string, agentId: string | null, enabled: boolean) {
    setDefaults((prev) => ({ ...prev, [channel]: { channel, agentId, enabled } }));
    const res = await setChannelDefault(channel, agentId, enabled);
    if (!res.ok) setNote(`Could not save (${res.message}) — run migration 0003 in the SQL Editor.`);
  }

  return (
    <>
      <PageHeader
        title="Agent Hub"
        subtitle="Route every chat channel to the right agent — automatically."
      />
      <div className="space-y-6">
        {note && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-600">{note}</div>
        )}

        <Card className="p-6">
          <h2 className="flex items-center gap-2 font-semibold text-ink-900">
            <MessageCircle className="h-5 w-5 text-brand-500" /> Chat routing rules — one agent per channel
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            Set a condition for each channel: <em>if a message comes from WhatsApp → this agent, from
            Instagram → that agent</em>, and so on. The chosen agent answers automatically and you can
            change it any time. Turn a channel off to route it to your team instead.
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
      </div>
    </>
  );
}

// ----------------------------------------------- advanced voice settings
// Vapi/Callab-style call-tuning: turn detection / VAD, interruptions, noise,
// answering-machine detection, call limits, idle reminders, privacy, and
// post-call data extraction. Stored on the agent as `voiceSettings` and mapped
// onto the Vapi assistant (startSpeakingPlan / stopSpeakingPlan / analysisPlan /
// artifactPlan / voicemailDetection / messagePlan).

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-brand-600" : "bg-ink-200"}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

// A slider with the live value shown inline in the label and a hint below —
// matches Callab's VAD / timeout sliders.
function SliderRow({
  label,
  value,
  suffix = "",
  min,
  max,
  step,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  suffix?: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  hint: string;
}) {
  return (
    <div className="py-1">
      <p className="mb-1 text-sm font-medium text-ink-800">
        {label}: <span className="text-brand-600">{value}{suffix}</span>
      </p>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[#7c3aed]"
      />
      <p className="mt-1 text-xs leading-relaxed text-ink-400">{hint}</p>
    </div>
  );
}

// A labelled number input with a hint below — matches Callab's Reminder/Duration
// and AMD-timeout fields.
function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  hint: string;
}) {
  return (
    <div>
      <p className="mb-1 text-sm font-medium text-ink-800">{label}</p>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-800 outline-none focus:border-brand-400"
      />
      <p className="mt-1 text-xs leading-relaxed text-ink-400">{hint}</p>
    </div>
  );
}

// A titled card with an icon, description, and (optionally) a header toggle —
// the building block for each Callab "Advanced Settings" sub-section.
function SettingsGroup({
  icon: Icon,
  title,
  desc,
  toggle,
  children,
}: {
  icon: typeof Mic;
  title: string;
  desc: string;
  toggle?: { on: boolean; onChange: (v: boolean) => void };
  children?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-ink-100 bg-surface p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-brand-500" />
            <p className="text-sm font-semibold text-ink-900">{title}</p>
          </div>
          <p className="mt-1 text-xs text-ink-400">{desc}</p>
        </div>
        {toggle && <Toggle on={toggle.on} onChange={toggle.onChange} />}
      </div>
      {children && <div className="space-y-3">{children}</div>}
    </div>
  );
}

function VoiceAdvancedSettings({
  value,
  onChange,
}: {
  value: VoiceSettings;
  onChange: (v: VoiceSettings) => void;
}) {
  const [open, setOpen] = useState(false);
  function set<K extends keyof VoiceSettings>(k: K, v: VoiceSettings[K]) {
    onChange({ ...value, [k]: v });
  }

  function addField() {
    set("extractionFields", [
      ...value.extractionFields,
      { name: "", description: "", type: "string" as const },
    ]);
  }
  function updateField(i: number, patch: Partial<ExtractionField>) {
    set(
      "extractionFields",
      value.extractionFields.map((f, idx) => (idx === i ? { ...f, ...patch } : f))
    );
  }
  function removeField(i: number) {
    set("extractionFields", value.extractionFields.filter((_, idx) => idx !== i));
  }

  return (
    <div className="mt-5 rounded-xl border border-ink-200">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-brand-500" />
          <span className="text-sm font-semibold text-ink-900">Advanced voice settings</span>
          <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-500">
            optional
          </span>
        </span>
        <ChevronDown className={`h-4 w-4 text-ink-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="space-y-3 border-t border-ink-100 p-4">
          <p className="text-xs text-ink-400">
            Configure advanced agent behavior and conversation settings. The defaults work well —
            adjust only if calls feel too eager to interrupt, too slow to respond, or you need
            specific recording/extraction rules.
          </p>

          {/* Agent Speaking — Voice Activity Detection */}
          <SettingsGroup
            icon={Mic}
            title="Agent Speaking"
            desc="Configure voice activity detection and turn management settings."
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
              Voice Activity Detection (VAD)
            </p>
            <div className="grid gap-x-6 gap-y-2 md:grid-cols-2">
              <SliderRow
                label="Min Speech Duration"
                value={value.minSpeechDuration}
                suffix="s"
                min={0.1}
                max={3}
                step={0.1}
                onChange={(v) => set("minSpeechDuration", v)}
                hint="Minimum duration (0.1–3s) for speech to be detected. Shorter values catch quick speech but may trigger on noise. Recommended: 0.1s"
              />
              <SliderRow
                label="Min Silence Duration"
                value={value.minSilenceDuration}
                suffix="s"
                min={0.1}
                max={3}
                step={0.1}
                onChange={(v) => set("minSilenceDuration", v)}
                hint="Minimum duration (0.1–3s) for silence to be detected. Shorter values allow quicker responses but may interrupt the caller. Recommended: 0.3s"
              />
              <SliderRow
                label="Activation Threshold"
                value={value.activationThreshold}
                min={0.1}
                max={0.9}
                step={0.1}
                onChange={(v) => set("activationThreshold", v)}
                hint="Sensitivity threshold (0.1–0.9) for voice detection. Lower values = more sensitive (may catch background noise), higher values = less sensitive. Recommended: 0.5"
              />
              <SliderRow
                label="Prefix Padding Duration"
                value={value.prefixPaddingDuration}
                suffix="s"
                min={0.1}
                max={3}
                step={0.1}
                onChange={(v) => set("prefixPaddingDuration", v)}
                hint="Audio padding (0.1–3s) before detected speech. Captures audio just before speech starts to avoid cutting off beginnings of words. Recommended: 0.2s"
              />
              <SliderRow
                label="End of Speech Timeout"
                value={value.endOfSpeechTimeout}
                suffix="s"
                min={0}
                max={3}
                step={0.1}
                onChange={(v) => set("endOfSpeechTimeout", v)}
                hint="Timeout (0–3s) to detect end of speech. How long to wait after speech stops before considering it finished. Shorter = faster responses. Recommended: 0.2s"
              />
            </div>
          </SettingsGroup>

          {/* Turn Detection */}
          <SettingsGroup
            icon={RefreshCcw}
            title="Turn Detection"
            desc="Automatically detect when it's the agent's turn to speak."
            toggle={{ on: value.turnDetectionEnabled, onChange: (v) => set("turnDetectionEnabled", v) }}
          >
            {value.turnDetectionEnabled && (
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <p className="mb-1 text-sm font-medium text-ink-800">Detection Mode</p>
                  <select
                    value={value.detectionMode}
                    onChange={(e) => set("detectionMode", e.target.value as VoiceSettings["detectionMode"])}
                    className="w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-800 outline-none"
                  >
                    <option value="smart">Smart — AI-driven turn detection</option>
                    <option value="fixed">Fixed — timeout only</option>
                  </select>
                  <p className="mt-1 text-xs text-ink-400">How the agent determines when to speak.</p>
                </div>
                <SliderRow
                  label="Detection Timeout"
                  value={value.detectionTimeout}
                  suffix="s"
                  min={0}
                  max={5}
                  step={0.1}
                  onChange={(v) => set("detectionTimeout", v)}
                  hint="Timeout (0–5s) before agent takes turn. Maximum time to wait for user response before agent speaks. Shorter = more responsive but may interrupt. Recommended: 2.0s"
                />
              </div>
            )}
          </SettingsGroup>

          {/* Noise Reduction */}
          <SettingsGroup
            icon={Waves}
            title="Noise Reduction"
            desc="Configure noise reduction and audio enhancement settings."
            toggle={{ on: value.noiseReductionEnabled, onChange: (v) => set("noiseReductionEnabled", v) }}
          >
            {value.noiseReductionEnabled && (
              <div>
                <p className="mb-1 text-sm font-medium text-ink-800">Reduction Level</p>
                <select
                  value={value.reductionLevel}
                  onChange={(e) => set("reductionLevel", e.target.value as VoiceSettings["reductionLevel"])}
                  className="w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-800 outline-none"
                >
                  <option value="low">Low — light noise reduction</option>
                  <option value="medium">Medium — balanced noise reduction</option>
                  <option value="high">High — aggressive noise reduction</option>
                </select>
              </div>
            )}
          </SettingsGroup>

          {/* Answering Machine Detection */}
          <SettingsGroup
            icon={Voicemail}
            title="Answering Machine Detection"
            desc="Configure settings for detecting answering machines and voicemail."
            toggle={{ on: value.amdEnabled, onChange: (v) => set("amdEnabled", v) }}
          >
            {value.amdEnabled && (
              <>
                <label className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-ink-800">Multilingual AMD</p>
                    <p className="text-xs text-ink-400">Detect answering machines in multiple languages.</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={value.multilingualAmd}
                    onChange={(e) => set("multilingualAmd", e.target.checked)}
                    className="mt-1 h-4 w-4 accent-[#7c3aed]"
                  />
                </label>
                <NumberField
                  label="AMD Timeout"
                  value={value.amdTimeout}
                  onChange={(v) => set("amdTimeout", v)}
                  min={5}
                  max={30}
                  hint="Maximum time (5–30s) to wait for AMD detection."
                />
              </>
            )}
          </SettingsGroup>

          {/* Call transfer to a human */}
          <SettingsGroup
            icon={PhoneCall}
            title="Transfer to a human"
            desc="If the agent can't help (or the caller asks for a person), transfer the live call to a real number."
          >
            <div>
              <p className="mb-1 text-sm font-medium text-ink-800">Transfer to this number (E.164, e.g. +9714…)</p>
              <input className={inputCls} placeholder="+97143495432" value={value.transferNumber} onChange={(e) => set("transferNumber", e.target.value)} />
              <p className="mt-1 text-xs text-ink-400">Leave blank for no transfer. The agent transfers when a caller asks for a human, is upset, or it can&apos;t help.</p>
            </div>
            {value.transferNumber.trim() && (
              <div>
                <p className="mb-1 text-sm font-medium text-ink-800">What the agent says before transferring</p>
                <input className={inputCls} placeholder="One moment — connecting you to a team member now." value={value.transferMessage} onChange={(e) => set("transferMessage", e.target.value)} />
              </div>
            )}
          </SettingsGroup>

          {/* Reminder & Call Duration Settings */}
          <SettingsGroup
            icon={Clock}
            title="Reminder & Call Duration Settings"
            desc="Configure how the agent checks on users and call duration limits."
          >
            <div className="grid gap-4 md:grid-cols-2">
              <NumberField
                label="Silence Before Check (seconds)"
                value={value.silenceBeforeCheck}
                onChange={(v) => set("silenceBeforeCheck", v)}
                min={5}
                max={300}
                hint="How long the user can be silent before the agent checks on them."
              />
              <NumberField
                label="Max Check Attempts"
                value={value.maxCheckAttempts}
                onChange={(v) => set("maxCheckAttempts", v)}
                min={1}
                max={10}
                hint="Maximum number of times to check on the user before ending the call."
              />
              <NumberField
                label="Max Silence Duration (seconds)"
                value={value.maxSilenceDuration}
                onChange={(v) => set("maxSilenceDuration", v)}
                min={10}
                max={600}
                hint="Maximum allowed silence duration before ending the call."
              />
              <NumberField
                label="Maximum Call Duration (minutes)"
                value={value.maxCallDuration}
                onChange={(v) => set("maxCallDuration", v)}
                min={1}
                max={60}
                hint="Maximum duration for the call (1–60 minutes)."
              />
            </div>
          </SettingsGroup>

          {/* Privacy */}
          <SettingsGroup
            icon={ShieldCheck}
            title="Privacy"
            desc="Choose whether to store and analyze call data."
          >
            <div>
              <p className="mb-1 text-sm font-medium text-ink-800">Data Storage Preference</p>
              <select
                value={value.dataStorage}
                onChange={(e) => set("dataStorage", e.target.value as VoiceSettings["dataStorage"])}
                className="w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-800 outline-none"
              >
                <option value="store_analyze">Store and Analyze Calls</option>
                <option value="store_only">Store Calls Only (no analytics)</option>
                <option value="no_store">Don&apos;t Store Calls (HIPAA)</option>
              </select>
            </div>
            {value.dataStorage === "store_analyze" && (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
                <p className="text-sm font-semibold text-emerald-700">Store and Analyze Calls: Enabled</p>
                <p className="mt-0.5 text-xs text-emerald-600">
                  Calls will be stored and analyzed. Available features:
                </p>
                <ul className="mt-1.5 space-y-0.5 text-xs text-emerald-600">
                  <li>• Call Audio Recording</li>
                  <li>• Call Transcripts</li>
                  <li>• Post-Call Outcomes</li>
                  <li>• Call Summary</li>
                  <li>• Call Sentiment Analysis</li>
                  <li>• Call Rating and Analysis</li>
                </ul>
              </div>
            )}
            {value.dataStorage === "store_only" && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700">
                Calls are recorded and transcribed, but no AI analysis (summary, outcomes, sentiment) runs.
              </div>
            )}
            {value.dataStorage === "no_store" && (
              <div className="rounded-lg border border-ink-200 bg-ink-50 p-3 text-xs text-ink-500">
                HIPAA mode — no recording, transcript, or analytics are stored on the provider&apos;s side.
              </div>
            )}
          </SettingsGroup>

          {/* Post-Call Data Extraction */}
          <SettingsGroup
            icon={ClipboardList}
            title="Post-Call Data Extraction"
            desc="Define the information you want to extract from conversations."
          >
            {value.extractionFields.length === 0 ? (
              <p className="text-xs text-ink-400">No outcomes defined yet.</p>
            ) : (
              <div className="space-y-2">
                {value.extractionFields.map((f, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-ink-100 bg-ink-50/60 p-2">
                    <input
                      className="w-32 rounded-md border border-ink-200 bg-surface px-2 py-1.5 text-sm text-ink-800 outline-none"
                      placeholder="field name"
                      value={f.name}
                      onChange={(e) => updateField(i, { name: e.target.value })}
                    />
                    <input
                      className="min-w-40 flex-1 rounded-md border border-ink-200 bg-surface px-2 py-1.5 text-sm text-ink-800 outline-none"
                      placeholder="what to extract (e.g. the date the caller wants)"
                      value={f.description}
                      onChange={(e) => updateField(i, { description: e.target.value })}
                    />
                    <select
                      className="rounded-md border border-ink-200 bg-surface px-2 py-1.5 text-sm text-ink-800 outline-none"
                      value={f.type}
                      onChange={(e) => updateField(i, { type: e.target.value as ExtractionField["type"] })}
                    >
                      <option value="string">text</option>
                      <option value="number">number</option>
                      <option value="boolean">yes/no</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => removeField(i)}
                      className="rounded p-1 text-ink-400 hover:text-rose-500"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={addField}
              className="flex items-center gap-1.5 rounded-lg border border-dashed border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-500 hover:border-brand-400 hover:text-brand-600"
            >
              <Plus className="h-3.5 w-3.5" /> Add Manually
            </button>
          </SettingsGroup>
        </div>
      )}
    </div>
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
  // The Vapi assistant id, tracked in state so repeated saves in the same open
  // editor PATCH the same assistant instead of creating duplicates.
  const [vapiId, setVapiId] = useState<string | null>(initial?.vapiAssistantId ?? null);
  const [savedAgentId, setSavedAgentId] = useState<string | null>(initial?.id ?? null);
  const [voiceLibOpen, setVoiceLibOpen] = useState(false);
  // Which engine powers voice agents (Settings → Voice engine). Drives which
  // voices/models/settings this builder shows and how the agent is synced.
  const [voiceProvider, setVoiceProvider] = useState<VoiceProvider>("xai");
  useEffect(() => { fetchVoiceProvider().then(setVoiceProvider); }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileTexts, setFileTexts] = useState<Record<string, string>>({});
  const [extracting, setExtracting] = useState<string[]>([]);
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [importingWeb, setImportingWeb] = useState(false);

  useEffect(() => {
    fetchClinicSettings().then((s) => { if (s.website) setWebsiteUrl(s.website); });
  }, []);

  async function importWebsite() {
    const url = websiteUrl.trim();
    if (!url || importingWeb) return;
    setImportingWeb(true);
    try {
      const ws = await getWorkspaceId();
      const res = await fetch("/api/kb/website", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, ws }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not read the website.");
      const label = `Website — ${(data.title || url).slice(0, 60)}`;
      setFileTexts((prev) => ({ ...prev, [label]: data.text }));
      setForm((f) => ({ ...f, kbFiles: f.kbFiles.includes(label) ? f.kbFiles : [...f.kbFiles, label] }));
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : "Website import failed." });
    } finally {
      setImportingWeb(false);
    }
  }

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function onFiles(list: FileList | null) {
    if (!list) return;
    const files = Array.from(list);
    for (const file of files) {
      if (form.kbFiles.includes(file.name)) continue;
      let text = "";
      if (/\.(txt|md|csv|json)$/i.test(file.name)) {
        text = await file.text();
      } else if (/\.(pdf|docx|doc|png|jpe?g|webp|tiff?|gif|bmp)$/i.test(file.name)) {
        // Read the real text out of PDF / Word / scanned images on the server.
        setExtracting((p) => [...p, file.name]);
        try {
          const fd = new FormData();
          fd.append("file", file, file.name);
          fd.append("name", file.name);
          const res = await fetch("/api/kb/extract", { method: "POST", body: fd });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error ?? "Could not read this document.");
          text = data.text;
        } catch (e) {
          text = `[Could not read ${file.name}: ${e instanceof Error ? e.message : "extraction failed"}]`;
        } finally {
          setExtracting((p) => p.filter((n) => n !== file.name));
        }
      } else {
        text = `[Document on file: ${file.name}]`;
      }
      setFileTexts((prev) => ({ ...prev, [file.name]: text.slice(0, 200_000) }));
      setForm((f) => ({ ...f, kbFiles: [...f.kbFiles, file.name] }));
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // The stored text for a KB file: this session's extraction, or the section
  // saved under its "--- name ---" marker inside the combined knowledge base.
  function kbTextFor(name: string): string {
    if (fileTexts[name]) return fileTexts[name];
    const kb = form.knowledgeBase ?? "";
    const marker = `--- ${name} ---`;
    const i = kb.indexOf(marker);
    if (i === -1) return "";
    const start = i + marker.length;
    const next = kb.indexOf("\n--- ", start);
    return kb.slice(start, next === -1 ? undefined : next).trim();
  }

  // Download a KB document's extracted text (originals aren't stored — the
  // agent reads text, so text is what we keep and what you get back).
  function downloadKbFile(name: string) {
    const text = kbTextFor(name);
    if (!text) return;
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = /\.(txt|md|csv|json)$/i.test(name) ? name : `${name}.txt`;
    a.click();
    URL.revokeObjectURL(url);
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
    // Use the existing row on retry (savedAgentId) so a Vapi failure after a
    // successful create doesn't insert a duplicate agent on the next attempt.
    const existingId = initial?.id ?? savedAgentId;
    if (existingId) {
      res = await updateAgent(existingId, payload);
      res = { ...res, id: existingId };
    } else {
      res = await createAgent(payload);
      if (res.ok && res.id) setSavedAgentId(res.id);
    }

    let message = res.message;
    let vapiOk = true; // non-voice agents don't need Vapi
    if (res.ok && form.kind === "voice" && voiceProvider === "xai") {
      // Mirror the agent into the xAI console (Voice → Agents) so it's visible
      // and phone-deployable there too. Non-blocking: calls work either way,
      // since sessions are built per-call from the saved agent.
      const agentId = res.id ?? initial?.id ?? savedAgentId;
      let synced = "";
      try {
        const xr = await fetch("/api/xai/agents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId }),
        });
        const xd = await xr.json().catch(() => ({}));
        synced = xr.ok ? " and synced to your xAI console (Voice → Agents)" : ` (xAI console sync failed: ${xd.error ?? "unreachable"} — calls still work)`;
      } catch {
        synced = " (xAI console sync unreachable — calls still work)";
      }
      message = `${initial || savedAgentId ? "Agent saved" : "Agent created"} — runs on Grok voice (xAI)${synced}.`;
    }
    if (res.ok && form.kind === "voice" && voiceProvider === "vapi") {
      vapiOk = false;
      try {
        const vapiRes = await fetch("/api/vapi/assistants", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: form.name,
            voice: form.voice,
            voiceId: form.voiceId,
            model: form.model.replace(/^openai\//, ""),
            firstMessage: form.firstMessage,
            agentIdentity: form.agentIdentity,
            instructions: form.instructions,
            behavior: form.behavior,
            knowledgeBase: payload.knowledgeBase,
            language: form.language,
            firstMessageMode: form.firstMessageMode,
            voiceSettings: form.voiceSettings,
            vapiAssistantId: vapiId, // tracked id → PATCH the same assistant, never duplicate
            canBook: form.canBook,
            canReschedule: form.canReschedule,
            canCancel: form.canCancel,
          }),
        });
        const vapiData = await vapiRes.json().catch(() => ({}));
        const agentId = res.id ?? initial?.id ?? savedAgentId;
        if (vapiRes.ok && vapiData.id && agentId) {
          await setAgentVapiId(agentId, vapiData.id);
          setVapiId(vapiData.id); // so the next save in this session PATCHes it
          vapiOk = true;
          message = initial || savedAgentId ? "Agent saved and re-synced to Vapi." : "Agent saved and created in Vapi.";
        } else {
          message = `Saved, but NOT synced to Vapi — ${vapiData.error ?? vapiData.message ?? "Vapi isn't connected"}. Fix this and Save again (the agent won't answer calls until it syncs).`;
        }
      } catch {
        message = "Saved, but could not reach Vapi to sync. Save again once Vapi is reachable (the agent won't answer calls until it syncs).";
      }
    }
    setSaving(false);
    setResult({ ok: res.ok && vapiOk, message });
    // Only close/refresh when the voice agent actually synced to Vapi; otherwise
    // keep the editor open so the user can fix the Vapi issue and re-save.
    if (res.ok && vapiOk) onSaved();
  }

  const abilities = ABILITIES_BY_ROLE[form.role] ?? ["canBook", "canReschedule", "canCancel"];
  const abilityLabels = { canBook: "Book appointments", canReschedule: "Reschedule / change times", canCancel: "Cancel appointments" } as const;

  return (
    <>
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

          <div className="mb-5 flex items-center gap-2 rounded-xl border border-brand-200 bg-brand-50/50 px-4 py-3">
            {form.kind === "voice" ? <PhoneCall className="h-5 w-5 text-brand-600 dark:text-brand-300" /> : <MessageCircle className="h-5 w-5 text-brand-600 dark:text-brand-300" />}
            <div>
              <p className="text-sm font-semibold text-ink-900">{form.kind === "voice" ? "Voice agent" : "Chat agent"}</p>
              <p className="text-xs text-ink-500">{form.kind === "voice" ? (voiceProvider === "xai" ? "Voice — runs on Grok voice (xAI). Switch engines in Settings → Voice engine." : "Voice — runs on Vapi + ElevenLabs. Switch engines in Settings → Voice engine.") : "WhatsApp · Instagram · SMS · Email — replies in the inbox."}</p>
            </div>
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
            <Field label={form.kind === "chat" ? "AI model" : voiceProvider === "xai" ? "Voice model (Grok · xAI)" : "Model (Vapi)"}>
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
                ) : voiceProvider === "xai" ? (
                  <>
                    {XAI_VOICE_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
                    {!/^grok-voice/.test(form.model) && <option value={form.model}>{form.model} (legacy — pick a Grok model)</option>}
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
            {form.kind === "voice" && voiceProvider === "xai" && (
              <div className="md:col-span-2">
                <Field label="Voice (xAI) — pick from the dropdown, tap Preview to hear it">
                  <XaiVoicePicker value={form.voice} onChange={(v) => set("voice", v)} />
                </Field>
              </div>
            )}
            {form.kind === "voice" && voiceProvider === "vapi" && (
              <>
                <Field label="Voice (ElevenLabs)">
                  <button
                    type="button"
                    onClick={() => setVoiceLibOpen(true)}
                    className="flex w-full items-center justify-between gap-2 rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-left text-sm text-ink-800 hover:border-brand-400"
                  >
                    <span className="truncate">{form.voice || "Choose a voice…"}</span>
                    <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-brand-600">
                      <Play className="h-3.5 w-3.5" /> Browse &amp; preview
                    </span>
                  </button>
                </Field>
                <Field label="Transcriber">
                  <select
                    className={inputCls}
                    value={form.voiceSettings.transcriber}
                    onChange={(e) => set("voiceSettings", { ...form.voiceSettings, transcriber: e.target.value as "nova-2" | "nova-3" })}
                  >
                    <option value="nova-2">Deepgram · Nova-2 (multilingual)</option>
                    <option value="nova-3">Deepgram · Nova-3 (English)</option>
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

          {/* Voice agents use the Callab-style Prompt Configuration (Identity /
              Tasks / Style Guardrails). Chat agents keep the simple Instructions
              + Behavior boxes, as before. */}
          {form.kind === "voice" ? (
            <div className="mt-5 rounded-xl border border-ink-200 p-4">
              <div className="mb-1 flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-brand-500" />
                <p className="text-sm font-semibold text-ink-900">Prompt Configuration</p>
              </div>
              <p className="mb-4 text-xs text-ink-400">Describe the AI&apos;s identity, tasks, and style guardrails.</p>

              <div className="space-y-4">
                <Field label="Agent Identity — who the agent is, its tone and role">
                  <textarea
                    rows={3}
                    className={inputCls}
                    placeholder="Sarah is the AI-powered receptionist for Bright Smile Dental. She is the first point of contact for all calls, handling patient inquiries, booking appointments, and providing clinic information. Sarah is warm, professional, and reassuring."
                    value={form.agentIdentity}
                    onChange={(e) => set("agentIdentity", e.target.value)}
                  />
                </Field>

                <Field label="Tasks — the specific goals and actions the agent performs">
                  <textarea
                    rows={4}
                    className={inputCls}
                    placeholder={
                      "• Greet the caller and ask how you can help.\n" +
                      "• Answer questions about services, hours, pricing and insurance from the knowledge base.\n" +
                      "• When they want to book: confirm the treatment, check real availability, collect name/phone/email, and book.\n" +
                      "• Reschedule or cancel an existing appointment when asked."
                    }
                    value={form.instructions}
                    onChange={(e) => set("instructions", e.target.value)}
                  />
                </Field>

                <Field label="Style Guardrails — phrases to use or avoid, and the conversational flow">
                  <textarea
                    rows={4}
                    className={inputCls}
                    placeholder={
                      "• Keep replies short — 1-2 sentences. Ask only one question at a time.\n" +
                      "• Never ask the same question twice — remember what the patient already told you.\n" +
                      "• Don't repeat the greeting on every message.\n" +
                      "• Before offering times, check real availability; only offer open slots.\n" +
                      "• If you don't know something, say you'll check with the team — never make up clinical advice."
                    }
                    value={form.behavior}
                    onChange={(e) => set("behavior", e.target.value)}
                  />
                </Field>
              </div>
            </div>
          ) : (
            <>
              <div className="mt-4">
                <Field label="Instructions — role, goal, what to say">
                  <textarea
                    rows={4}
                    className={inputCls}
                    placeholder="You are Sarah, the receptionist for Bright Smile Dental. Your goal is to answer questions and BOOK appointments. Greet by name, confirm the service they want, check available times, and book. Keep replies to 1-2 short sentences."
                    value={form.instructions}
                    onChange={(e) => set("instructions", e.target.value)}
                  />
                </Field>
              </div>

              <div className="mt-4">
                <Field label="Behavior — rules, tone & negative rules (what NOT to do)">
                  <textarea
                    rows={4}
                    className={inputCls}
                    placeholder={
                      "• Never ask the same question twice — remember what the patient already told you.\n" +
                      "• Ask only one question at a time.\n" +
                      "• Don't repeat the greeting on every message.\n" +
                      "• Before offering times, check real availability; only offer open slots.\n" +
                      "• If you don't know something, say you'll check with the team — never make up clinical advice."
                    }
                    value={form.behavior}
                    onChange={(e) => set("behavior", e.target.value)}
                  />
                </Field>
                <p className="mt-1.5 text-xs text-ink-400">
                  Behavior is separate from Instructions: instructions say <em>what</em> the agent does; behavior says <em>how</em> it acts — the rules that stop repeated questions and keep replies natural.
                </p>
              </div>
            </>
          )}

          {form.kind === "voice" && voiceProvider === "vapi" && (
            <VoiceAdvancedSettings
              value={form.voiceSettings}
              onChange={(v) => set("voiceSettings", v)}
            />
          )}
          {form.kind === "voice" && voiceProvider === "xai" && (
            <div className="mt-4 space-y-2 rounded-xl border border-ink-100 bg-ink-50/40 p-4 text-xs text-ink-500">
              <p>
                <strong className="font-semibold text-ink-700">Grok voice (xAI)</strong> — turn detection, barge-in
                interruptions, noise handling and transcription are built into the Grok voice model, so there&apos;s nothing
                extra to tune here. Pick the voice and model above; the first message below is spoken word-for-word. Built-in
                live <strong className="font-semibold text-ink-700">web search</strong> is included (clinic facts still come only
                from the knowledge base). You can switch engines any time in Settings → Voice engine.
              </p>
              <p>
                <strong className="font-semibold text-ink-700">Deploy to a phone number:</strong> saving mirrors this agent into
                your{" "}
                <a href="https://console.x.ai" target="_blank" rel="noopener noreferrer" className="font-medium text-brand-600 underline">
                  xAI console
                </a>{" "}
                (Voice → Agents). Open it there → <em>Deployment</em> → add a Direct SIP number: point a number from Twilio, Telnyx,
                Plivo or any SIP trunk at <code className="rounded bg-ink-100 px-1">sip:{"{number}"}@sip.voice.x.ai;transport=tls</code>.{" "}
                <a
                  href="https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech/sip#telephony-providers"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-brand-600 underline"
                >
                  Provider steps
                </a>
                . Connectors (Gmail / Google Calendar) need a one-time login in the console; on calls through Pydent, email and
                calendar already work via your connected accounts.
              </p>
            </div>
          )}

          <div className="mt-4">
            <p className="mb-1.5 text-sm font-medium text-ink-700">
              Knowledge base — upload documents{form.kbFiles.length > 0 ? ` (${form.kbFiles.length})` : ""}
            </p>
            <p className="mb-2 text-xs text-ink-400">
              The agent&apos;s brain: hours, pricing, insurance, FAQs, promos. It answers only from these documents. Upload as many as you need.
            </p>
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-ink-100 bg-ink-50/60 p-2.5">
              <span className="text-xs font-medium text-ink-500">Import from your website:</span>
              <input
                className="min-w-48 flex-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-sm text-ink-800 outline-none placeholder:text-ink-400 focus:border-brand-400"
                placeholder="https://www.yourclinic.com"
                value={websiteUrl}
                onChange={(e) => setWebsiteUrl(e.target.value)}
              />
              <button
                type="button"
                onClick={importWebsite}
                disabled={importingWeb || !websiteUrl.trim()}
                className="shrink-0 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {importingWeb ? "Reading…" : "Fetch site"}
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".txt,.md,.csv,.json,.pdf,.doc,.docx,.png,.jpg,.jpeg,.webp,.tif,.tiff,.gif,.bmp"
              className="hidden"
              onChange={(e) => onFiles(e.target.files)}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-ink-300 py-4 text-sm font-medium text-ink-500 hover:border-brand-400 hover:text-brand-600 disabled:opacity-50 dark:hover:text-brand-300"
            >
              <Upload className="h-4 w-4" /> Upload documents (.txt, .md, .csv, .pdf, .docx, or a scanned image — text is read automatically)
            </button>
            {extracting.length > 0 && (
              <p className="mt-2 text-xs text-brand-600">Reading {extracting.join(", ")}…</p>
            )}
            {form.kbFiles.length > 0 && (
              <ul className="mt-2 space-y-1.5">
                {form.kbFiles.map((f) => {
                  const failed = (fileTexts[f] ?? "").startsWith("[Could not read");
                  const hasText = !failed && !!kbTextFor(f);
                  return (
                  <li key={f} className="flex items-center justify-between rounded-lg border border-ink-100 bg-ink-50 px-3 py-2 text-sm text-ink-700">
                    <span className="flex items-center gap-2">
                      <FileText className={`h-4 w-4 ${failed ? "text-rose-500" : "text-brand-500"}`} /> {f}
                      {failed ? (
                        <span className="text-xs text-rose-500">couldn&apos;t read</span>
                      ) : fileTexts[f] ? (
                        <span className="text-xs text-emerald-600">{fileTexts[f].length.toLocaleString()} chars read</span>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-0.5">
                      {hasText && (
                        <button onClick={() => downloadKbFile(f)} title="Download the extracted text" className="rounded p-1 text-ink-400 hover:text-brand-600">
                          <Download className="h-4 w-4" />
                        </button>
                      )}
                      <button onClick={() => removeFile(f)} title="Remove from the knowledge base" className="rounded p-1 text-ink-400 hover:text-rose-500">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </span>
                  </li>
                  );
                })}
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
    {voiceLibOpen && (
      <VoiceLibrary
        selectedId={form.voiceId}
        onSelect={(voiceId, displayName) => { set("voiceId", voiceId); set("voice", displayName); }}
        onClose={() => setVoiceLibOpen(false)}
      />
    )}
    </>
  );
}

// ------------------------------------------------------------ test chat

export function TestChatModal({ agent, onClose }: { agent: AiAgent; onClose: () => void }) {
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chats, setChats] = useState<TeamChat[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Test conversations are saved per agent under a namespaced key so they don't
  // mix with the AI Marketing chats — history persists between sessions.
  const key = `test:${agent.id}`;
  const refreshChats = useCallback(() => { listTeamChats(key).then(setChats); }, [key]);
  useEffect(() => { refreshChats(); }, [refreshChats]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  function newChat() { setChatId(null); setMessages([]); setError(null); setShowHistory(false); }
  async function openChat(c: TeamChat) {
    setChatId(c.id);
    setMessages(await fetchTeamChatMessages(c.id));
    setError(null);
    setShowHistory(false);
  }

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setError(null);
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setBusy(true);
    // Start (or reuse) a saved test conversation and record the patient's line.
    let cid = chatId;
    if (!cid) { cid = await createTeamChat(key, text.slice(0, 60)); setChatId(cid); refreshChats(); }
    if (cid) appendTeamChatMessage(cid, "user", text);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: agent.model,
          agentName: agent.name,
          agentIdentity: agent.agentIdentity,
          instructions: agent.instructions,
          behavior: agent.behavior,
          knowledgeBase: agent.knowledgeBase,
          language: agent.language,
          capabilities: { canBook: agent.canBook, canReschedule: agent.canReschedule, canCancel: agent.canCancel },
          messages: next,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "AI request failed");
      setMessages((m) => [...m, { role: "assistant", content: data.reply }]);
      if (cid) { appendTeamChatMessage(cid, "assistant", data.reply); refreshChats(); }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Test chat — ${agent.name}`} subtitle={`${agent.role} · ${agent.model} · answers only from its knowledge base`} wide>
      <div className="mb-2 flex items-center justify-between">
        <button onClick={() => setShowHistory((s) => !s)} className="flex items-center gap-1.5 rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50">
          <History className="h-3.5 w-3.5" /> Previous tests{chats.length ? ` (${chats.length})` : ""}
        </button>
        <button onClick={newChat} className="flex items-center gap-1.5 rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50">
          <Plus className="h-3.5 w-3.5" /> New test
        </button>
      </div>

      <div className="flex gap-3">
        {showHistory && (
          <div className="w-48 shrink-0 space-y-1 overflow-y-auto rounded-xl border border-ink-100 bg-ink-50/40 p-2" style={{ maxHeight: "20rem" }}>
            {chats.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-ink-400">No saved tests yet.</p>
            ) : chats.map((c) => (
              <div key={c.id} className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs hover:bg-ink-100 ${c.id === chatId ? "bg-brand-50" : ""}`}>
                <button onClick={() => openChat(c)} className="min-w-0 flex-1 text-left">
                  <p className="truncate text-ink-800">{c.title}</p>
                  <p className="text-[10px] text-ink-400">{(c.updatedAt ?? "").slice(0, 10)}</p>
                </button>
                <button onClick={async () => { await deleteTeamChat(c.id); if (c.id === chatId) newChat(); refreshChats(); }} className="rounded p-0.5 text-ink-300 opacity-0 hover:text-rose-500 group-hover:opacity-100"><Trash2 className="h-3 w-3" /></button>
              </div>
            ))}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex h-80 flex-col gap-3 overflow-y-auto rounded-xl border border-ink-100 bg-ink-50/50 p-4">
            {messages.length === 0 && (
              <p className="m-auto max-w-xs text-center text-sm text-ink-400">
                Pretend you&apos;re a patient — ask about hours, prices, insurance, or try to book an appointment. This test is saved so you can review it later.
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${m.role === "user" ? "rounded-br-sm bg-brand-600 text-white" : "rounded-bl-sm border border-ink-200 bg-surface text-ink-800"}`}>{m.content}</div>
              </div>
            ))}
            {busy && (
              <div className="flex justify-start">
                <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-sm border border-ink-200 bg-surface px-3.5 py-2 text-sm text-ink-400"><Bot className="h-4 w-4 animate-pulse" /> {agent.name} is typing…</div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          {error && <p className="mt-2 text-sm text-amber-600">{error}</p>}
          <div className="mt-3 flex gap-2">
            <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="Message as a patient…" className={inputCls} />
            <button onClick={send} disabled={busy} className="rounded-xl bg-brand-600 px-4 text-white hover:bg-brand-700 disabled:opacity-50"><Send className="h-5 w-5" /></button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------- test voice call
// Talks to the agent live in the browser over the xAI Grok Voice Agent API —
// full-duplex speech-to-speech on Grok voice models, with the agent's tools
// (booking, email) executed server-side mid-call.

type CallState = "idle" | "connecting" | "live" | "ended" | "error";

export function TestCallModal({ agent, onClose }: { agent: AiAgent; onClose: () => void }) {
  const [state, setState] = useState<CallState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<{ speaker: string; text: string }[]>([]);
  const [assistantSpeaking, setAssistantSpeaking] = useState(false);
  const [chats, setChats] = useState<TeamChat[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [viewing, setViewing] = useState<{ role: "user" | "assistant"; content: string }[] | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const callRef = useRef<any>(null);
  const transcriptRef = useRef<{ speaker: string; text: string }[]>([]);
  const savedRef = useRef(false);
  const [voiceProvider, setVoiceProvider] = useState<VoiceProvider>("xai");
  useEffect(() => { fetchVoiceProvider().then(setVoiceProvider); }, []);

  // Voice tests are saved into the SAME per-agent history as the chat tests, so
  // "Previous tests" shows both as reviewable transcripts.
  const key = `test:${agent.id}`;
  const refreshChats = useCallback(() => { listTeamChats(key).then(setChats); }, [key]);
  useEffect(() => { refreshChats(); }, [refreshChats]);

  // Persist the call transcript once (on call end / modal close).
  const saveTranscript = useCallback(async () => {
    if (savedRef.current) return;
    const lines = transcriptRef.current;
    if (lines.length < 1) return;
    savedRef.current = true;
    const first = lines.find((l) => l.speaker === "You")?.text ?? "Voice test";
    const cid = await createTeamChat(key, `🎙 ${first.slice(0, 55)}`);
    if (cid) { for (const l of lines) await appendTeamChatMessage(cid, l.speaker === "You" ? "user" : "assistant", l.text); }
    refreshChats();
  }, [key, refreshChats]);

  useEffect(() => {
    return () => { void saveTranscript(); callRef.current?.stop?.(); };
  }, [saveTranscript]);

  const pushLine = (speaker: string, text: string) => {
    const line = { speaker, text };
    transcriptRef.current = [...transcriptRef.current, line];
    setTranscript((t) => [...t, line]);
  };

  // Grok voice (xAI) — the default engine.
  async function startXai() {
    const { XaiRealtimeCall } = await import("@/lib/xai-realtime-client");
    const call = new XaiRealtimeCall();
    callRef.current = call;
    await call.start(agent.id, {
      onState: (s: "live" | "ended" | "error") => {
        setState(s);
        if (s === "ended") void saveTranscript();
      },
      onError: (m: string) => {
        setState("error");
        setError(m);
      },
      onSpeaking: setAssistantSpeaking,
      onLine: (speaker: "user" | "assistant", text: string) => pushLine(speaker === "assistant" ? agent.name : "You", text),
    });
  }

  // Vapi — used when the clinic selected Vapi in Settings → Voice engine.
  async function startVapi() {
    const { default: Vapi } = await import("@vapi-ai/web");
    const vapi = new Vapi(VAPI_PUBLIC_KEY);
    callRef.current = vapi;

    vapi.on("call-start", () => setState("live"));
    vapi.on("call-end", () => { setState("ended"); void saveTranscript(); });
    vapi.on("speech-start", () => setAssistantSpeaking(true));
    vapi.on("speech-end", () => setAssistantSpeaking(false));
    vapi.on("error", (e: unknown) => {
      setState("error");
      setError(e instanceof Error ? e.message : JSON.stringify(e).slice(0, 200));
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vapi.on("message", (msg: any) => {
      if (msg.type === "transcript" && msg.transcriptType === "final") {
        pushLine(msg.role === "assistant" ? agent.name : "You", msg.transcript);
      }
    });

    if (agent.vapiAssistantId) {
      await vapi.start(agent.vapiAssistantId);
    } else {
      // Agent not synced to Vapi yet — start with an inline assistant config.
      const vs = agent.voiceSettings;
      await vapi.start({
        name: agent.name,
        firstMessage: agent.firstMessage || `Hi, this is ${agent.name} from the dental office. How can I help?`,
        model: {
          provider: "openai",
          model: agent.model.replace(/^openai\//, "").replace(/^grok-voice.*$/, "gpt-4o-mini") || "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: [
                agent.agentIdentity && `AGENT IDENTITY:\n${agent.agentIdentity}`,
                agent.instructions && `TASKS:\n${agent.instructions}`,
                agent.behavior && `STYLE GUARDRAILS (how to speak — phrases to use/avoid, flow):\n${agent.behavior}`,
                agent.knowledgeBase && `KNOWLEDGE BASE:\n${agent.knowledgeBase}`,
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
          ],
        },
        voice: agent.voiceId
          ? { provider: "11labs", voiceId: agent.voiceId }
          : { provider: "vapi", voiceId: VOICE_IDS[agent.voice] ?? "Leah" },
        backgroundDenoisingEnabled: vs.noiseReductionEnabled,
        maxDurationSeconds: Math.min(43200, Math.max(10, vs.maxCallDuration * 60)),
        silenceTimeoutSeconds: Math.min(3600, Math.max(5, vs.maxSilenceDuration)),
        startSpeakingPlan: {
          waitSeconds: Math.min(5, Math.max(0, vs.detectionTimeout)),
          ...(vs.turnDetectionEnabled && vs.detectionMode !== "fixed"
            ? { smartEndpointingPlan: { provider: "livekit" } }
            : {}),
          transcriptionEndpointingPlan: {
            onPunctuationSeconds: vs.minSilenceDuration,
            onNoPunctuationSeconds: vs.endOfSpeechTimeout,
          },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    }
  }

  async function start() {
    setState("connecting");
    setError(null);
    setViewing(null);
    savedRef.current = false;
    transcriptRef.current = [];
    setTranscript([]);
    try {
      if (voiceProvider === "vapi") await startVapi();
      else await startXai();
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : "Could not start the call.");
    }
  }

  function stop() {
    callRef.current?.stop?.();
    setState("ended");
    void saveTranscript();
  }

  async function openChat(c: TeamChat) { setViewing(await fetchTeamChatMessages(c.id)); setShowHistory(false); }

  return (
    <Modal
      open
      onClose={() => {
        stop();
        onClose();
      }}
      title={`Test call — talk to ${agent.name}`}
      subtitle={`Live web call on ${voiceProvider === "vapi" ? "Vapi" : "Grok voice (xAI)"} — allow microphone access when your browser asks.`}
      wide
    >
      <div className="mb-1 flex items-center justify-between">
        <button onClick={() => { setShowHistory((s) => !s); setViewing(null); }} className="flex items-center gap-1.5 rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50">
          <History className="h-3.5 w-3.5" /> Previous tests{chats.length ? ` (${chats.length})` : ""}
        </button>
        {viewing && <button onClick={() => setViewing(null)} className="text-xs font-medium text-brand-600 hover:text-brand-700">← back to the call</button>}
      </div>

      {showHistory && (
        <div className="mb-3 max-h-40 space-y-1 overflow-y-auto rounded-xl border border-ink-100 bg-ink-50/40 p-2">
          {chats.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-ink-400">No saved tests yet — finish a call and it&apos;s saved here.</p>
          ) : chats.map((c) => (
            <div key={c.id} className="group flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs hover:bg-ink-100">
              <button onClick={() => openChat(c)} className="min-w-0 flex-1 text-left"><span className="truncate text-ink-800">{c.title}</span> <span className="text-[10px] text-ink-400">· {(c.updatedAt ?? "").slice(0, 10)}</span></button>
              <button onClick={async () => { await deleteTeamChat(c.id); refreshChats(); }} className="rounded p-0.5 text-ink-300 opacity-0 hover:text-rose-500 group-hover:opacity-100"><Trash2 className="h-3 w-3" /></button>
            </div>
          ))}
        </div>
      )}

      {viewing ? (
        <div className="max-h-96 space-y-2 overflow-y-auto rounded-xl border border-ink-100 bg-ink-50/50 p-4">
          {viewing.map((m, i) => (
            <p key={i} className="text-sm text-ink-700"><span className="font-semibold text-ink-900">{m.role === "assistant" ? agent.name : "You"}:</span> {m.content}</p>
          ))}
        </div>
      ) : (
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
          {state === "connecting" && (voiceProvider === "vapi" ? "Connecting to Vapi…" : "Connecting to Grok voice…")}
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
      )}
    </Modal>
  );
}
