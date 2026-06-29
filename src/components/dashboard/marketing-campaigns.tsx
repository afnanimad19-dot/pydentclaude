"use client";

import { useCallback, useEffect, useState } from "react";
import { Megaphone, Plus, RefreshCw, Send, CalendarClock, Check, AlertTriangle, ExternalLink, MousePointerClick, Eye } from "lucide-react";
import { Card } from "@/components/ui";
import { Modal, Field, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";

interface BrevoList { id: number; name: string; subscribers: number }
interface BrevoCampaign { id: number; name: string; subject: string; status: string; scheduledAt: string | null; sent: number; opened: number; clicked: number }
interface BrevoAccount { email: string; companyName: string; emailCredits: number; smsCredits: number; planLabel: string }

const statusTone: Record<string, string> = {
  sent: "bg-emerald-500/15 text-emerald-600",
  inProcess: "bg-sky-500/15 text-sky-600",
  queued: "bg-sky-500/15 text-sky-600",
  scheduled: "bg-amber-500/15 text-amber-700",
  draft: "bg-ink-100 text-ink-500",
  suspended: "bg-rose-500/15 text-rose-600",
};

export function MarketingCampaigns({ type, ws }: { type: "email" | "sms"; ws: string | null }) {
  const label = type === "sms" ? "SMS" : "Email";
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [account, setAccount] = useState<BrevoAccount | null>(null);
  const [lists, setLists] = useState<BrevoList[]>([]);
  const [campaigns, setCampaigns] = useState<BrevoCampaign[]>([]);
  const [warn, setWarn] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // setState lives inside the promise callbacks (not the effect body) so the
  // mount effect stays free of synchronous state updates.
  const load = useCallback(() => {
    if (!ws) return;
    fetch(`/api/campaigns/marketing?ws=${encodeURIComponent(ws)}&type=${type}`)
      .then((r) => r.json())
      .then((d) => {
        setConnected(!!d.connected);
        setAccount(d.account ?? null);
        setLists(d.lists ?? []);
        setCampaigns(d.campaigns ?? []);
        setWarn(d.error ?? null);
      })
      .catch(() => setWarn("Couldn't reach the campaigns service."))
      .finally(() => setLoading(false));
  }, [ws, type]);

  useEffect(() => { load(); }, [load]);

  const credits = type === "sms" ? account?.smsCredits : account?.emailCredits;

  return (
    <Card className="p-6">
      {open && ws && (
        <NewCampaignModal type={type} ws={ws} lists={lists} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); load(); }} />
      )}

      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-semibold text-ink-900">
          <Megaphone className="h-4 w-4 text-brand-500" /> {label} campaigns
          <span className="text-xs font-normal text-ink-400">via Brevo</span>
        </h2>
        <div className="flex items-center gap-2">
          <button onClick={() => { setLoading(true); load(); }} disabled={loading} className="rounded-lg border border-ink-200 p-2 text-ink-500 hover:bg-ink-50 disabled:opacity-50" title="Refresh">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
          {connected && (
            <button onClick={() => setOpen(true)} className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700">
              <Plus className="h-4 w-4" /> New campaign
            </button>
          )}
        </div>
      </div>

      {!connected ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-4 text-sm text-amber-700">
          <p className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4" /> Brevo isn&apos;t connected yet.</p>
          <p className="mt-1.5 text-amber-700/90">
            Connect your clinic&apos;s Brevo account in <a href="/dashboard/settings?tab=connections" className="font-semibold underline">Settings → Connections</a> to send {label.toLowerCase()} campaigns to your contact lists — Brevo bills you directly, nothing routes through us.
          </p>
        </div>
      ) : (
        <>
          {/* account / credits strip */}
          <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-1 font-semibold text-emerald-600"><Check className="h-3.5 w-3.5" /> Connected{account?.companyName ? ` · ${account.companyName}` : ""}</span>
            {typeof credits === "number" && <span className="rounded-full bg-ink-100 px-2.5 py-1 font-medium text-ink-600">{credits.toLocaleString()} {label.toLowerCase()} credits</span>}
            <span className="rounded-full bg-ink-100 px-2.5 py-1 font-medium text-ink-600">{lists.length} contact list{lists.length === 1 ? "" : "s"}</span>
            <a href="https://app.brevo.com" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-300">Open Brevo <ExternalLink className="h-3 w-3" /></a>
          </div>

          {warn && <p className="mb-3 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-600">{warn}</p>}

          {campaigns.length === 0 ? (
            <div className="rounded-xl border border-dashed border-ink-200 px-4 py-8 text-center text-sm text-ink-400">
              {loading ? "Loading campaigns…" : `No ${label.toLowerCase()} campaigns yet — create one to send to a Brevo contact list.`}
            </div>
          ) : (
            <div className="space-y-2">
              {campaigns.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-3 rounded-xl border border-ink-100 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink-900">{c.name || "(untitled)"}</p>
                    <p className="truncate text-xs text-ink-400">{type === "email" ? c.subject : ""}{c.scheduledAt ? `${type === "email" && c.subject ? " · " : ""}${new Date(c.scheduledAt).toLocaleString()}` : ""}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-xs text-ink-500">
                    {c.sent > 0 && <span className="hidden items-center gap-1 sm:flex"><Send className="h-3.5 w-3.5" /> {c.sent.toLocaleString()}</span>}
                    {type === "email" && c.sent > 0 && <span className="hidden items-center gap-1 sm:flex"><Eye className="h-3.5 w-3.5" /> {c.opened.toLocaleString()}</span>}
                    {type === "email" && c.sent > 0 && <span className="hidden items-center gap-1 sm:flex"><MousePointerClick className="h-3.5 w-3.5" /> {c.clicked.toLocaleString()}</span>}
                    <span className={`rounded-full px-2 py-0.5 font-semibold capitalize ${statusTone[c.status] ?? "bg-ink-100 text-ink-500"}`}>{c.status}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function NewCampaignModal({
  type, ws, lists, onClose, onSaved,
}: {
  type: "email" | "sms";
  ws: string;
  lists: BrevoList[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [html, setHtml] = useState("");
  const [smsSender, setSmsSender] = useState("");
  const [content, setContent] = useState("");
  const [listIds, setListIds] = useState<number[]>([]);
  const [when, setWhen] = useState<"now" | "later" | "draft">("now");
  const [scheduledFor, setScheduledFor] = useState("");
  const [saving, setSaving] = useState(false);

  function toggleList(id: number) {
    setListIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  const audience = lists.filter((l) => listIds.includes(l.id)).reduce((n, l) => n + l.subscribers, 0);

  async function submit() {
    if (!name.trim()) { toast("Name your campaign.", "info"); return; }
    if (listIds.length === 0) { toast("Pick at least one contact list.", "info"); return; }
    if (type === "email" && !subject.trim()) { toast("Add a subject line.", "info"); return; }
    if (type === "sms" && !content.trim()) { toast("Write the SMS message.", "info"); return; }
    if (when === "later" && !scheduledFor) { toast("Pick a date & time.", "info"); return; }

    setSaving(true);
    try {
      const res = await fetch("/api/campaigns/marketing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ws, type, name: name.trim(), listIds,
          sendNow: when === "now",
          scheduledAt: when === "later" ? new Date(scheduledFor).toISOString() : null,
          subject, html: html ? `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2937">${html.replace(/\n/g, "<br>")}</div>` : undefined,
          smsSender, content,
        }),
      });
      const d = await res.json();
      toast(d.message, d.ok ? "success" : "info");
      if (d.ok) onSaved();
    } catch {
      toast("Couldn't reach the campaigns service.", "info");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`New ${type === "sms" ? "SMS" : "email"} campaign`} subtitle="Sends through your connected Brevo account." z="z-[60]">
      <div className="space-y-4">
        <Field label="Campaign name"><input className={inputCls} placeholder="June recall reminder" value={name} onChange={(e) => setName(e.target.value)} /></Field>

        {type === "email" ? (
          <>
            <Field label="Subject"><input className={inputCls} placeholder="Time for your check-up" value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
            <Field label="Message"><textarea rows={6} className={inputCls} placeholder={"Hi,\n\nIt's been a while since your last visit…"} value={html} onChange={(e) => setHtml(e.target.value)} /></Field>
          </>
        ) : (
          <>
            <Field label="Sender name (max 11 chars, letters/numbers)"><input className={inputCls} maxLength={11} placeholder="BrightSmile" value={smsSender} onChange={(e) => setSmsSender(e.target.value)} /></Field>
            <Field label="Message"><textarea rows={4} className={inputCls} maxLength={640} placeholder="Hi! It's time for your cleaning — reply YES to book." value={content} onChange={(e) => setContent(e.target.value)} /></Field>
          </>
        )}

        <Field label="Send to (Brevo contact lists)">
          {lists.length === 0 ? (
            <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700">No contact lists in Brevo yet. Create a list and add contacts in Brevo, then refresh.</p>
          ) : (
            <div className="max-h-40 space-y-1.5 overflow-y-auto rounded-xl border border-ink-100 p-2">
              {lists.map((l) => (
                <label key={l.id} className="flex cursor-pointer items-center justify-between rounded-lg px-2 py-1.5 hover:bg-ink-50">
                  <span className="flex items-center gap-2 text-sm text-ink-700">
                    <input type="checkbox" checked={listIds.includes(l.id)} onChange={() => toggleList(l.id)} className="h-4 w-4 rounded border-ink-300 text-brand-600" />
                    {l.name}
                  </span>
                  <span className="text-xs text-ink-400">{l.subscribers.toLocaleString()}</span>
                </label>
              ))}
            </div>
          )}
          {listIds.length > 0 && <p className="mt-1.5 text-xs text-ink-500">~{audience.toLocaleString()} contact(s) selected.</p>}
        </Field>

        <Field label="When">
          <div className="flex gap-2">
            {([["now", "Send now"], ["later", "Schedule"], ["draft", "Save as draft"]] as const).map(([v, lbl]) => (
              <button key={v} onClick={() => setWhen(v)} className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-medium ${when === v ? "border-brand-400 bg-brand-50 text-brand-600 dark:text-brand-300" : "border-ink-200 text-ink-600"}`}>
                {v === "later" && <CalendarClock className="h-4 w-4" />}{lbl}
              </button>
            ))}
          </div>
        </Field>
        {when === "later" && (
          <Field label="Date & time"><input type="datetime-local" className={inputCls} value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} /></Field>
        )}
      </div>

      <div className="mt-6 flex gap-2 border-t border-ink-100 pt-4">
        <button onClick={onClose} className="flex-1 rounded-xl border border-ink-200 py-2.5 text-sm font-semibold text-ink-700 hover:bg-ink-50">Cancel</button>
        <button onClick={submit} disabled={saving} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
          <Send className="h-4 w-4" /> {saving ? "Working…" : when === "now" ? "Send now" : when === "later" ? "Schedule" : "Save draft"}
        </button>
      </div>
    </Modal>
  );
}
