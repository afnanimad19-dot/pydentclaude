"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
import { Modal } from "@/components/modal";
import { NewCampaignModal } from "@/components/dashboard/create-modals";
import { BroadcastWizard } from "@/components/dashboard/broadcast-wizard";
import { fetchWaBroadcasts, fetchWaBroadcastRecipients, type WaBroadcast, type WaBroadcastRecipient } from "@/lib/db";
import { broadcasts, botFlows, conversations, type BotNode, type Broadcast } from "@/lib/mock-data";

type Tab = "chats" | "broadcasts" | "bots";

const nodeStyle: Record<BotNode["type"], { icon: typeof Zap; chip: string; label: string }> = {
  trigger: { icon: Zap, chip: "bg-amber-500/15 text-amber-600", label: "Trigger" },
  message: { icon: MessageSquare, chip: "bg-emerald-500/15 text-emerald-600", label: "Message" },
  condition: { icon: GitBranch, chip: "bg-blue-500/15 text-blue-600", label: "Condition" },
  action: { icon: PlugZap, chip: "bg-violet-500/15 text-violet-600", label: "Action" },
  handoff: { icon: UserRound, chip: "bg-rose-500/15 text-rose-600", label: "Handoff" },
};

const statusTone = { Sent: "green", Sending: "blue", Scheduled: "blue", Draft: "gray", Live: "green", Paused: "amber", Failed: "red" } as const;

export default function WhatsAppPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlTab = searchParams.get("tab");
  // URL is the source of truth so sidebar sub-links and tab buttons stay in sync
  const tab: Tab = urlTab === "broadcasts" || urlTab === "bots" ? urlTab : "chats";
  const setTab = (t: Tab) => router.replace(`/dashboard/whatsapp?tab=${t}`, { scroll: false });
  const [modalOpen, setModalOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [selected, setSelected] = useState<Broadcast | null>(null);
  const [liveBroadcasts, setLiveBroadcasts] = useState<WaBroadcast[]>([]);
  const [selectedLive, setSelectedLive] = useState<WaBroadcast | null>(null);
  const waConversations = conversations.filter((c) => c.channel === "whatsapp");

  const loadLive = useCallback(() => { fetchWaBroadcasts().then(setLiveBroadcasts); }, []);
  useEffect(() => { loadLive(); }, [loadLive]);

  return (
    <>
      {wizardOpen && <BroadcastWizard onClose={() => setWizardOpen(false)} onDone={loadLive} />}
      {selected && <BroadcastDetail broadcast={selected} onClose={() => setSelected(null)} />}
      {selectedLive && <LiveBroadcastDetail broadcast={selectedLive} onClose={() => setSelectedLive(null)} />}
      <NewCampaignModal open={modalOpen} onClose={() => setModalOpen(false)} channel="WhatsApp" />
      <DemoBanner context="WhatsApp Business is not connected yet — these are sample chats, broadcasts and flows." />
      <PageHeader
        title="WhatsApp"
        subtitle="Two-way chats, broadcast campaigns and automation flows on WhatsApp Business."
        actions={
          <button
            onClick={() => (tab === "bots" ? router.push("/dashboard/workflows") : tab === "broadcasts" ? setWizardOpen(true) : setModalOpen(true))}
            className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" />
            {tab === "broadcasts" ? "New broadcast" : tab === "bots" ? "New flow" : "New campaign"}
          </button>
        }
      />

      <div className="mb-5 flex gap-1 rounded-xl border border-ink-200 bg-surface p-1">
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
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {liveBroadcasts.map((b) => (
                <tr key={b.id} onClick={() => setSelectedLive(b)} className="cursor-pointer border-b border-ink-100 last:border-0 hover:bg-ink-50/60">
                  <td className="px-5 py-4">
                    <p className="flex items-center gap-1.5 font-medium text-ink-900">{b.name} <span className="rounded bg-emerald-500/15 px-1 text-[9px] font-semibold uppercase text-emerald-600">live</span></p>
                    <p className="text-xs text-ink-400">{b.status === "Sent" ? `Sent ${(b.sentAt ?? "").slice(0, 16).replace("T", " ")}` : b.status === "Scheduled" ? `Scheduled ${(b.scheduledFor ?? "").slice(0, 16).replace("T", " ")}` : b.status} · {b.templateName}</p>
                  </td>
                  <td className="px-4 py-4 text-ink-600">{b.folderName || "All patients"}</td>
                  <td className="px-4 py-4 text-right text-ink-800">{b.sent || "—"}</td>
                  <td className="px-4 py-4 text-right text-ink-800">{b.read || "—"}</td>
                  <td className="px-4 py-4 text-right text-rose-500">{b.failed || "—"}</td>
                  <td className="px-4 py-4 text-right font-semibold text-ink-800">{b.recipients}</td>
                  <td className="px-4 py-4"><StatusBadge status={b.status} tone={statusTone[b.status]} /></td>
                  <td className="px-4 py-4 text-right"><span className="text-xs font-medium text-brand-600 dark:text-brand-300">View →</span></td>
                </tr>
              ))}
              {broadcasts
                .filter((b) => b.channel === "whatsapp")
                .map((b) => (
                  <tr
                    key={b.id}
                    onClick={() => setSelected(b)}
                    className="cursor-pointer border-b border-ink-100 last:border-0 hover:bg-ink-50/60"
                  >
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
                    <td className="px-4 py-4 text-right">
                      <span className="text-xs font-medium text-brand-600 dark:text-brand-300">View →</span>
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
                      <div className="rounded-xl border border-ink-200 bg-surface p-3">
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
              <button
                onClick={() => router.push("/dashboard/workflows")}
                className="mt-4 rounded-xl border border-ink-200 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
              >
                Open in Workflows
              </button>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

function BroadcastDetail({ broadcast: b, onClose }: { broadcast: Broadcast; onClose: () => void }) {
  const base = Math.max(b.recipients, 1);
  const pct = (n: number) => Math.round((n / base) * 100);
  const funnel = [
    { label: "Recipients", value: b.recipients, color: "bg-ink-400" },
    { label: "Delivered", value: b.delivered, color: "bg-blue-500" },
    { label: "Read", value: b.read, color: "bg-violet-500" },
    { label: "Replied", value: b.replied, color: "bg-amber-500" },
    { label: "Booked", value: b.booked, color: "bg-emerald-500" },
  ];

  return (
    <Modal open onClose={onClose} title={b.name} subtitle={`${b.audience} · ${b.channel.toUpperCase()}`}>
      <div className="grid gap-5">
        {/* Status + timing */}
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={b.status} tone={statusTone[b.status]} />
          <span className="text-sm text-ink-500">
            {b.status === "Sent" ? `Sent ${b.sentAt}` : b.status === "Scheduled" ? `Scheduled for ${b.sentAt}` : "Not sent yet"}
          </span>
        </div>

        {/* Headline numbers */}
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-xl border border-ink-100 px-4 py-3">
            <p className="text-xs text-ink-400">Delivery rate</p>
            <p className="mt-1 text-2xl font-semibold text-ink-900">{pct(b.delivered)}%</p>
          </div>
          <div className="rounded-xl border border-ink-100 px-4 py-3">
            <p className="text-xs text-ink-400">Read rate</p>
            <p className="mt-1 text-2xl font-semibold text-ink-900">{pct(b.read)}%</p>
          </div>
          <div className="rounded-xl border border-ink-100 px-4 py-3">
            <p className="text-xs text-ink-400">Booked</p>
            <p className="mt-1 text-2xl font-semibold text-emerald-600">{b.booked}</p>
          </div>
        </div>

        {/* Funnel */}
        <div>
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-400">Delivery funnel</p>
          <div className="space-y-2.5">
            {funnel.map((f) => (
              <div key={f.label}>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="font-medium text-ink-800">{f.label}</span>
                  <span className="text-ink-500">{f.value.toLocaleString()} · {pct(f.value)}%</span>
                </div>
                <div className="h-2.5 overflow-hidden rounded-full bg-ink-100">
                  <div className={`h-full rounded-full ${f.color}`} style={{ width: `${pct(f.value)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Template that was sent */}
        <div className="rounded-xl border border-ink-200 bg-ink-50/60 p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Template sent</p>
            <code className="rounded-md bg-surface px-2 py-0.5 font-mono text-xs text-ink-600">{b.template}</code>
          </div>
          <p className="mt-2.5 rounded-lg bg-surface p-3 text-sm leading-relaxed text-ink-800">{b.message}</p>
        </div>
      </div>
    </Modal>
  );
}

function LiveBroadcastDetail({ broadcast: b, onClose }: { broadcast: WaBroadcast; onClose: () => void }) {
  const [recipients, setRecipients] = useState<WaBroadcastRecipient[]>([]);
  useEffect(() => { fetchWaBroadcastRecipients(b.id).then(setRecipients); }, [b.id]);

  const base = Math.max(b.recipients, 1);
  const pct = (n: number) => Math.round((n / base) * 100);
  const funnel = [
    { label: "Recipients", value: b.recipients, color: "bg-ink-400" },
    { label: "Sent", value: b.sent, color: "bg-blue-500" },
    { label: "Delivered", value: b.delivered, color: "bg-violet-500" },
    { label: "Read", value: b.read, color: "bg-emerald-500" },
    { label: "Failed", value: b.failed, color: "bg-rose-500" },
  ];

  return (
    <Modal open onClose={onClose} title={b.name} subtitle={`${b.folderName || "All patients"} · template ${b.templateName}`}>
      <div className="grid gap-5">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={b.status} tone={statusTone[b.status]} />
          <span className="text-sm text-ink-500">
            {b.status === "Sent" ? `Sent ${(b.sentAt ?? "").slice(0, 16).replace("T", " ")}` : b.status === "Scheduled" ? `Scheduled for ${(b.scheduledFor ?? "").slice(0, 16).replace("T", " ")}` : b.status}
          </span>
        </div>

        <div>
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-400">Delivery funnel</p>
          <div className="space-y-2.5">
            {funnel.map((f) => (
              <div key={f.label}>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="font-medium text-ink-800">{f.label}</span>
                  <span className="text-ink-500">{f.value.toLocaleString()} · {pct(f.value)}%</span>
                </div>
                <div className="h-2.5 overflow-hidden rounded-full bg-ink-100">
                  <div className={`h-full rounded-full ${f.color}`} style={{ width: `${pct(f.value)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Recipients</p>
          <div className="max-h-56 divide-y divide-ink-100 overflow-y-auto rounded-xl border border-ink-100">
            {recipients.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-ink-400">No per-recipient records.</p>
            ) : (
              recipients.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium text-ink-900">{r.name || `+${r.phone}`}</span>
                    {r.error && <span className="ml-2 text-xs text-rose-500">{r.error}</span>}
                  </span>
                  <StatusBadge status={r.status} tone={r.status === "failed" ? "red" : r.status === "read" ? "green" : "blue"} />
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
