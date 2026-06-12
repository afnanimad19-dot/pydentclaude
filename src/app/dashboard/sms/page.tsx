"use client";

import { useState } from "react";
import Link from "next/link";
import { MessageSquareText, CalendarCheck2, Undo2, Plus } from "lucide-react";
import { Card, PageHeader, DemoBanner, StatCard, StatusBadge, Avatar } from "@/components/ui";
import { NewCampaignModal } from "@/components/dashboard/create-modals";
import { broadcasts, conversations } from "@/lib/mock-data";

const templates = [
  { name: "Appointment reminder (T-24h)", body: "Reminder: {{procedure}} tomorrow at {{time}} with {{provider}}. Reply C to confirm or R to reschedule.", usage: "Auto — runs on every scheduled appt" },
  { name: "No-show recovery", body: "We missed you today, {{first_name}}! Want to grab a new time? Book here: {{booking_link}}", usage: "Auto — fires when an appointment is marked broken" },
  { name: "Recall — overdue cleaning", body: "Hi {{first_name}}, it's been {{months_overdue}} months since your last cleaning. We have openings this week — reply YES and we'll find you a time.", usage: "Campaigns" },
  { name: "Balance reminder", body: "Friendly note: you have an open balance of {{balance}}. Pay securely: {{payment_link}} or reply HELP to reach billing.", usage: "Manual / scheduled" },
];

export default function SmsPage() {
  const [modalOpen, setModalOpen] = useState(false);
  const smsConversations = conversations.filter((c) => c.channel === "sms");
  const smsBroadcasts = broadcasts.filter((b) => b.channel === "sms");

  return (
    <>
      <NewCampaignModal open={modalOpen} onClose={() => setModalOpen(false)} channel="SMS" />
      <DemoBanner context="SMS (Twilio) is not connected yet — these are sample texts and templates." />
      <PageHeader
        title="SMS"
        subtitle="Reminders, confirmations and recovery texts patients actually answer."
        actions={
          <button
            onClick={() => setModalOpen(true)}
            className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" /> New text blast
          </button>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard icon={MessageSquareText} label="Texts sent this week" value="312" hint="98.4% delivered" accent="brand" />
        <StatCard icon={CalendarCheck2} label="Confirmations via SMS" value="87" hint="reply rate 76%" accent="green" />
        <StatCard icon={Undo2} label="No-shows recovered" value="11" hint="this month, $4,830 saved" accent="amber" />
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-2">
        <Card className="scroll-mt-20 p-5" id="conversations">
          <h2 className="mb-4 font-semibold text-ink-900">Recent SMS conversations</h2>
          <ul className="space-y-1">
            {smsConversations.map((c) => (
              <li key={c.id}>
                <Link href="/dashboard/inbox" className="flex items-center gap-3 rounded-xl px-2 py-3 hover:bg-ink-50">
                  <Avatar name={c.patientName} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-ink-900">{c.patientName}</p>
                      <span className="text-xs text-ink-400">{c.time}</span>
                    </div>
                    <p className="truncate text-sm text-ink-500">{c.preview}</p>
                  </div>
                  {c.unread > 0 && (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-500 text-[10px] font-semibold text-white">
                      {c.unread}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>

          <h2 className="mb-3 mt-6 font-semibold text-ink-900">SMS campaigns</h2>
          <ul className="space-y-2.5">
            {smsBroadcasts.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 rounded-xl border border-ink-100 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink-900">{b.name}</p>
                  <p className="text-xs text-ink-400">
                    {b.audience}
                    {b.status === "Sent" && ` · ${b.replied} replies · ${b.booked} booked`}
                  </p>
                </div>
                <StatusBadge status={b.status} tone={b.status === "Sent" ? "green" : b.status === "Scheduled" ? "blue" : "gray"} />
              </li>
            ))}
          </ul>
        </Card>

        <Card className="scroll-mt-20 p-5" id="templates">
          <h2 className="mb-1 font-semibold text-ink-900">Message templates</h2>
          <p className="mb-4 text-sm text-ink-500">
            Merge fields pull live from your patient database — names, times, balances, booking links.
          </p>
          <ul className="space-y-3">
            {templates.map((t) => (
              <li key={t.name} className="rounded-xl border border-ink-200 p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-ink-900">{t.name}</p>
                  <span className="shrink-0 rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-600">{t.usage}</span>
                </div>
                <p className="mt-2 rounded-lg bg-ink-50 px-3 py-2 font-mono text-xs leading-relaxed text-ink-600">{t.body}</p>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
