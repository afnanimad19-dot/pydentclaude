"use client";

import { useEffect, useState } from "react";
import {
  Users,
  CalendarClock,
  CircleDollarSign,
  TrendingUp,
  BellRing,
  Bot,
  PhoneCall,
  Megaphone,
} from "lucide-react";
import { Card, PageHeader, DemoBanner, StatCard } from "@/components/ui";
import { ConversationsChart, RevenueChart } from "@/components/dashboard/charts";
import { fetchPatients, fetchAppointments, fetchWaConversations, type DataSource } from "@/lib/db";
import {
  patients as mockPatients,
  appointments as mockAppointments,
  pipeline,
  broadcasts,
  voiceCalls,
  channelMeta,
  formatMoney,
  type Patient,
  type Appointment,
  type Channel,
} from "@/lib/mock-data";

export default function ReportsPage() {
  const [patients, setPatients] = useState<Patient[]>(mockPatients);
  const [appointments, setAppointments] = useState<Appointment[]>(mockAppointments);
  const [source, setSource] = useState<DataSource>("demo");
  const [liveLeadCount, setLiveLeadCount] = useState(0);

  useEffect(() => {
    fetchPatients().then((r) => {
      setPatients(r.patients);
      setSource(r.source);
    });
    fetchAppointments().then((r) => setAppointments(r.appointments));
    fetchWaConversations().then((c) => setLiveLeadCount(c.length));
  }, []);

  const allDeals = pipeline.flatMap((s) => s.deals);
  const pipelineValue = allDeals.reduce((sum, d) => sum + d.value, 0);
  const accepted = pipeline[pipeline.length - 1]?.deals ?? [];
  const acceptedValue = accepted.reduce((sum, d) => sum + d.value, 0);
  const acceptanceRate = allDeals.length ? Math.round((accepted.length / allDeals.length) * 100) : 0;

  // New patients (and pipeline leads) grouped by the channel they came from.
  const bySource = (() => {
    const counts: Record<string, number> = {};
    allDeals.forEach((d) => {
      counts[d.source] = (counts[d.source] ?? 0) + 1;
    });
    // Fold in live WhatsApp leads captured from the inbox.
    if (liveLeadCount) counts.whatsapp = (counts.whatsapp ?? 0) + liveLeadCount;
    const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({ key, count, pct: Math.round((count / total) * 100) }));
  })();

  // Voice-call outcomes for the agent-performance panel.
  const callOutcomes = (() => {
    const counts: Record<string, number> = {};
    voiceCalls.forEach((c) => {
      counts[c.outcome] = (counts[c.outcome] ?? 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  })();

  const newPatients = patients.filter((p) => p.status === "New").length;
  const recallDue = patients.filter((p) => p.recallDue).length;
  const totalBroadcastBooked = broadcasts.reduce((sum, b) => sum + b.booked, 0);

  function sourceColor(key: string): string {
    if (key in channelMeta) return channelMeta[key as Channel].color;
    return "#94a3b8";
  }
  function sourceLabel(key: string): string {
    if (key in channelMeta) return channelMeta[key as Channel].label;
    return key.charAt(0).toUpperCase() + key.slice(1);
  }

  return (
    <>
      {source === "live" ? (
        <div className="mb-6 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-600">
          <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500" />
          <span><strong className="font-semibold">Live database</strong> — patient counts are read from your Supabase project.</span>
        </div>
      ) : (
        <DemoBanner context="Showing analytics over the bundled sample practice — connect your database to report on real patients." />
      )}

      <PageHeader
        title="Reports & analytics"
        subtitle="How your practice and your AI team are performing — patients, production, channels and agents at a glance."
      />

      {/* Headline KPIs */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Users} label="Patients on file" value={String(patients.length)} hint={`${newPatients} new this period`} accent="brand" />
        <StatCard icon={CalendarClock} label="Upcoming appointments" value={String(appointments.length)} hint={`${appointments.filter((a) => a.status === "Unconfirmed").length} unconfirmed`} accent="violet" />
        <StatCard icon={CircleDollarSign} label="Pipeline value" value={formatMoney(pipelineValue)} hint={`${allDeals.length} open opportunities`} accent="green" />
        <StatCard icon={TrendingUp} label="Case acceptance" value={`${acceptanceRate}%`} hint={`${formatMoney(acceptedValue)} accepted`} accent="amber" />
      </div>

      {/* Production */}
      <Card className="mt-6 scroll-mt-20 p-5" id="production">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-ink-900">Production trend</h2>
            <p className="text-sm text-ink-500">Total production vs. revenue booked through Pydental agents.</p>
          </div>
        </div>
        <RevenueChart />
      </Card>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        {/* New patients by source */}
        <Card className="scroll-mt-20 p-5" id="channels">
          <h2 className="font-semibold text-ink-900">New leads by source</h2>
          <p className="mb-4 text-sm text-ink-500">Which channel each new opportunity came in through.</p>
          <div className="space-y-3">
            {bySource.map((s) => (
              <div key={s.key}>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="font-medium text-ink-800">{sourceLabel(s.key)}</span>
                  <span className="text-ink-500">{s.count} · {s.pct}%</span>
                </div>
                <div className="h-2.5 overflow-hidden rounded-full bg-ink-100">
                  <div className="h-full rounded-full" style={{ width: `${s.pct}%`, backgroundColor: sourceColor(s.key) }} />
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Conversation volume */}
        <Card className="p-5">
          <h2 className="font-semibold text-ink-900">Conversation volume</h2>
          <p className="mb-4 text-sm text-ink-500">Messages handled across every channel this week.</p>
          <ConversationsChart />
        </Card>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        {/* AI agent contribution */}
        <Card className="p-5">
          <h2 className="flex items-center gap-2 font-semibold text-ink-900"><Bot className="h-4 w-4 text-brand-500" /> AI contribution</h2>
          <ul className="mt-4 space-y-3 text-sm">
            <li className="flex items-center justify-between"><span className="text-ink-600">Live WhatsApp leads</span><span className="font-semibold text-emerald-600">{liveLeadCount}</span></li>
            <li className="flex items-center justify-between"><span className="text-ink-600">Leads handled by agents</span><span className="font-semibold text-ink-900">{allDeals.filter((d) => d.owner.includes("AI")).length}/{allDeals.length}</span></li>
            <li className="flex items-center justify-between"><span className="text-ink-600">Recall-due patients</span><span className="font-semibold text-ink-900">{recallDue}</span></li>
            <li className="flex items-center justify-between"><span className="text-ink-600">Bookings via broadcasts</span><span className="font-semibold text-ink-900">{totalBroadcastBooked}</span></li>
          </ul>
        </Card>

        {/* Voice outcomes */}
        <Card className="p-5">
          <h2 className="flex items-center gap-2 font-semibold text-ink-900"><PhoneCall className="h-4 w-4 text-orange-500" /> Voice call outcomes</h2>
          <ul className="mt-4 space-y-2.5 text-sm">
            {callOutcomes.map(([outcome, count]) => (
              <li key={outcome} className="flex items-center justify-between">
                <span className="text-ink-600">{outcome}</span>
                <span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs font-semibold text-ink-700">{count}</span>
              </li>
            ))}
          </ul>
        </Card>

        {/* Broadcast performance */}
        <Card className="p-5">
          <h2 className="flex items-center gap-2 font-semibold text-ink-900"><Megaphone className="h-4 w-4 text-brand-500" /> Recent broadcasts</h2>
          <ul className="mt-4 space-y-3 text-sm">
            {broadcasts.filter((b) => b.status === "Sent").slice(0, 4).map((b) => (
              <li key={b.id}>
                <p className="truncate font-medium text-ink-800">{b.name}</p>
                <p className="text-xs text-ink-500">{b.delivered} delivered · {b.replied} replies · {b.booked} booked</p>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="mt-6 flex items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-2.5 text-sm text-amber-600">
        <BellRing className="h-4 w-4 shrink-0" />
        <span>{recallDue} patients are due for recall — run a WhatsApp or SMS broadcast to bring them back in.</span>
      </div>
    </>
  );
}
