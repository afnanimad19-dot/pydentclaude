"use client";

import { useEffect, useState } from "react";
import { AudioLines, Check, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui";
import { toast } from "@/components/toast";
import { fetchVoiceProvider, saveVoiceProvider, fetchAgents, setAgentVapiId, type VoiceProvider, type AiAgent } from "@/lib/db";

// Settings card: choose which engine powers the clinic's voice agents. The
// choice drives the whole voice experience — the agent builder shows that
// provider's voices/models/settings, and test calls run on it.
//
// Switching ALSO pushes every existing voice agent into the newly selected
// engine (xAI console mirror, or a Vapi assistant), because xAI/Vapi don't see
// each other's agents: without this, an agent created under one engine (e.g. a
// seeded receptionist) simply wouldn't exist on the other after a switch.
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

// Push one saved voice agent into the target engine. Vapi gets the full config
// (the server sanitizes grok-only models/voices); xAI mirrors from the saved
// row server-side. Returns an error string, or null on success.
async function syncAgentTo(p: VoiceProvider, a: AiAgent): Promise<string | null> {
  try {
    if (p === "xai") {
      const r = await fetch("/api/xai/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: a.id }),
      });
      if (r.ok) return null;
      const d = await r.json().catch(() => ({}));
      return d.error ?? "xAI sync failed";
    }
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
    return "engine unreachable";
  }
}

export function VoiceProviderCard() {
  const [provider, setProvider] = useState<VoiceProvider>("xai");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<VoiceProvider | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  useEffect(() => {
    fetchVoiceProvider().then((p) => {
      setProvider(p);
      setLoading(false);
    });
  }, []);

  // Sync every voice agent into the engine that was just selected, so agents
  // like a seeded receptionist exist there without a manual open-and-save each.
  async function syncAllAgents(p: VoiceProvider) {
    const { agents } = await fetchAgents();
    const voice = agents.filter((a) => a.kind === "voice");
    if (voice.length === 0) return;
    const engineName = p === "xai" ? "xAI" : "Vapi";
    const failures: string[] = [];
    let done = 0;
    for (const a of voice) {
      setSyncNote(`Syncing ${a.name} to ${engineName}… (${done + 1}/${voice.length})`);
      const err = await syncAgentTo(p, a);
      if (err) failures.push(`${a.name}: ${err}`);
      done++;
    }
    setSyncNote(null);
    if (failures.length === 0) {
      toast(`${voice.length === 1 ? `${voice[0].name} is` : `All ${voice.length} voice agents are`} now live on ${engineName}.`, "success");
    } else {
      toast(`Engine switched, but some agents didn't sync to ${engineName} — ${failures.join(" · ")}. Open those agents and Save to retry.`, "info");
    }
  }

  async function choose(p: VoiceProvider) {
    if (p === provider || saving) return;
    setSaving(p);
    const res = await saveVoiceProvider(p);
    if (res.ok) {
      setProvider(p);
      toast(res.message, "success");
      await syncAllAgents(p);
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
        engine&apos;s voices and settings, test calls connect to it, and switching automatically pushes your existing
        voice agents into the engine you choose.
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
        Note: phone numbers and outbound phone dialing always run through Vapi for now — xAI doesn&apos;t offer outbound
        calling yet. This switch controls the agent builder and in-browser calls.
      </p>
    </Card>
  );
}
