"use client";

import { useEffect, useState } from "react";
import { AudioLines, Check, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui";
import { toast } from "@/components/toast";
import { fetchVoiceProvider, saveVoiceProvider, fetchAgents, setAgentVapiId, type VoiceProvider, type AiAgent } from "@/lib/db";

// Settings card: choose which engine powers the clinic's voice agents. The
// choice drives the whole voice experience — the agent builder shows that
// provider's models/voices/settings, test calls run on it, and phone numbers
// route through it.
//
// LiveKit needs no per-agent sync: the deployed Pydent worker reads each agent's
// live config from Pydent on every call. Vapi keeps its own copy of each
// assistant, so switching TO Vapi pushes every voice agent into Vapi.
const OPTIONS: { id: VoiceProvider; name: string; desc: string; points: string[] }[] = [
  {
    id: "livekit",
    name: "LiveKit",
    desc: "Your own LiveKit Cloud project: pick STT, LLM and TTS/voice per agent (Deepgram, OpenAI, Gemini, Inworld, Cartesia…), SIP phone numbers, live call logs.",
    points: ["Per-agent STT / LLM / TTS + voice", "Edits in Pydent apply on the next call — nothing to sync", "SIP numbers + the clinic landline box"],
  },
  {
    id: "vapi",
    name: "Vapi",
    desc: "Vapi's calling stack with ElevenLabs voices, transcriber choice and advanced call tuning.",
    points: ["ElevenLabs voice library", "Phone numbers & outbound dialing", "Advanced VAD / interruption settings"],
  },
];

// Push one saved voice agent into Vapi (create-or-PATCH). Returns an error
// string, or null on success. (LiveKit needs nothing — see above.)
async function syncAgentToVapi(a: AiAgent): Promise<string | null> {
  try {
    const r = await fetch("/api/vapi/assistants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: a.name,
        voice: a.voice,
        voiceId: a.voiceId,
        model: (a.model ?? "").replace(/^openai\//, ""),
        firstMessage: a.firstMessage,
        agentIdentity: a.agentIdentity,
        instructions: a.instructions,
        behavior: a.behavior,
        knowledgeBase: a.knowledgeBase,
        language: a.language,
        firstMessageMode: a.firstMessageMode,
        voiceSettings: a.voiceSettings,
        vapiAssistantId: a.vapiAssistantId, // PATCH the same assistant, never duplicate
        canBook: a.canBook,
        canReschedule: a.canReschedule,
        canCancel: a.canCancel,
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.id) {
      if (d.id !== a.vapiAssistantId) await setAgentVapiId(a.id, d.id);
      return null;
    }
    return d.error ?? d.message ?? "Vapi sync failed";
  } catch {
    return "Vapi unreachable";
  }
}

export function VoiceProviderCard() {
  const [provider, setProvider] = useState<VoiceProvider>("livekit");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<VoiceProvider | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  useEffect(() => {
    fetchVoiceProvider().then((p) => {
      setProvider(p);
      setLoading(false);
    });
  }, []);

  async function syncAllToVapi() {
    const { agents } = await fetchAgents();
    const voice = agents.filter((a) => a.kind === "voice");
    if (voice.length === 0) return;
    const failures: string[] = [];
    let done = 0;
    for (const a of voice) {
      setSyncNote(`Syncing ${a.name} to Vapi… (${done + 1}/${voice.length})`);
      const err = await syncAgentToVapi(a);
      if (err) failures.push(`${a.name}: ${err}`);
      done++;
    }
    setSyncNote(null);
    if (failures.length === 0) toast(`${voice.length === 1 ? `${voice[0].name} is` : `All ${voice.length} voice agents are`} now live on Vapi.`, "success");
    else toast(`Engine switched, but some agents didn't sync to Vapi — ${failures.join(" · ")}. Open those agents and Save to retry.`, "info");
  }

  async function choose(p: VoiceProvider) {
    if (p === provider || saving) return;
    setSaving(p);
    const res = await saveVoiceProvider(p);
    if (res.ok) {
      setProvider(p);
      toast(res.message, "success");
      if (p === "vapi") await syncAllToVapi();
      else toast("All voice agents now run on LiveKit — the worker reads each agent's settings live, so there's nothing to sync.", "success");
    } else {
      toast(res.message, "info");
    }
    setSaving(null);
  }

  return (
    <Card className="p-6">
      <h2 className="flex items-center gap-2 font-semibold text-ink-900">
        <AudioLines className="h-5 w-5 text-brand-500" /> Voice engine
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-500">
        Pick which engine your voice agents run on. The one you select is what works — the agent builder shows that
        engine&apos;s models and voices, test calls connect to it, and phone numbers route through it.
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
      {syncNote && (
        <p className="mt-3 flex items-center gap-2 text-xs font-medium text-brand-600">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" /> {syncNote}
        </p>
      )}
      <p className="mt-3 text-xs text-ink-400">
        LiveKit needs its credentials in the LiveKit card below and the Pydent worker deployed once (see livekit-agent/README.md).
      </p>
    </Card>
  );
}
