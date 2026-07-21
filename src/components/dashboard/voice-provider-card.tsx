"use client";

import { useEffect, useState } from "react";
import { AudioLines, Check } from "lucide-react";
import { Card } from "@/components/ui";
import { toast } from "@/components/toast";
import { fetchVoiceProvider, saveVoiceProvider, type VoiceProvider } from "@/lib/db";

// Settings card: choose which engine powers the clinic's voice agents. The
// choice drives the whole voice experience — the agent builder shows that
// provider's voices/models/settings, and test calls run on it.
const OPTIONS: { id: VoiceProvider; name: string; desc: string; points: string[] }[] = [
  {
    id: "xai",
    name: "xAI Grok Voice",
    desc: "Grok's realtime speech-to-speech models with xAI's voices (Eve, Ara, Rex, Sal, Leo).",
    points: ["Voices & models by xAI", "In-browser calls + live booking tools", "Uses the X_AI_VOICE_KEY on the server"],
  },
  {
    id: "vapi",
    name: "Vapi",
    desc: "Vapi's calling stack with ElevenLabs voices, transcriber choice and advanced call tuning.",
    points: ["ElevenLabs voice library", "Phone numbers & outbound dialing", "Advanced VAD / interruption settings"],
  },
];

export function VoiceProviderCard() {
  const [provider, setProvider] = useState<VoiceProvider>("xai");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<VoiceProvider | null>(null);

  useEffect(() => {
    fetchVoiceProvider().then((p) => {
      setProvider(p);
      setLoading(false);
    });
  }, []);

  async function choose(p: VoiceProvider) {
    if (p === provider || saving) return;
    setSaving(p);
    const res = await saveVoiceProvider(p);
    setSaving(null);
    if (res.ok) setProvider(p);
    toast(res.message, res.ok ? "success" : "info");
  }

  return (
    <Card className="p-6">
      <h2 className="flex items-center gap-2 font-semibold text-ink-900">
        <AudioLines className="h-5 w-5 text-brand-500" /> Voice engine
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-500">
        Pick which engine your voice agents run on. The one you select is what works — the agent builder shows that
        engine&apos;s voices and settings, and test calls connect to it.
      </p>

      {loading ? (
        <p className="py-6 text-center text-sm text-ink-500">Loading…</p>
      ) : (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {OPTIONS.map((o) => {
            const active = provider === o.id;
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => choose(o.id)}
                disabled={!!saving}
                className={`rounded-2xl border p-4 text-left transition-all ${
                  active ? "border-brand-500 bg-brand-500/5 ring-1 ring-brand-500" : "border-ink-200 hover:border-brand-300"
                } disabled:opacity-60`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-ink-900">{o.name}</span>
                  {active ? (
                    <span className="flex items-center gap-1 rounded-full bg-brand-600 px-2 py-0.5 text-[11px] font-semibold text-white">
                      <Check className="h-3 w-3" /> Selected
                    </span>
                  ) : (
                    <span className="text-xs font-medium text-ink-400">{saving === o.id ? "Saving…" : "Select"}</span>
                  )}
                </div>
                <p className="mt-1 text-xs text-ink-500">{o.desc}</p>
                <ul className="mt-2 space-y-1">
                  {o.points.map((pt) => (
                    <li key={pt} className="flex items-start gap-1.5 text-xs text-ink-600">
                      <span className="mt-1 inline-block h-1 w-1 shrink-0 rounded-full bg-brand-400" /> {pt}
                    </li>
                  ))}
                </ul>
              </button>
            );
          })}
        </div>
      )}
      <p className="mt-3 text-xs text-ink-400">
        Note: phone numbers and outbound phone dialing always run through Vapi for now — xAI doesn&apos;t offer outbound
        calling yet. This switch controls the agent builder and in-browser calls.
      </p>
    </Card>
  );
}
