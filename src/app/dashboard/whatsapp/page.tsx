"use client";

import { useState } from "react";
import {
  MessageCircle,
  Megaphone,
  Workflow,
  Plus,
  Zap,
  MessageSquare,
  GitBranch,
  PlugZap,
  UserRound,
  ChevronDown,
} from "lucide-react";
import { Card, PageHeader, DemoBanner, StatusBadge, Avatar, StatCard } from "@/components/ui";
import { broadcasts, botFlows, conversations, type BotNode } from "@/lib/mock-data";

type Tab = "chats" | "broadcasts" | "bots";

const nodeStyle: Record<BotNode["type"], { icon: typeof Zap; chip: string; label: string }> = {
  trigger: { icon: Zap, chip: "bg-amber-50 text-amber-600", label: "Trigger" },
  message: { icon: MessageSquare, chip: "bg-emerald-50 text-emerald-600", label: "Message" },
  condition: { icon: GitBranch, chip: "bg-blue-50 text-blue-600", label: "Condition" },
  action: { icon: PlugZap, chip: "bg-violet-50 text-violet-600", label: "Action" },
  handoff: { icon: UserRound, chip: "bg-rose-50 text-rose-600", label: "Handoff" },
};

const statusTone = { Sent: "green", Sending: "blue", Scheduled: "blue", Draft: "gray", Live: "green", Paused: "amber" } as const;

export default function WhatsAppPage() {
  const [tab, setTab] = useState<Tab>("chats");
  const waConversations = conversations.filter((c) => c.channel === "whatsapp");

  return (
    <>
      <DemoBanner context="WhatsApp Business is not connected yet — these are sample chats, broadcasts and flows." />
      <PageHeader
        title="WhatsApp"
        subtitle="Two-way chats, broadcast campaigns and automation flows on WhatsApp Business."
        actions={
          <button className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
            <Plus className="h-4 w-4" />
            {tab === "broadcasts" ? "New broadcast" : tab === "bots" ? "New flow" : "New chat"}
          </button>
        }
      />

      <div className="mb-5 flex gap-1 rounded-xl border border-ink-200 bg-white p-1">
        {(
          [
            { key: "chats", label: "Chats", icon: MessageCircle },
            { key: "broadcasts", label: "Broadcasts", icon: Megaphone },
            { key: "bots", label: "Chatbot builder", icon: Workflow },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.key ? "bg-brand-600 text-white" : "text-ink-600 hover:bg-ink-50"
            }`}
          >
            <t.icon className="h-4 w-4" /> {t.label}
          </button>
        ))}
      </div>

      {tab === "chats" && (
        <div className="grid gap-4">
          <div className="grid gap-4 md:grid-cols-3">
            <StatCard icon={MessageCircle} label="Active chats" value="38" hint="last 24 hours" accent="green" />
            <StatCard icon={Zap} label="Bot resolution rate" value="78%" hint="resolved without a human" accent="brand" />
            <StatCard icon={Megaphone} label="Booked from WhatsApp" value="49" hint="this month" accent="violet" />
          </div>
          <Card>
            {waConversations.map((c) => (
              <a
                key={c.id}
                href="/dashboard/inbox"
                className="flex items-center gap-3 border-b border-ink-100 px-5 py-4 last:border-0 hover:bg-ink-50"
              >
                <Avatar name={c.patientName} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-ink-900">{c.patientName}</p>
                    <span className="text-xs text-ink-400">{c.time}</span>
                  </div>
                  <p className="truncate text-sm text-ink-500">{c.preview}</p>
                </div>
                {c.unread > 0 && (
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-[10px] font-semibold text-white">
                    {c.unread}
                  </span>
                )}
              </a>
            ))}
            <p className="px-5 py-3 text-center text-xs text-ink-400">
              All WhatsApp chats also appear in the Omnichannel Inbox.
            </p>
          </Card>
        </div>
      )}

      {tab === "broadcasts" && (
        <Card className="overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink-200 bg-ink-50 text-xs font-semibold uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-5 py-3">Campaign</th>
                <th className="px-4 py-3">Audience</th>
                <th className="px-4 py-3 text-right">Delivered</th>
                <th className="px-4 py-3 text-right">Read</th>
                <th className="px-4 py-3 text-right">Replied</th>
                <th className="px-4 py-3 text-right">Booked</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {broadcasts
                .filter((b) => b.channel === "whatsapp")
                .map((b) => (
                  <tr key={b.id} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/60">
                    <td className="px-5 py-4">
                      <p className="font-medium text-ink-900">{b.name}</p>
                      <p className="text-xs text-ink-400">{b.status === "Sent" ? `Sent ${b.sentAt}` : b.status === "Scheduled" ? `Scheduled for ${b.sentAt}` : "Not sent yet"}</p>
                    </td>
                    <td className="px-4 py-4 text-ink-600">{b.audience}</td>
                    <td className="px-4 py-4 text-right text-ink-800">{b.delivered || "—"}</td>
                    <td className="px-4 py-4 text-right text-ink-800">{b.read || "—"}</td>
                    <td className="px-4 py-4 text-right text-ink-800">{b.replied || "—"}</td>
                    <td className="px-4 py-4 text-right font-semibold text-emerald-600">{b.booked || "—"}</td>
                    <td className="px-4 py-4">
                      <StatusBadge status={b.status} tone={statusTone[b.status]} />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Card>
      )}

      {tab === "bots" && (
        <div className="grid gap-4 lg:grid-cols-3">
          {botFlows.map((flow) => (
            <Card key={flow.id} className="flex flex-col p-5">
              <div className="mb-1 flex items-start justify-between gap-2">
                <h3 className="font-semibold text-ink-900">{flow.name}</h3>
                <StatusBadge status={flow.status} tone={statusTone[flow.status]} />
              </div>
              <p className="mb-4 text-xs text-ink-400">
                {flow.channel.toUpperCase()} · triggered {flow.triggeredToday}× today ·{" "}
                {Math.round(flow.completionRate * 100)}% completion
              </p>
              <div className="flex-1 space-y-0">
                {flow.nodes.map((node, i) => {
                  const s = nodeStyle[node.type];
                  return (
                    <div key={node.id}>
                      <div className="rounded-xl border border-ink-200 bg-white p-3">
                        <div className="flex items-center gap-2">
                          <span className={`rounded-lg p-1.5 ${s.chip}`}>
                            <s.icon className="h-3.5 w-3.5" />
                          </span>
                          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{s.label}</span>
                        </div>
                        <p className="mt-1.5 text-sm font-medium text-ink-900">{node.title}</p>
                        <p className="mt-0.5 text-xs leading-relaxed text-ink-500">{node.detail}</p>
                      </div>
                      {i < flow.nodes.length - 1 && (
                        <div className="flex justify-center py-1 text-ink-300">
                          <ChevronDown className="h-4 w-4" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <button className="mt-4 rounded-xl border border-ink-200 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50">
                Edit flow
              </button>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
