import Link from "next/link";
import {
  MessagesSquare,
  CalendarCheck2,
  Bot,
  Timer,
  ArrowRight,
  PhoneIncoming,
} from "lucide-react";
import { Card, PageHeader, StatCard, ChannelBadge, StatusBadge, DemoBanner, Avatar } from "@/components/ui";
import { ConversationsChart, RevenueChart } from "@/components/dashboard/charts";
import { appointments, conversations, todayStats, voiceCalls, formatDuration } from "@/lib/mock-data";

const aptTone = {
  Confirmed: "green",
  Scheduled: "blue",
  Unconfirmed: "amber",
  Completed: "gray",
  Broken: "red",
} as const;

export default function DashboardPage() {
  return (
    <>
      <DemoBanner context="You're viewing a sample clinic (Bright Smile Dental)." />
      <PageHeader
        title="Good morning, Dana"
        subtitle="Thursday, June 11 — here's how the clinic is talking today."
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={MessagesSquare} label="Conversations today" value={String(todayStats.conversationsHandled)} hint={`${todayStats.byAi} handled by AI`} accent="brand" />
        <StatCard icon={CalendarCheck2} label="Appointments booked" value={String(todayStats.appointmentsBooked)} hint={`${todayStats.noShowsSaved} no-shows recovered`} accent="green" />
        <StatCard icon={Timer} label="Avg first response" value={`${todayStats.avgFirstResponseSec}s`} hint="across all channels" accent="violet" />
        <StatCard icon={Bot} label="Needs a human" value={String(todayStats.openInboxItems)} hint="open items in your inbox" accent="amber" />
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-2">
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold text-ink-900">Conversations this week</h2>
            <Link href="/dashboard/inbox" className="flex items-center gap-1 text-sm font-medium text-brand-600 hover:text-brand-700">
              Open inbox <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <ConversationsChart />
        </Card>
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold text-ink-900">Production booked via Pydent</h2>
            <Link href="/dashboard/pipeline" className="flex items-center gap-1 text-sm font-medium text-brand-600 hover:text-brand-700">
              View pipeline <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <RevenueChart />
        </Card>
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-3">
        <Card className="p-5 xl:col-span-1">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold text-ink-900">Latest conversations</h2>
            <Link href="/dashboard/inbox" className="text-sm font-medium text-brand-600 hover:text-brand-700">All</Link>
          </div>
          <ul className="space-y-1">
            {conversations.slice(0, 5).map((c) => (
              <li key={c.id}>
                <Link href="/dashboard/inbox" className="flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-ink-50">
                  <Avatar name={c.patientName} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-ink-900">{c.patientName}</p>
                      <ChannelBadge channel={c.channel} />
                    </div>
                    <p className="truncate text-xs text-ink-500">{c.preview}</p>
                  </div>
                  {c.unread > 0 && (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-[10px] font-semibold text-white">
                      {c.unread}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-5 xl:col-span-1">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold text-ink-900">Upcoming appointments</h2>
            <Link href="/dashboard/patients" className="text-sm font-medium text-brand-600 hover:text-brand-700">Schedule</Link>
          </div>
          <ul className="space-y-3">
            {appointments.slice(0, 4).map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 rounded-xl border border-ink-100 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink-900">{a.patientName}</p>
                  <p className="truncate text-xs text-ink-500">
                    {a.procedure} · {a.date} {a.time} · {a.provider}
                  </p>
                </div>
                <StatusBadge status={a.status} tone={aptTone[a.status]} />
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-5 xl:col-span-1">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold text-ink-900">Recent voice calls</h2>
            <Link href="/dashboard/voice" className="text-sm font-medium text-brand-600 hover:text-brand-700">All calls</Link>
          </div>
          <ul className="space-y-3">
            {voiceCalls.slice(0, 4).map((vc) => (
              <li key={vc.id} className="flex items-center gap-3 rounded-xl border border-ink-100 px-3 py-2.5">
                <div className="rounded-lg bg-orange-50 p-2 text-orange-600">
                  <PhoneIncoming className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink-900">{vc.patientName}</p>
                  <p className="truncate text-xs text-ink-500">
                    {vc.agentName} · {formatDuration(vc.durationSec)} · {vc.startedAt}
                  </p>
                </div>
                <StatusBadge
                  status={vc.outcome}
                  tone={vc.outcome === "Booked" ? "green" : vc.outcome === "Transferred" ? "amber" : "gray"}
                />
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
