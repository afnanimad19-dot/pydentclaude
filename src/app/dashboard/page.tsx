"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { MessagesSquare, CalendarCheck2, Bot, Users, PhoneIncoming, Inbox } from "lucide-react";
import { Card, PageHeader, StatCard, ChannelBadge, StatusBadge, Avatar } from "@/components/ui";
import {
  fetchWaConversations,
  fetchAppointments,
  fetchPatients,
  fetchVoiceCalls,
  type WaConversation,
  type VoiceCallRecord,
} from "@/lib/db";
import { type Appointment, type Channel, formatDuration } from "@/lib/mock-data";

const aptTone = { Confirmed: "green", Scheduled: "blue", Unconfirmed: "amber", Completed: "gray", Broken: "red" } as const;
const fmtTime = (iso: string) => (iso && iso.length >= 16 ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : iso || "");

export default function DashboardPage() {
  const [convos, setConvos] = useState<WaConversation[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [patientCount, setPatientCount] = useState(0);
  const [calls, setCalls] = useState<VoiceCallRecord[]>([]);
  const [{ today, greeting, dateLabel }] = useState(() => {
    const now = new Date();
    const h = now.getHours();
    return {
      today: now.toISOString().slice(0, 10),
      greeting: h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening",
      dateLabel: now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }),
    };
  });

  useEffect(() => {
    fetchWaConversations().then(setConvos);
    fetchAppointments().then((r) => setAppointments(r.appointments));
    fetchPatients().then((r) => setPatientCount(r.patients.length));
    fetchVoiceCalls().then(setCalls).catch(() => setCalls([]));
  }, []);

  const todayConvos = useMemo(() => convos.filter((c) => (c.lastTime ?? "").slice(0, 10) === today), [convos, today]);
  const needsHuman = useMemo(() => convos.filter((c) => c.unread > 0 || c.status === "human").length, [convos]);
  const upcoming = useMemo(
    () => appointments.filter((a) => a.date >= today && a.status !== "Broken").sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)),
    [appointments, today]
  );
  const apptToday = upcoming.filter((a) => a.date === today).length;
  const recentConvos = useMemo(() => [...convos].sort((a, b) => (b.lastTime ?? "").localeCompare(a.lastTime ?? "")).slice(0, 6), [convos]);

  return (
    <>
      <PageHeader title={`${greeting}`} subtitle={`${dateLabel} — here's your clinic right now.`} />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={MessagesSquare} label="Conversations today" value={String(todayConvos.length)} hint={`${convos.length} total open`} accent="brand" />
        <StatCard icon={CalendarCheck2} label="Appointments today" value={String(apptToday)} hint={`${upcoming.length} upcoming total`} accent="green" />
        <StatCard icon={Bot} label="Needs a human" value={String(needsHuman)} hint="unread or assigned to you" accent="amber" />
        <StatCard icon={Users} label="Patients on file" value={String(patientCount)} hint="total contacts" accent="violet" />
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-3">
        <Card className="p-5 xl:col-span-1">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold text-ink-900">Latest conversations</h2>
            <Link href="/dashboard/inbox" className="text-sm font-medium text-brand-600 hover:text-brand-700">All</Link>
          </div>
          {recentConvos.length === 0 ? (
            <EmptyRow icon={Inbox} text="No conversations yet — they appear here as patients message you." />
          ) : (
            <ul className="space-y-1">
              {recentConvos.map((c) => (
                <li key={c.id}>
                  <Link href="/dashboard/inbox" className="flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-ink-50">
                    <Avatar name={c.contactName} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium text-ink-900">{c.contactName}</p>
                        <ChannelBadge channel={(["whatsapp", "instagram", "messenger", "sms", "email", "voice"].includes(c.channel) ? c.channel : "whatsapp") as Channel} />
                      </div>
                      <p className="truncate text-xs text-ink-500">{c.lastMessage}</p>
                    </div>
                    {c.unread > 0 && <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-[10px] font-semibold text-white">{c.unread}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-5 xl:col-span-1">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold text-ink-900">Upcoming appointments</h2>
            <Link href="/dashboard/calendar" className="text-sm font-medium text-brand-600 hover:text-brand-700">Calendar</Link>
          </div>
          {upcoming.length === 0 ? (
            <EmptyRow icon={CalendarCheck2} text="No upcoming appointments yet." />
          ) : (
            <ul className="space-y-3">
              {upcoming.slice(0, 5).map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 rounded-xl border border-ink-100 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink-900">{a.patientName}</p>
                    <p className="truncate text-xs text-ink-500">{a.procedure} · {a.date} {a.time}{a.provider ? ` · ${a.provider}` : ""}</p>
                  </div>
                  <StatusBadge status={a.status} tone={aptTone[a.status]} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-5 xl:col-span-1">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold text-ink-900">Recent voice calls</h2>
            <Link href="/dashboard/voice" className="text-sm font-medium text-brand-600 hover:text-brand-700">All calls</Link>
          </div>
          {calls.length === 0 ? (
            <EmptyRow icon={PhoneIncoming} text="No calls yet — they appear here once your voice agent takes calls." />
          ) : (
            <ul className="space-y-3">
              {calls.slice(0, 5).map((vc) => (
                <li key={vc.id} className="flex items-center gap-3 rounded-xl border border-ink-100 px-3 py-2.5">
                  <div className="rounded-lg bg-orange-50 p-2 text-orange-600"><PhoneIncoming className="h-4 w-4" /></div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink-900">{vc.callerPhone || vc.agentName}</p>
                    <p className="truncate text-xs text-ink-500">{vc.agentName} · {formatDuration(vc.durationSec)}{vc.startedAt ? ` · ${fmtTime(vc.startedAt)}` : ""}</p>
                  </div>
                  <StatusBadge status={vc.outcome || vc.status} tone={vc.outcome === "Booked" ? "green" : vc.outcome === "Transferred" ? "amber" : "gray"} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function EmptyRow({ icon: Icon, text }: { icon: typeof Inbox; text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-ink-200 px-4 py-8 text-center">
      <Icon className="h-5 w-5 text-ink-300" />
      <p className="text-xs text-ink-400">{text}</p>
    </div>
  );
}
