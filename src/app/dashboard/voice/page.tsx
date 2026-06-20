"use client";

import { useCallback, useEffect, useState } from "react";
import { PhoneCall, PhoneIncoming, PhoneOutgoing, CalendarCheck2, Timer, Plus, FileText } from "lucide-react";
import { Card, PageHeader, StatCard, StatusBadge, Avatar } from "@/components/ui";
import { NewAgentModal } from "@/components/dashboard/create-modals";
import { fetchAgents, fetchVoiceCalls, type AiAgent, type VoiceCallRecord } from "@/lib/db";

function fmtDur(s: number) {
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}
function fmtTime(iso: string | null) {
  return iso && iso.length >= 16 ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : iso || "";
}

export default function VoicePage() {
  const [modalOpen, setModalOpen] = useState(false);
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [calls, setCalls] = useState<VoiceCallRecord[]>([]);
  const [activeId, setActiveId] = useState<string>("");

  const refresh = useCallback(() => {
    fetchVoiceCalls().then((cs) => {
      setCalls(cs);
      setActiveId((cur) => cur || cs[0]?.id || "");
    });
  }, []);
  useEffect(() => {
    fetchAgents().then((r) => setAgents(r.agents.filter((a) => a.kind === "voice")));
    refresh();
    const t = setInterval(refresh, 8000); // pick up live calls
    return () => clearInterval(t);
  }, [refresh]);

  const active = calls.find((c) => c.id === activeId);
  const today = new Date().toISOString().slice(0, 10);
  const callsToday = calls.filter((c) => (c.startedAt ?? "").slice(0, 10) === today).length;
  const booked = calls.filter((c) => c.outcome === "Success").length;
  const avg = calls.length ? Math.round(calls.reduce((s, c) => s + c.durationSec, 0) / calls.length) : 0;

  return (
    <>
      <NewAgentModal open={modalOpen} onClose={() => setModalOpen(false)} />
      <PageHeader
        title="Voice Agents"
        subtitle="AI receptionists that answer, book and follow up — every call transcribed, recorded and summarised."
        actions={
          <button onClick={() => setModalOpen(true)} className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
            <Plus className="h-4 w-4" /> New voice agent
          </button>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard icon={PhoneCall} label="Calls today" value={String(callsToday)} hint={`${calls.length} total`} accent="brand" />
        <StatCard icon={CalendarCheck2} label="Successful outcomes" value={String(booked)} hint="booked / resolved" accent="green" />
        <StatCard icon={Timer} label="Avg call duration" value={fmtDur(avg)} hint="across all calls" accent="violet" />
      </div>

      {agents.length > 0 && (
        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          {agents.map((a) => (
            <Card key={a.id} className="p-5">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <Avatar name={a.name} />
                  <div>
                    <p className="font-semibold text-ink-900">{a.name}</p>
                    <p className="text-xs text-ink-400">{a.voice} · {a.purpose}</p>
                  </div>
                </div>
                <StatusBadge status={a.status} tone={a.status === "Live" ? "green" : a.status === "Paused" ? "amber" : "gray"} />
              </div>
              <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-ink-600">{a.instructions || "No script yet."}</p>
            </Card>
          ))}
        </div>
      )}

      <div className="mt-6 grid gap-4 xl:grid-cols-5">
        <Card className="overflow-hidden xl:col-span-3">
          <div className="border-b border-ink-200 px-5 py-4">
            <h2 className="font-semibold text-ink-900">Call log</h2>
          </div>
          {calls.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-ink-400">
              No calls yet. Connect a Vapi assistant + phone number and point its Server URL at <code>/api/vapi/events</code> — calls appear here automatically (see VOICE_AGENT_VAPI.md).
            </p>
          ) : (
            calls.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveId(c.id)}
                className={`flex w-full items-center gap-3 border-b border-ink-100 px-5 py-4 text-left last:border-0 ${c.id === activeId ? "bg-brand-50/60" : "hover:bg-ink-50"}`}
              >
                <div className={`rounded-lg p-2 ${c.direction === "inbound" ? "bg-orange-50 text-orange-600" : "bg-blue-50 text-blue-600"}`}>
                  {c.direction === "inbound" ? <PhoneIncoming className="h-4 w-4" /> : <PhoneOutgoing className="h-4 w-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink-900">{c.callerPhone || "Unknown caller"}</p>
                  <p className="text-xs text-ink-400">{c.agentName || "Agent"} · {fmtTime(c.startedAt)} · {fmtDur(c.durationSec)}</p>
                </div>
                {c.status === "in-progress" ? (
                  <span className="flex items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase text-rose-600">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-500" /> Live
                  </span>
                ) : (
                  <StatusBadge status={c.outcome || "Ended"} tone={c.outcome === "Success" ? "green" : "gray"} />
                )}
              </button>
            ))
          )}
        </Card>

        <Card className="p-5 xl:col-span-2">
          {!active ? (
            <p className="py-10 text-center text-sm text-ink-400">Select a call to see its transcript.</p>
          ) : (
            <>
              <div className="mb-3">
                <h2 className="font-semibold text-ink-900">Call details</h2>
                <p className="text-xs text-ink-400">{active.callerPhone} · {fmtTime(active.startedAt)} · {fmtDur(active.durationSec)}</p>
              </div>
              {active.recordingUrl ? (
                <audio controls src={active.recordingUrl} className="mb-4 w-full" />
              ) : (
                <p className="mb-4 text-xs text-ink-400">{active.status === "in-progress" ? "Call in progress…" : "No recording available."}</p>
              )}
              {active.summary && (
                <div className="mb-4 rounded-xl border border-ink-100 bg-ink-50/60 p-3 text-sm text-ink-700">
                  <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400"><FileText className="h-3.5 w-3.5" /> Summary</p>
                  {active.summary}
                </div>
              )}
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Transcript</p>
              {active.transcript ? (
                <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-xl bg-ink-50 p-3 text-sm leading-relaxed text-ink-800">{active.transcript}</pre>
              ) : (
                <p className="text-sm text-ink-400">{active.status === "in-progress" ? "Transcript appears when the call ends." : "No transcript."}</p>
              )}
              {active.patientId && (
                <a href={`/dashboard/patients/${active.patientId}`} className="mt-4 inline-block rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50">
                  Open caller&apos;s chart →
                </a>
              )}
            </>
          )}
        </Card>
      </div>
    </>
  );
}
