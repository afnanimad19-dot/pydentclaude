"use client";

import { useState } from "react";
import {
  PhoneCall,
  PhoneIncoming,
  PhoneOutgoing,
  CalendarCheck2,
  Timer,
  Plus,
  Play,
  Smile,
  Meh,
  Frown,
} from "lucide-react";
import { Card, PageHeader, DemoBanner, StatCard, StatusBadge, Avatar } from "@/components/ui";
import { voiceAgents, voiceCalls, formatDuration } from "@/lib/mock-data";

const sentimentIcon = {
  positive: { icon: Smile, cls: "text-emerald-500" },
  neutral: { icon: Meh, cls: "text-ink-400" },
  negative: { icon: Frown, cls: "text-rose-500" },
} as const;

const outcomeTone = {
  Booked: "green",
  Rescheduled: "blue",
  "Question answered": "blue",
  Voicemail: "gray",
  Transferred: "amber",
  Missed: "red",
} as const;

export default function VoicePage() {
  const [activeCallId, setActiveCallId] = useState(voiceCalls[0].id);
  const activeCall = voiceCalls.find((c) => c.id === activeCallId) ?? voiceCalls[0];

  return (
    <>
      <DemoBanner context="Voice agents (Retell AI) are not connected to a phone line yet — these are sample calls." />
      <PageHeader
        title="Voice Agents"
        subtitle="AI receptionists that answer, book and follow up — every call transcribed and summarized."
        actions={
          <button className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
            <Plus className="h-4 w-4" /> New agent
          </button>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard icon={PhoneCall} label="Calls handled today" value="64" hint="0 missed during office hours" accent="brand" />
        <StatCard icon={CalendarCheck2} label="Booked by voice agents" value="19" hint="this week" accent="green" />
        <StatCard icon={Timer} label="Avg call duration" value="2m 28s" hint="across all agents" accent="violet" />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        {voiceAgents.map((a) => (
          <Card key={a.id} className="p-5">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <Avatar name={a.name} />
                <div>
                  <p className="font-semibold text-ink-900">{a.name}</p>
                  <p className="text-xs text-ink-400">{a.phoneNumber}</p>
                </div>
              </div>
              <StatusBadge status={a.status} tone={a.status === "Live" ? "green" : a.status === "Paused" ? "amber" : "gray"} />
            </div>
            <p className="mt-3 text-sm leading-relaxed text-ink-600">{a.role}</p>
            <p className="mt-2 text-xs text-ink-400">{a.voice} · {a.language}</p>
            <div className="mt-4 grid grid-cols-3 gap-2 border-t border-ink-100 pt-4 text-center">
              <div>
                <p className="text-lg font-semibold text-ink-900">{a.callsToday}</p>
                <p className="text-[11px] text-ink-400">calls today</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-ink-900">{formatDuration(a.avgDurationSec)}</p>
                <p className="text-[11px] text-ink-400">avg duration</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-ink-900">{a.bookingRate ? `${Math.round(a.bookingRate * 100)}%` : "—"}</p>
                <p className="text-[11px] text-ink-400">booking rate</p>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-5">
        <Card className="overflow-hidden xl:col-span-3">
          <div className="border-b border-ink-200 px-5 py-4">
            <h2 className="font-semibold text-ink-900">Call log</h2>
          </div>
          {voiceCalls.map((c) => {
            const S = sentimentIcon[c.sentiment];
            return (
              <button
                key={c.id}
                onClick={() => setActiveCallId(c.id)}
                className={`flex w-full items-center gap-3 border-b border-ink-100 px-5 py-4 text-left last:border-0 ${
                  c.id === activeCall.id ? "bg-brand-50/60" : "hover:bg-ink-50"
                }`}
              >
                <div className={`rounded-lg p-2 ${c.direction === "inbound" ? "bg-orange-50 text-orange-600" : "bg-blue-50 text-blue-600"}`}>
                  {c.direction === "inbound" ? <PhoneIncoming className="h-4 w-4" /> : <PhoneOutgoing className="h-4 w-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-ink-900">{c.patientName}</p>
                    <S.icon className={`h-4 w-4 ${S.cls}`} />
                  </div>
                  <p className="text-xs text-ink-400">
                    {c.agentName} · {c.startedAt} · {formatDuration(c.durationSec)}
                  </p>
                </div>
                <StatusBadge status={c.outcome} tone={outcomeTone[c.outcome]} />
              </button>
            );
          })}
        </Card>

        <Card className="p-5 xl:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-ink-900">Transcript</h2>
              <p className="text-xs text-ink-400">
                {activeCall.patientName} · {activeCall.phone} · {formatDuration(activeCall.durationSec)}
              </p>
            </div>
            <button className="flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50">
              <Play className="h-3.5 w-3.5" /> Play recording
            </button>
          </div>
          <div className="space-y-3">
            {activeCall.transcript.map((line, i) => (
              <div key={i} className={`flex ${line.speaker === "agent" ? "justify-start" : "justify-end"}`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                    line.speaker === "agent"
                      ? "rounded-bl-sm bg-brand-50 text-brand-900"
                      : "rounded-br-sm bg-ink-100 text-ink-800"
                  }`}
                >
                  <p className="mb-0.5 text-[11px] font-semibold text-ink-400">
                    {line.speaker === "agent" ? activeCall.agentName + " (AI)" : activeCall.patientName}
                  </p>
                  {line.text}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
