"use client";

import { useEffect, useState } from "react";
import { CreditCard, Users, FileCheck2, Send, Check, AlertTriangle, CalendarClock } from "lucide-react";
import { Modal, Field, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import {
  fetchFolders,
  fetchPatientFolderMap,
  fetchPatients,
  fetchWaTemplates,
  fetchWhatsappConfig,
  createBroadcast,
  type PatientFolder,
  type WaTemplate,
} from "@/lib/db";

const STEPS = ["Before you send", "Audience", "Template", "Schedule"];

export function BroadcastWizard({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [folders, setFolders] = useState<PatientFolder[]>([]);
  const [folderMap, setFolderMap] = useState<Record<string, string>>({});
  const [allCount, setAllCount] = useState(0);
  const [templates, setTemplates] = useState<WaTemplate[]>([]);
  const [connected, setConnected] = useState(false);

  const [name, setName] = useState("");
  const [folderId, setFolderId] = useState<string>(""); // "" = all patients
  const [templateName, setTemplateName] = useState("");
  const [language, setLanguage] = useState("English");
  const [when, setWhen] = useState<"now" | "later">("now");
  const [scheduledFor, setScheduledFor] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ sent?: number; failed?: number; recipients?: number; scheduled?: boolean } | null>(null);

  useEffect(() => {
    fetchFolders().then(setFolders);
    fetchPatientFolderMap().then(setFolderMap);
    fetchPatients().then((r) => setAllCount(r.patients.length));
    fetchWaTemplates().then((r) => setTemplates(r.templates.filter((t) => t.status === "Approved")));
    fetchWhatsappConfig().then((c) => setConnected(c.connected));
  }, []);

  const audienceCount = folderId ? Object.values(folderMap).filter((v) => v === folderId).length : allCount;
  const folderName = folderId ? folders.find((f) => f.id === folderId)?.name ?? "" : "All patients";

  async function sendBroadcast() {
    setSending(true);
    const res = await createBroadcast({
      name: name.trim(),
      folderId: folderId || null,
      folderName,
      templateName,
      language,
      sendNow: when === "now",
      scheduledFor: when === "later" ? scheduledFor : null,
    });
    setSending(false);
    if (!res.ok) {
      toast(`Broadcast failed: ${res.error}`, "info");
      return;
    }
    setResult({ sent: res.sent, failed: res.failed, recipients: res.recipients, scheduled: res.scheduled });
    onDone();
  }

  const canNext =
    (step === 0) ||
    (step === 1 && name.trim().length > 0) ||
    (step === 2 && templateName.length > 0) ||
    step === 3;

  if (result) {
    return (
      <Modal open onClose={onClose} title="Broadcast" subtitle={name}>
        <div className="py-4 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-600">
            <Check className="h-6 w-6" />
          </div>
          {result.scheduled ? (
            <p className="text-ink-800">Scheduled to <strong>{result.recipients}</strong> recipient(s).</p>
          ) : (
            <p className="text-ink-800"><strong className="text-emerald-600">{result.sent}</strong> sent · <strong className="text-rose-500">{result.failed}</strong> failed · {result.recipients} total.</p>
          )}
          <button onClick={onClose} className="mt-5 rounded-xl bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700">Done</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title="New WhatsApp broadcast" subtitle={`Step ${step + 1} of 4 · ${STEPS[step]}`}>
      {/* progress */}
      <div className="mb-5 flex gap-1.5">
        {STEPS.map((s, i) => (
          <div key={s} className={`h-1.5 flex-1 rounded-full ${i <= step ? "bg-brand-600" : "bg-ink-200"}`} />
        ))}
      </div>

      {step === 0 && (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-xl border border-ink-100 p-4">
            <CreditCard className="mt-0.5 h-5 w-5 shrink-0 text-brand-500" />
            <div className="text-sm">
              <p className="font-semibold text-ink-900">Meta charges per conversation</p>
              <p className="mt-0.5 text-ink-500">WhatsApp marketing messages are billed by Meta to the payment method on your WhatsApp Business Account. Add credit in <strong>Meta Business → Billing &amp; payments</strong> before a large send, or messages will fail.</p>
              <a href="https://business.facebook.com/billing_hub/payment_settings" target="_blank" rel="noopener noreferrer" className="mt-1 inline-block font-medium text-brand-600 dark:text-brand-300">Open Meta billing →</a>
            </div>
          </div>
          <div className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm ${connected ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600" : "border-amber-500/30 bg-amber-500/10 text-amber-700"}`}>
            {connected ? <Check className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
            {connected ? "WhatsApp is connected." : "WhatsApp isn't connected — set it up in Settings → WhatsApp config first."}
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          <Field label="Campaign name">
            <input className={inputCls} placeholder="June whitening promo" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Audience">
            <select className={inputCls} value={folderId} onChange={(e) => setFolderId(e.target.value)}>
              <option value="">All patients ({allCount})</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>{f.name} ({Object.values(folderMap).filter((v) => v === f.id).length})</option>
              ))}
            </select>
          </Field>
          <div className="flex items-center gap-2 rounded-xl bg-ink-50 px-4 py-3 text-sm text-ink-600">
            <Users className="h-4 w-4 text-brand-500" /> This broadcast will reach <strong className="text-ink-900">{audienceCount}</strong> patient(s) with a phone number.
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          {templates.length === 0 ? (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-4 text-sm text-amber-700">
              No <strong>approved</strong> templates yet. Create one in WhatsApp → Templates, submit it for approval (a few minutes), then come back.
            </div>
          ) : (
            <div className="max-h-72 space-y-2 overflow-y-auto">
              {templates.map((t) => (
                <button
                  key={t.id}
                  onClick={() => { setTemplateName(t.name); setLanguage(t.language); }}
                  className={`w-full rounded-xl border p-3 text-left transition-colors ${templateName === t.name ? "border-brand-400 bg-brand-50/60" : "border-ink-200 hover:bg-ink-50"}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 font-mono text-sm font-semibold text-ink-900"><FileCheck2 className="h-4 w-4 text-emerald-500" /> {t.name}</span>
                    <span className="text-xs text-ink-400">{t.category} · {t.language}</span>
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-xs text-ink-500">{t.body}</p>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <Field label="When to send">
            <div className="flex gap-2">
              <button onClick={() => setWhen("now")} className={`flex-1 rounded-xl border px-4 py-2.5 text-sm font-medium ${when === "now" ? "border-brand-400 bg-brand-50 text-brand-600 dark:text-brand-300" : "border-ink-200 text-ink-600"}`}>Send now</button>
              <button onClick={() => setWhen("later")} className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl border px-4 py-2.5 text-sm font-medium ${when === "later" ? "border-brand-400 bg-brand-50 text-brand-600 dark:text-brand-300" : "border-ink-200 text-ink-600"}`}><CalendarClock className="h-4 w-4" /> Schedule</button>
            </div>
          </Field>
          {when === "later" && (
            <Field label="Date & time">
              <input type="datetime-local" className={inputCls} value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} />
            </Field>
          )}
          <div className="rounded-xl bg-ink-50 px-4 py-3 text-sm text-ink-600">
            <p>Sending <strong className="text-ink-900">{templateName}</strong> to <strong className="text-ink-900">{audienceCount}</strong> patient(s) in <strong className="text-ink-900">{folderName}</strong>.</p>
          </div>
        </div>
      )}

      {/* footer nav */}
      <div className="mt-6 flex items-center justify-between border-t border-ink-100 pt-4">
        <button onClick={() => (step === 0 ? onClose() : setStep(step - 1))} className="rounded-xl border border-ink-200 px-4 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50">
          {step === 0 ? "Cancel" : "Back"}
        </button>
        {step < 3 ? (
          <button onClick={() => setStep(step + 1)} disabled={!canNext} className="rounded-xl bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">Continue</button>
        ) : (
          <button onClick={sendBroadcast} disabled={sending || !templateName || (when === "later" && !scheduledFor)} className="flex items-center gap-2 rounded-xl bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
            <Send className="h-4 w-4" /> {sending ? "Sending…" : when === "now" ? "Send broadcast" : "Schedule"}
          </button>
        )}
      </div>
    </Modal>
  );
}
