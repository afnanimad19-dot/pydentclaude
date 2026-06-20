"use client";

import { useEffect, useRef, useState } from "react";
import { Play, Loader2, Mic, Square, Trash2, Check, Sparkles, CircleAlert } from "lucide-react";
import { Modal, Field, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import { fetchCustomVoices, saveCustomVoice, removeCustomVoice, type CustomVoice } from "@/lib/db";

interface LibVoice {
  id: string;
  name: string;
  gender: string;
  accent: string;
  description: string;
  previewUrl: string | null;
}

// Browser-speech fallback used when no managed-TTS key is configured yet.
function browserPreview(gender: string) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  const synth = window.speechSynthesis;
  synth.cancel();
  const u = new SpeechSynthesisUtterance("Hi, thank you for calling Bright Smile Dental. How can I help you today?");
  const female = /female/i.test(gender);
  const voices = synth.getVoices();
  u.voice =
    voices.find((v) => /en/i.test(v.lang) && (female ? /female|samantha|victoria|zira|aria/i.test(v.name) : /male|david|daniel|alex|guy/i.test(v.name))) ||
    voices.find((v) => /en/i.test(v.lang)) ||
    voices[0] ||
    null;
  u.pitch = female ? 1.1 : 0.95;
  synth.speak(u);
}

export function VoiceLibrary({
  selectedId,
  onSelect,
  onClose,
}: {
  selectedId: string | null;
  onSelect: (voiceId: string, displayName: string) => void;
  onClose: () => void;
}) {
  const [configured, setConfigured] = useState(true);
  const [premade, setPremade] = useState<LibVoice[]>([]);
  const [custom, setCustom] = useState<CustomVoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState<string | null>(null);
  const [tab, setTab] = useState<"library" | "create">("library");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  function loadCustom() {
    fetchCustomVoices().then(setCustom);
  }
  useEffect(() => {
    fetch("/api/voice/list")
      .then((r) => r.json())
      .then((d) => {
        setConfigured(!!d.configured);
        setPremade(d.voices ?? []);
      })
      .catch(() => setConfigured(false))
      .finally(() => setLoading(false));
    loadCustom();
    return () => audioRef.current?.pause();
  }, []);

  async function preview(v: { id: string; gender: string; previewUrl?: string | null }) {
    audioRef.current?.pause();
    if (!configured) {
      browserPreview(v.gender);
      return;
    }
    setPlaying(v.id);
    try {
      let src: string;
      if (v.previewUrl) {
        src = v.previewUrl;
      } else {
        const res = await fetch("/api/voice/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voiceId: v.id }),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          throw new Error(e.error ?? "Preview failed");
        }
        src = URL.createObjectURL(await res.blob());
      }
      const audio = new Audio(src);
      audioRef.current = audio;
      audio.onended = () => setPlaying(null);
      audio.onerror = () => setPlaying(null);
      await audio.play();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not play preview", "info");
      setPlaying(null);
    }
  }

  function choose(id: string, name: string) {
    onSelect(id, name);
    onClose();
  }

  return (
    <Modal open onClose={onClose} title="Voice library" subtitle="Pick a voice and hear it — or record your own custom voice." wide>
      <div className="mb-4 flex gap-2">
        <button
          onClick={() => setTab("library")}
          className={`rounded-lg px-3.5 py-1.5 text-sm font-medium ${tab === "library" ? "bg-brand-600 text-white" : "border border-ink-200 text-ink-600 hover:bg-ink-50"}`}
        >
          Voice library
        </button>
        <button
          onClick={() => setTab("create")}
          className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium ${tab === "create" ? "bg-brand-600 text-white" : "border border-ink-200 text-ink-600 hover:bg-ink-50"}`}
        >
          <Mic className="h-4 w-4" /> Create custom voice
        </button>
      </div>

      {!configured && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-700">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Real voices &amp; custom voice cloning need an <strong>ELEVENLABS_API_KEY</strong> in Netlify → Environment variables.
            Until then, Preview uses your browser&apos;s basic voice and you can still pick a voice for the agent.
          </span>
        </div>
      )}

      {tab === "library" ? (
        <div className="max-h-[60vh] space-y-5 overflow-y-auto pr-1">
          {loading ? (
            <p className="flex items-center gap-2 py-8 text-sm text-ink-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading voices…</p>
          ) : (
            <>
              {custom.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Your custom voices</p>
                  <div className="space-y-2">
                    {custom.map((v) => (
                      <VoiceRow
                        key={v.id}
                        name={v.name}
                        meta={[v.gender, v.accent].filter(Boolean).join(" · ") || "Cloned voice"}
                        selected={selectedId === v.voiceId}
                        playing={playing === v.voiceId}
                        onPreview={() => preview({ id: v.voiceId, gender: v.gender })}
                        onSelect={() => choose(v.voiceId, v.name)}
                        onDelete={async () => { await removeCustomVoice(v.id); loadCustom(); }}
                      />
                    ))}
                  </div>
                </div>
              )}
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Premade voices</p>
                <div className="space-y-2">
                  {premade.map((v) => (
                    <VoiceRow
                      key={v.id}
                      name={v.name}
                      meta={[v.gender, v.accent, v.description].filter(Boolean).join(" · ")}
                      selected={selectedId === v.id}
                      playing={playing === v.id}
                      onPreview={() => preview(v)}
                      onSelect={() => choose(v.id, `${v.name} · ${v.accent || v.gender}`)}
                    />
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      ) : (
        <CreateVoice
          configured={configured}
          onCreated={(voiceId, name) => {
            loadCustom();
            setTab("library");
            choose(voiceId, name);
          }}
        />
      )}
    </Modal>
  );
}

function VoiceRow({
  name,
  meta,
  selected,
  playing,
  onPreview,
  onSelect,
  onDelete,
}: {
  name: string;
  meta: string;
  selected: boolean;
  playing: boolean;
  onPreview: () => void;
  onSelect: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${selected ? "border-brand-400 bg-brand-50/60" : "border-ink-100"}`}>
      <button
        onClick={onPreview}
        title="Hear this voice"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white hover:bg-brand-700"
      >
        {playing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink-900">{name}</p>
        <p className="truncate text-xs text-ink-400 capitalize">{meta}</p>
      </div>
      {onDelete && (
        <button onClick={onDelete} title="Delete voice" className="rounded-lg p-1.5 text-ink-400 hover:bg-rose-500/10 hover:text-rose-500">
          <Trash2 className="h-4 w-4" />
        </button>
      )}
      <button
        onClick={onSelect}
        className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold ${selected ? "bg-brand-600 text-white" : "border border-ink-200 text-ink-700 hover:bg-ink-50"}`}
      >
        {selected ? (<><Check className="h-3.5 w-3.5" /> Selected</>) : "Select"}
      </button>
    </div>
  );
}

function CreateVoice({ configured, onCreated }: { configured: boolean; onCreated: (voiceId: string, name: string) => void }) {
  const [name, setName] = useState("");
  const [gender, setGender] = useState("");
  const [consent, setConsent] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [saving, setSaving] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); recRef.current?.stream.getTracks().forEach((t) => t.stop()); }, []);

  async function startRec() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      rec.onstop = () => {
        setBlob(new Blob(chunksRef.current, { type: "audio/webm" }));
        stream.getTracks().forEach((t) => t.stop());
      };
      recRef.current = rec;
      rec.start();
      setBlob(null);
      setSeconds(0);
      setRecording(true);
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch {
      toast("Microphone access denied — allow it in your browser to record.", "info");
    }
  }

  function stopRec() {
    recRef.current?.stop();
    if (timerRef.current) clearInterval(timerRef.current);
    setRecording(false);
  }

  async function save() {
    if (!blob || !name.trim() || !consent) return;
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append("name", name.trim());
      fd.append("audio", blob, "sample.webm");
      const res = await fetch("/api/voice/clone", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Cloning failed");
      await saveCustomVoice(data.voiceId, name.trim(), gender);
      toast("Custom voice created.", "success");
      onCreated(data.voiceId, name.trim());
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not create voice", "info");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-ink-100 bg-ink-50/50 p-4 text-sm text-ink-600">
        <p className="flex items-center gap-2 font-medium text-ink-800"><Sparkles className="h-4 w-4 text-brand-500" /> Record about 20–30 seconds</p>
        <p className="mt-1 text-xs text-ink-500">
          Speak naturally — read a couple of sentences as if greeting a patient. A clean, quiet recording gives the best clone.
        </p>
      </div>

      <div className="flex items-center gap-3">
        {recording ? (
          <button onClick={stopRec} className="flex items-center gap-2 rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-rose-700">
            <Square className="h-4 w-4" /> Stop ({seconds}s)
          </button>
        ) : (
          <button onClick={startRec} className="flex items-center gap-2 rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700">
            <Mic className="h-4 w-4" /> {blob ? "Re-record" : "Start recording"}
          </button>
        )}
        {blob && !recording && <span className="text-sm text-emerald-600">✓ Recording ready ({seconds}s)</span>}
      </div>

      {blob && <audio controls src={URL.createObjectURL(blob)} className="w-full" />}

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Voice name"><input className={inputCls} placeholder="Dr. Omar's voice" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Gender (optional)">
          <select className={inputCls} value={gender} onChange={(e) => setGender(e.target.value)}>
            <option value="">—</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
          </select>
        </Field>
      </div>

      <label className="flex items-start gap-2 text-xs text-ink-600">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#7c3aed]" />
        I confirm I have permission to clone this voice and will not use it to impersonate anyone without consent.
      </label>

      <button
        onClick={save}
        disabled={!configured || !blob || !name.trim() || !consent || saving}
        className="flex items-center gap-2 rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Create voice
      </button>
      {!configured && <p className="text-xs text-amber-600">Add ELEVENLABS_API_KEY in Netlify to enable custom voice creation.</p>}
    </div>
  );
}
