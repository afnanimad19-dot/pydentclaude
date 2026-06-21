"use client";

import { useState } from "react";
import Link from "next/link";
import { Mail, MousePointerClick, CalendarPlus, Plus } from "lucide-react";
import { Card, PageHeader, DemoBanner, StatCard, StatusBadge, Avatar } from "@/components/ui";
import { NewCampaignModal } from "@/components/dashboard/create-modals";
import { emailCampaigns, conversations } from "@/lib/mock-data";

const automations = [
  { name: "Welcome series (new patients)", trigger: "New patient created in Pydent", steps: "3 emails over 7 days", status: "Live" },
  { name: "Treatment plan follow-up", trigger: "Unscheduled treatment plan > 7 days", steps: "2 emails + pipeline task", status: "Live" },
  { name: "Post-visit review request", trigger: "Appointment completed +4 hours", steps: "1 email → Google review link", status: "Live" },
  { name: "Birthday greeting", trigger: "Patient birthdate", steps: "1 email with hygiene offer", status: "Paused" },
];

export default function EmailPage() {
  const [modalOpen, setModalOpen] = useState(false);
  const emailConversations = conversations.filter((c) => c.channel === "email");

  return (
    <>
      <NewCampaignModal open={modalOpen} onClose={() => setModalOpen(false)} channel="Email" />
      <DemoBanner context="Email sending is not connected yet — these are sample campaigns and automations." />
      <PageHeader
        title="Email"
        subtitle="Campaigns and automations measured in bookings, not just opens."
        actions={
          <button
            onClick={() => setModalOpen(true)}
            className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" /> New campaign
          </button>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard icon={Mail} label="Emails sent this month" value="2,560" hint="0.3% bounce rate" accent="violet" />
        <StatCard icon={MousePointerClick} label="Avg open rate" value="42%" hint="industry avg: 28%" accent="brand" />
        <StatCard icon={CalendarPlus} label="Bookings from email" value="29" hint="$11,400 in scheduled production" accent="green" />
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-5">
        <Card className="scroll-mt-20 overflow-hidden xl:col-span-3" id="campaigns">
          <div className="border-b border-ink-200 px-5 py-4">
            <h2 className="font-semibold text-ink-900">Campaigns</h2>
          </div>
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink-200 bg-ink-50 text-xs font-semibold uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-5 py-3">Campaign</th>
                <th className="px-4 py-3 text-right">Open</th>
                <th className="px-4 py-3 text-right">Click</th>
                <th className="px-4 py-3 text-right">Booked</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {emailCampaigns.map((c) => (
                <tr key={c.id} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/60">
                  <td className="px-5 py-4">
                    <p className="font-medium text-ink-900">{c.name}</p>
                    <p className="text-xs text-ink-400">“{c.subject}” · {c.audience}</p>
                  </td>
                  <td className="px-4 py-4 text-right text-ink-800">{c.openRate ? `${Math.round(c.openRate * 100)}%` : "—"}</td>
                  <td className="px-4 py-4 text-right text-ink-800">{c.clickRate ? `${(c.clickRate * 100).toFixed(1)}%` : "—"}</td>
                  <td className="px-4 py-4 text-right font-semibold text-emerald-600">{c.bookings || "—"}</td>
                  <td className="px-4 py-4">
                    <StatusBadge status={c.status} tone={c.status === "Sent" ? "green" : c.status === "Scheduled" ? "blue" : "gray"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <div className="space-y-4 xl:col-span-2">
          <Card className="scroll-mt-20 p-5" id="automations">
            <h2 className="mb-4 font-semibold text-ink-900">Automations</h2>
            <ul className="space-y-3">
              {automations.map((a) => (
                <li key={a.name} className="rounded-xl border border-ink-200 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-ink-900">{a.name}</p>
                    <StatusBadge status={a.status} tone={a.status === "Live" ? "green" : "amber"} />
                  </div>
                  <p className="mt-1.5 text-xs text-ink-500">
                    <span className="font-medium text-ink-600">When:</span> {a.trigger}
                  </p>
                  <p className="text-xs text-ink-500">
                    <span className="font-medium text-ink-600">Then:</span> {a.steps}
                  </p>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 font-semibold text-ink-900">Recent email threads</h2>
            <ul className="space-y-1">
              {emailConversations.map((c) => (
                <li key={c.id}>
                  <Link href="/dashboard/inbox" className="flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-ink-50">
                    <Avatar name={c.patientName} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink-900">{c.patientName}</p>
                      <p className="truncate text-xs text-ink-500">{c.preview}</p>
                    </div>
                    <span className="text-xs text-ink-400">{c.time}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
