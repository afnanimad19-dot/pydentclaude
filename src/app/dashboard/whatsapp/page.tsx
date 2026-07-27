"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MessageCircle, Megaphone, Plus, Zap } from "lucide-react";
import { Card, PageHeader, StatusBadge, Avatar, StatCard } from "@/components/ui";
import { Modal } from "@/components/modal";
import { BroadcastWizard } from "@/components/dashboard/broadcast-wizard";
import { fetchWaBroadcasts, fetchWaBroadcastRecipients, fetchWaConversations, fetchWaStats, type WaBroadcast, type WaBroadcastRecipient, type WaConversation, type WaStats } from "@/lib/db";

type Tab = "chats" | "broadcasts";

const statusTone = { Sent: "green", Sending: "blue", Scheduled: "blue", Draft: "gray", Live: "green", Paused: "amber", Failed: "red" } as const;

export default function WhatsAppPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlTab = searchParams.get("tab");
  // URL is the source of truth so sidebar sub-links and tab buttons stay in sync
  const tab: Tab = urlTab === "broadcasts" ? "broadcasts" : "chats";
  const setTab = (t: Tab) => router.replace(`/dashboard/whatsapp?tab=${t}`, { scroll: false });
  const [wizardOpen, setWizardOpen] = useState(false);
  const [liveBroadcasts, setLiveBroadcasts] = useState<WaBroadcast[]>([]);
  const [selectedLive, setSelectedLive] = useState<WaBroadcast | null>(null);
  const [chats, setChats] = useState<WaConversation[]>([]);
  const [stats, setStats] = useState<WaStats>({ chats: 0, botReplies30d: 0, booked30d: 0 });

  const loadLive = useCallback(() => {
    fetchWaBroadcasts().then(setLiveBroadcasts);
    fetchWaConversations().then((all) => setChats(all.filter((c) => c.channel === "whatsapp")));
    fetchWaStats().then(setStats);
  }, []);
  useEffect(() => {
    loadLive();
    const t = setInterval(loadLive, 10000);
    return () => clearInterval(t);
  }, [loadLive]);

  return (
    <>
      {wizardOpen && <BroadcastWizard onClose={() => setWizardOpen(false)} onDone={loadLive} />}
      {selectedLive && <LiveBroadcastDetail broadcast={selectedLive} onClose={() => setSelectedLive(null)} />}
      <PageHeader
        title="WhatsApp"
        subtitle="Two-way chats, broadcast campaigns and automation flows on WhatsApp Business."
        actions={
          <button
            onClick={() => { setTab("broadcasts"); setWizardOpen(true); }}
            className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" /> New broadcast
          </button>
        }
      />

      <div className="mb-5 flex gap-1 rounded-xl border border-ink-200 bg-surface p-1">
        {(
          [
            { key: "chats", label: "Chats", icon: MessageCircle },
            { key: "broadcasts", label: "Broadcasts", icon: Megaphone },
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
            <StatCard icon={MessageCircle} label="Active chats" value={String(stats.chats)} hint="in the inbox" accent="green" />
            <StatCard icon={Zap} label="AI auto-replies" value={String(stats.botReplies30d)} hint="last 30 days" accent="brand" />
            <StatCard icon={Megaphone} label="Booked from WhatsApp" value={String(stats.booked30d)} hint="last 30 days" accent="violet" />
          </div>
          <Card>
            {chats.length === 0 && (
              <p className="px-5 py-8 text-center text-sm text-ink-400">No WhatsApp chats yet — they appear here the moment a patient messages your number.</p>
            )}
            {chats.map((c) => (
              <a
                key={c.id}
                href="/dashboard/inbox"
                className="flex items-center gap-3 border-b border-ink-100 px-5 py-4 last:border-0 hover:bg-ink-50"
              >
                <Avatar name={c.contactName} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-ink-900">{c.contactName}</p>
                    <span className="text-xs text-ink-400">{(c.lastTime ?? "").slice(0, 16).replace("T", " ")}</span>
                  </div>
                  <p className="truncate text-sm text-ink-500">{c.lastMessage}</p>
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
            </tbody>
          </table>
        </Card>
      )}

    </>
  );
}


function LiveBroadcastDetail({ broadcast: b, onClose }: { broadcast: WaBroadcast; onClose: () => void }) {
  const [recipients, setRecipients] = useState<WaBroadcastRecipient[]>([]);
  useEffect(() => {
    const load = () => fetchWaBroadcastRecipients(b.id).then(setRecipients);
    load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [b.id]);

  // Compute the funnel from per-recipient status so delivered/read update live.
  const stats = recipients.reduce(
    (a, r) => {
      if (r.status === "failed") a.failed++;
      else {
        a.sent++;
        if (r.status === "delivered" || r.status === "read") a.delivered++;
        if (r.status === "read") a.read++;
      }
      return a;
    },
    { sent: 0, delivered: 0, read: 0, failed: 0 }
  );
  const totals = recipients.length ? { recipients: recipients.length, ...stats } : { recipients: b.recipients, sent: b.sent, delivered: b.delivered, read: b.read, failed: b.failed };
  const base = Math.max(totals.recipients, 1);
  const pct = (n: number) => Math.round((n / base) * 100);
  const funnel = [
    { label: "Recipients", value: totals.recipients, color: "bg-ink-400" },
    { label: "Sent", value: totals.sent, color: "bg-blue-500" },
    { label: "Delivered", value: totals.delivered, color: "bg-violet-500" },
    { label: "Read", value: totals.read, color: "bg-emerald-500" },
    { label: "Failed", value: totals.failed, color: "bg-rose-500" },
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
