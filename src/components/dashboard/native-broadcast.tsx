"use client";

import { useCallback, useEffect, useState } from "react";
import { Megaphone, Plus, Send, CalendarClock, Users, Trash2, RefreshCw, Check, AlertTriangle } from "lucide-react";
import { Card, StatusBadge } from "@/components/ui";
import { Modal, Field, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import { fetchFolders, fetchPatients, fetchPatientFolderMap, fetchMessageBroadcasts, deleteMessageBroadcast, type PatientFolder, type MessageBroadcast } from "@/lib/db";

const statusTone: Record<string, "green" | "amber" | "gray" | "red" | "blue"> = {
  Sent: "green", Scheduled: "amber", Sending: "blue", Draft: "gray", Failed: "red",
};

// Native Email/SMS broadcast to the clinic's OWN contact folders. Sends through
// the clinic's connected Gmail/Brevo (email) or Twilio (SMS) — no external list needed.
export function NativeBroadcast({ channel, ws }: { channel: "email" | "sms"; ws: string | null }) {
  const label = channel === "sms" ? "SMS" : "Email";
  const [broadcasts, setBroadcasts] = useState<MessageBroadcast[]>([]);
  const [folders, setFolders] = useState<PatientFolder[]>([]);
  const [folderMap, setFolderMap] = useState<Record<string, string>>({});
  const [allCount, setAllCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    fetchMessageBroadcasts(channel).then((b) => { setBroadcasts(b); setLoading(false); });
    fetchFolders().then(setFolders);
    fetchPatientFolderMap().then(setFolderMap);
    fetchPatients().then((r) => setAllCount(r.patients.length));
  }, [channel]);
  useEffect(() => { load(); }, [load]);

  async function del(b: MessageBroadcast) {
    if (!confirm(`Delete broadcast “${b.name}”?`)) return;
    setBroadcasts((prev) => prev.filter((x) => x.id !== b.id));
    await deleteMessageBroadcast(b.id);
  }

  return (
    <Card className="p-6">
      {open && ws && (
        <BroadcastWizard channel={channel} ws={ws} folders={folders} folderMap={folderMap} allCount={allCount} onClose={() => setOpen(false)} onSent={() => { setOpen(false); load(); }} />
      )}
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-semibold text-ink-900">
          <Megaphone className="h-4 w-4 text-brand-500" /> {label} broadcasts
          <span className="text-xs font-normal text-ink-400">to your contact lists</span>
        </h2>
        <div className="flex items-center gap-2">
          <button onClick={() => { setLoading(true); load(); }} className="rounded-lg border border-ink-200 p-2 text-ink-500 hover:bg-ink-50" title="Refresh"><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /></button>
          <button onClick={() => setOpen(true)} className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700"><Plus className="h-4 w-4" /> New broadcast</button>
        </div>
      </div>

      <p className="mb-4 text-xs text-ink-500">
        Send {label.toLowerCase()} to a whole contact folder from here — through your connected {channel === "sms" ? "Twilio" : "Gmail/Brevo"}. Use <code className="rounded bg-ink-100 px-1">{"{{first_name}}"}</code> to personalise.
      </p>

      {broadcasts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ink-200 px-4 py-8 text-center text-sm text-ink-400">
          {loading ? "Loading…" : `No ${label.toLowerCase()} broadcasts yet — send one to a contact list.`}
        </div>
      ) : (
        <div className="space-y-2">
          {broadcasts.map((b) => (
            <div key={b.id} className="flex items-center justify-between gap-3 rounded-xl border border-ink-100 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink-900">{b.name}</p>
                <p className="truncate text-xs text-ink-400">
                  {b.folderName || "All contacts"}{b.scheduledFor && b.status === "Scheduled" ? ` · ${new Date(b.scheduledFor).toLocaleString()}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-xs text-ink-500">
                {b.status === "Sent" && <span className="hidden sm:inline"><span className="text-emerald-600">{b.sent}</span> sent{b.failed ? <> · <span className="text-rose-500">{b.failed}</span> failed</> : null}</span>}
                <StatusBadge status={b.status} tone={statusTone[b.status] ?? "gray"} />
                <button onClick={() => del(b)} className="rounded-lg p-1 text-ink-400 hover:bg-rose-500/10 hover:text-rose-500" title="Delete"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function BroadcastWizard({
  channel, ws, folders, folderMap, allCount, onClose, onSent,
}: {
  channel: "email" | "sms";
  ws: string;
  folders: PatientFolder[];
  folderMap: Record<string, string>;
  allCount: number;
  onClose: () => void;
  onSent: () => void;
}) {
  const [name, setName] = useState("");
  const [folderId, setFolderId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [when, setWhen] = useState<"now" | "later">("now");
  const [scheduledFor, setScheduledFor] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ sent?: number; failed?: number; recipients?: number; scheduled?: boolean } | null>(null);

  const audience = folderId ? Object.values(folderMap).filter((v) => v === folderId).length : allCount;
  const folderName = folderId ? folders.find((f) => f.id === folderId)?.name ?? "" : "All contacts";

  async function submit() {
    if (!name.trim()) { toast("Name your broadcast.", "info"); return; }
    if (channel === "email" && !subject.trim()) { toast("Add a subject line.", "info"); return; }
    if (!body.trim()) { toast("Write the message.", "info"); return; }
    if (when === "later" && !scheduledFor) { toast("Pick a date & time.", "info"); return; }
    setSending(true);
    try {
      const res = await fetch("/api/broadcasts/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ws, name: name.trim(), channel, folderId: folderId || null, folderName, subject, body, sendNow: when === "now", scheduledFor: when === "later" ? new Date(scheduledFor).toISOString() : null }),
      });
      const d = await res.json();
      if (!d.ok) { toast(d.error ?? "Couldn't send.", "info"); return; }
      setResult({ sent: d.sent, failed: d.failed, recipients: d.recipients, scheduled: d.scheduled });
      onSent();
    } catch {
      toast("Couldn't reach the broadcast service.", "info");
    } finally {
      setSending(false);
    }
  }

  if (result) {
    return (
      <Modal open onClose={onClose} title={`${channel === "sms" ? "SMS" : "Email"} broadcast`} subtitle={name} z="z-[60]">
        <div className="py-4 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-600"><Check className="h-6 w-6" /></div>
          {result.scheduled ? <p className="text-ink-800">Scheduled to <strong>{folderName}</strong>.</p>
            : <p className="text-ink-800"><strong className="text-emerald-600">{result.sent}</strong> sent · <strong className="text-rose-500">{result.failed}</strong> failed · {result.recipients} total.</p>}
          <button onClick={onClose} className="mt-5 rounded-xl bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700">Done</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title={`New ${channel === "sms" ? "SMS" : "email"} broadcast`} subtitle="Send to a contact folder — through your connected provider." z="z-[60]">
      <div className="space-y-4">
        <Field label="Broadcast name"><input className={inputCls} placeholder="June recall push" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Send to">
          <select className={inputCls} value={folderId} onChange={(e) => setFolderId(e.target.value)}>
            <option value="">All contacts ({allCount})</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name} ({Object.values(folderMap).filter((v) => v === f.id).length})</option>)}
          </select>
        </Field>
        <div className="flex items-center gap-2 rounded-xl bg-ink-50 px-4 py-3 text-sm text-ink-600">
          <Users className="h-4 w-4 text-brand-500" /> Reaches up to <strong className="text-ink-900">{audience}</strong> contact(s){channel === "email" ? " with an email" : " with a phone number"}.
        </div>
        {channel === "email" && <Field label="Subject"><input className={inputCls} placeholder="Time for your check-up" value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>}
        <Field label="Message">
          <textarea rows={channel === "sms" ? 4 : 6} maxLength={channel === "sms" ? 640 : undefined} className={inputCls} placeholder={channel === "sms" ? "Hi {{first_name}}! It's time for your cleaning — reply YES to book." : "Hi {{first_name}},\n\nIt's been a while since your last visit…"} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <Field label="When">
          <div className="flex gap-2">
            <button onClick={() => setWhen("now")} className={`flex-1 rounded-xl border px-4 py-2.5 text-sm font-medium ${when === "now" ? "border-brand-400 bg-brand-50 text-brand-600 dark:text-brand-300" : "border-ink-200 text-ink-600"}`}>Send now</button>
            <button onClick={() => setWhen("later")} className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl border px-4 py-2.5 text-sm font-medium ${when === "later" ? "border-brand-400 bg-brand-50 text-brand-600 dark:text-brand-300" : "border-ink-200 text-ink-600"}`}><CalendarClock className="h-4 w-4" /> Schedule</button>
          </div>
        </Field>
        {when === "later" && <Field label="Date & time"><input type="datetime-local" className={inputCls} value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} /></Field>}
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Make sure {channel === "sms" ? "Twilio" : "Gmail or Brevo"} is connected (Settings → Connections). Only contacts with {channel === "sms" ? "a phone number" : "an email"} receive it. Get consent before marketing to patients.
        </div>
      </div>
      <div className="mt-6 flex gap-2 border-t border-ink-100 pt-4">
        <button onClick={onClose} className="flex-1 rounded-xl border border-ink-200 py-2.5 text-sm font-semibold text-ink-700 hover:bg-ink-50">Cancel</button>
        <button onClick={submit} disabled={sending} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
          <Send className="h-4 w-4" /> {sending ? "Working…" : when === "now" ? "Send broadcast" : "Schedule"}
        </button>
      </div>
    </Modal>
  );
}
