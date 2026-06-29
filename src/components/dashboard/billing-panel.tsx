"use client";

import { useEffect, useState } from "react";
import { Clock, Plus, Minus, Settings2, Zap, CreditCard, ShieldCheck, Database, Users, Download, X, Activity, Info, MoreVertical } from "lucide-react";
import { Card } from "@/components/ui";
import { Modal, ModalFooter, Field, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import { fetchBilling, saveAutoRecharge, fetchVoiceCalls, type BillingSettings, type BillingInvoice, type VoiceCallRecord } from "@/lib/db";

function money(n: number) { return `$${n.toFixed(2)}`; }
function mins(n: number) { const m = Math.floor(n); const s = Math.round((n - m) * 60); return `${m}:${String(s).padStart(2, "0")}`; }
function fmtDate(iso: string | null) { if (!iso) return "—"; const d = new Date(iso); return isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
function durLabel(sec: number) { const m = Math.floor(sec / 60); const s = sec % 60; if (m && s) return `${m} minute${m > 1 ? "s" : ""} ${s} second${s !== 1 ? "s" : ""}`; if (m) return `${m} minute${m > 1 ? "s" : ""}`; return `${s} second${s !== 1 ? "s" : ""}`; }
function ago(iso: string | null) { if (!iso) return ""; const diff = Date.now() - new Date(iso).getTime(); if (isNaN(diff)) return ""; const d = Math.floor(diff / 86400000); if (d >= 1) return `${d} day${d > 1 ? "s" : ""} ago`; const h = Math.floor(diff / 3600000); if (h >= 1) return `${h} hour${h > 1 ? "s" : ""} ago`; const mn = Math.floor(diff / 60000); return mn >= 1 ? `${mn} min ago` : "just now"; }

type HistoryTab = "billing" | "usage" | "minutes";
const USAGE_PER_PAGE = 10;

export function BillingPanel() {
  const [s, setS] = useState<BillingSettings | null>(null);
  const [invoices, setInvoices] = useState<BillingInvoice[]>([]);
  const [usage, setUsage] = useState<VoiceCallRecord[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [rechargeOpen, setRechargeOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [histTab, setHistTab] = useState<HistoryTab>("billing");
  const [usagePage, setUsagePage] = useState(1);

  function refresh() {
    fetchBilling().then((r) => { setS(r.settings); setInvoices(r.invoices); });
    fetchVoiceCalls().then((calls) => setUsage(calls.filter((c) => c.durationSec > 0)));
  }
  useEffect(() => { refresh(); }, []);

  if (!s) return <Card className="p-10 text-center text-sm text-ink-400">Loading billing…</Card>;

  const pct = s.minutesIncluded > 0 ? Math.min(100, Math.round((s.minutesBalance / s.minutesIncluded) * 100)) : 0;

  return (
    <div className="space-y-6">
      {addOpen && <AddMinutesDrawer settings={s} onClose={() => setAddOpen(false)} />}
      {rechargeOpen && <AutoRechargeModal settings={s} onClose={() => setRechargeOpen(false)} onSaved={() => { setRechargeOpen(false); refresh(); }} />}
      {manageOpen && <ManagePaymentDrawer settings={s} onClose={() => setManageOpen(false)} />}

      {/* Minutes balance */}
      <Card className="p-6">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-brand-500/15 p-2.5 text-brand-600"><Clock className="h-5 w-5" /></div>
            <div>
              <p className="font-semibold text-ink-900">Minutes Balance</p>
              <p className="text-xs text-ink-400">Available calling minutes</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold text-ink-900">{mins(s.minutesBalance)}</p>
            <p className="text-xs text-ink-400">of {s.minutesIncluded} minutes</p>
          </div>
        </div>
        <div className="mt-4 h-2.5 w-full overflow-hidden rounded-full bg-ink-100">
          <div className="h-full rounded-full bg-brand-600" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1 text-xs text-ink-400">{pct}% remaining</p>
        <div className="mt-4 flex items-center justify-between">
          <button onClick={() => setRechargeOpen(true)} className="flex items-center gap-2 rounded-xl border border-ink-200 px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"><Settings2 className="h-4 w-4" /> Auto-recharge</button>
          <button onClick={() => setAddOpen(true)} className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"><Plus className="h-4 w-4" /> Add Minutes</button>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Subscription plan */}
        <Card className="p-6">
          <div className="mb-4 flex items-start justify-between">
            <div>
              <p className="font-semibold text-ink-900">{s.planName}</p>
              <p className="text-xs text-ink-400">Your subscription details and plan information</p>
            </div>
            <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-semibold text-emerald-600">Active</span>
          </div>
          <div className="rounded-xl border border-ink-100 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">Monthly price</p>
                <p className="text-2xl font-bold text-ink-900">{money(s.monthlyPrice)}</p>
              </div>
              <span className="rounded-full bg-ink-100 px-2.5 py-0.5 text-xs font-medium text-ink-600">Monthly</span>
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-ink-100 pt-3 text-sm">
              <div><p className="text-xs text-ink-400">Next billing</p><p className="font-semibold text-ink-900">{fmtDate(s.nextBilling)}</p></div>
            </div>
          </div>
          <p className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wide text-ink-400">Included features</p>
          <div className="grid grid-cols-2 gap-3">
            {[
              [Clock, "Minutes", String(s.minutesIncluded)],
              [Users, "Concurrency limit", String(s.concurrencyLimit)],
              [Database, "Workspaces", "—"],
              [Database, "Knowledge bases", "—"],
            ].map(([Icon, label, val], i) => {
              const I = Icon as typeof Clock;
              return (
                <div key={i} className="rounded-xl border border-ink-100 p-3">
                  <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-400"><I className="h-3.5 w-3.5" /> {label as string}</p>
                  <p className="mt-1 text-lg font-bold text-ink-900">{val as string}</p>
                </div>
              );
            })}
          </div>
          <div className="mt-4 flex justify-end">
            <button onClick={() => toast("Plan changes are handled in Stripe — add STRIPE_SECRET_KEY to enable.", "info")} className="flex items-center gap-2 rounded-xl border border-ink-200 px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"><Zap className="h-4 w-4" /> Change plan</button>
          </div>
        </Card>

        {/* Payment methods (Stripe) */}
        <Card className="p-6">
          <div className="mb-4 flex items-start justify-between">
            <div>
              <p className="font-semibold text-ink-900">Payment Methods</p>
              <p className="text-xs text-ink-400">Manage your billing and payment options</p>
            </div>
            <span className="flex items-center gap-1 text-xs text-emerald-600"><ShieldCheck className="h-3.5 w-3.5" /> Secured by Stripe</span>
          </div>
          {s.cardLast4 ? (
            <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-ink-900 to-ink-800 p-5 text-white">
              <div className="mb-6 flex items-center justify-between">
                <div className="h-7 w-10 rounded-md bg-amber-400/90" />
                <CreditCard className="h-5 w-5 opacity-70" />
              </div>
              <p className="font-mono text-lg tracking-widest">•••• •••• •••• {s.cardLast4}</p>
              <p className="mt-3 text-[11px] uppercase opacity-70">Expires {s.cardExp ?? "••/••"} · {s.cardBrand ?? "Card"}</p>
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-ink-200 p-6 text-center text-sm text-ink-400">
              No card on file. Add one securely through Stripe.
            </div>
          )}
          <p className="mt-3 text-xs text-ink-400">This card is used for subscription renewals, add-on purchases, and auto-recharge payments. <strong>Card numbers are never stored by Pydent</strong> — they&apos;re held by Stripe (PCI-compliant); we only see the last 4 digits.</p>
          <div className="mt-4 flex justify-end">
            <button onClick={() => setManageOpen(true)} className="flex items-center gap-2 rounded-xl border border-ink-200 px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"><CreditCard className="h-4 w-4" /> Manage payment methods</button>
          </div>
        </Card>
      </div>

      {/* History (Billing / Usage / Minutes) */}
      <Card className="p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-lg font-bold text-ink-900">
              {histTab === "billing" ? "Billing History" : histTab === "usage" ? "Usage History" : "Minutes History"}
            </p>
            <p className="text-xs text-ink-400">
              {histTab === "billing" ? "View and download your past invoices" : histTab === "usage" ? "View your past usage history" : "Detailed breakdown of your minutes allocations ordered by expiration"}
            </p>
          </div>
          <div className="flex rounded-xl border border-ink-200 bg-ink-50/50 p-1">
            {([["billing", "Billing History"], ["usage", "Usage History"], ["minutes", "Minutes History"]] as [HistoryTab, string][]).map(([k, label]) => (
              <button key={k} onClick={() => setHistTab(k)} className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${histTab === k ? "bg-surface text-ink-900 shadow-sm" : "text-ink-500 hover:text-ink-800"}`}>{label}</button>
            ))}
          </div>
        </div>

        {histTab === "billing" && (
          invoices.length === 0 ? (
            <p className="rounded-xl border border-ink-100 px-4 py-8 text-center text-sm text-ink-400">No invoices yet — they appear here after your first payment (via Stripe).</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="border-b border-ink-200 text-xs font-semibold uppercase tracking-wide text-ink-400">
                  <tr><th className="px-4 py-3">Description</th><th className="px-4 py-3">Date</th><th className="px-4 py-3">Amount</th><th className="px-4 py-3">Status</th><th className="px-4 py-3 text-right">Invoice</th></tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv.id} className="border-b border-ink-100 last:border-0">
                      <td className="px-4 py-3.5 font-medium text-ink-900">{inv.description}</td>
                      <td className="px-4 py-3.5 text-ink-600">{fmtDate(inv.paidAt)}</td>
                      <td className="px-4 py-3.5 text-ink-900">{money(inv.amount)}</td>
                      <td className="px-4 py-3.5"><span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600 capitalize">{inv.status}</span></td>
                      <td className="px-4 py-3.5 text-right">{inv.invoiceUrl ? <a href={inv.invoiceUrl} className="inline-flex items-center gap-1 text-brand-600"><Download className="h-3.5 w-3.5" /> Download</a> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {histTab === "usage" && (
          usage.length === 0 ? (
            <p className="rounded-xl border border-ink-100 px-4 py-8 text-center text-sm text-ink-400">No call usage yet — every voice call&apos;s minutes will show here.</p>
          ) : (
            <>
              <table className="w-full text-left text-sm">
                <thead className="border-b border-ink-200 text-xs font-semibold uppercase tracking-wide text-ink-400">
                  <tr><th className="px-4 py-3">Usage</th><th className="px-4 py-3 text-right">When</th></tr>
                </thead>
                <tbody>
                  {usage.slice((usagePage - 1) * USAGE_PER_PAGE, usagePage * USAGE_PER_PAGE).map((c) => (
                    <tr key={c.id} className="border-b border-ink-100 last:border-0">
                      <td className="px-4 py-3.5">
                        <p className="flex items-center gap-2 font-medium text-ink-900"><Activity className="h-4 w-4 text-ink-400" /> {durLabel(c.durationSec)}</p>
                        <p className="ml-6 text-xs text-ink-400">Minutes Usage</p>
                      </td>
                      <td className="px-4 py-3.5 text-right text-ink-500">{ago(c.startedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-3 flex items-center justify-between text-sm text-ink-500">
                <span>Showing {(usagePage - 1) * USAGE_PER_PAGE + 1} to {Math.min(usagePage * USAGE_PER_PAGE, usage.length)} of {usage.length} usage records</span>
                <div className="flex items-center gap-1">
                  <button onClick={() => setUsagePage((p) => Math.max(1, p - 1))} disabled={usagePage === 1} className="rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40">Previous</button>
                  <span className="px-2 text-xs">Page {usagePage} of {Math.max(1, Math.ceil(usage.length / USAGE_PER_PAGE))}</span>
                  <button onClick={() => setUsagePage((p) => Math.min(Math.ceil(usage.length / USAGE_PER_PAGE), p + 1))} disabled={usagePage >= Math.ceil(usage.length / USAGE_PER_PAGE)} className="rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40">Next</button>
                </div>
              </div>
            </>
          )
        )}

        {histTab === "minutes" && (
          s.minutesIncluded === 0 ? (
            <p className="rounded-xl border border-ink-100 px-4 py-8 text-center text-sm text-ink-400">No minute allocations yet — they appear here when you have an active plan.</p>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                <p className="font-semibold text-ink-900">Current Batches</p>
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600">1 allocation</span>
                <span className="ml-auto text-xs text-ink-400">Total: {s.minutesBalance.toLocaleString()} minutes</span>
              </div>
              <div className="flex items-start gap-2 rounded-xl border border-ink-100 bg-ink-50/60 p-3 text-xs text-ink-500">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span><strong className="text-ink-700">Consumption Order</strong><br />Minutes are used in order of expiration date (earliest first) to minimise waste. The first available allocation is currently in use.</span>
              </div>
              <table className="w-full text-left text-sm">
                <thead className="border-b border-ink-200 text-xs font-semibold uppercase tracking-wide text-ink-400">
                  <tr><th className="px-4 py-3">Plan details</th><th className="px-4 py-3 text-right">Minutes remaining</th><th className="px-4 py-3">Expiration</th><th className="px-4 py-3">Status</th></tr>
                </thead>
                <tbody>
                  <tr className="border-l-2 border-l-emerald-500">
                    <td className="px-4 py-3.5 font-medium text-ink-900"><span className="flex items-center gap-2"><Activity className="h-4 w-4 text-emerald-500" /> {s.planName}</span></td>
                    <td className="px-4 py-3.5 text-right"><span className="font-semibold text-ink-900">{s.minutesBalance.toLocaleString()}</span><span className="block text-xs text-ink-400">of {s.minutesIncluded.toLocaleString()} minutes</span></td>
                    <td className="px-4 py-3.5 text-ink-600">{fmtDate(s.nextBilling)}</td>
                    <td className="px-4 py-3.5"><span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> In use</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )
        )}
      </Card>
    </div>
  );
}

function AddMinutesDrawer({ settings, onClose }: { settings: BillingSettings; onClose: () => void }) {
  const [qty, setQty] = useState(60);
  const total = qty * settings.pricePerMinute;
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-md flex-col bg-surface p-6 shadow-2xl">
        <div className="mb-5 flex items-start justify-between">
          <div className="flex items-center gap-2.5">
            <div className="rounded-xl bg-brand-500/15 p-2 text-brand-600"><Clock className="h-5 w-5" /></div>
            <div><p className="font-semibold text-ink-900">Add Minutes</p><p className="text-xs text-ink-400">Purchase calling minutes for your account</p></div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-ink-400 hover:bg-ink-100"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex items-center justify-between text-sm"><span className="text-ink-600">Minutes to add</span><span className="text-ink-400">{money(settings.pricePerMinute)}/min</span></div>
        <div className="mt-2 flex items-center gap-3">
          <button onClick={() => setQty((q) => Math.max(1, q - 30))} className="rounded-xl border border-ink-200 p-2.5 text-ink-600 hover:bg-ink-50"><Minus className="h-4 w-4" /></button>
          <input type="number" value={qty} min={1} onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))} className="flex-1 rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-center text-lg font-semibold text-ink-900 outline-none" />
          <button onClick={() => setQty((q) => q + 30)} className="rounded-xl border border-ink-200 p-2.5 text-ink-600 hover:bg-ink-50"><Plus className="h-4 w-4" /></button>
        </div>
        <div className="mt-5 rounded-xl border border-ink-100 p-3 text-sm">
          <p className="flex items-center gap-2 text-ink-600"><CreditCard className="h-4 w-4 text-ink-400" /> {settings.cardLast4 ? `•••• ${settings.cardLast4} · default` : "No card on file"}</p>
        </div>
        <div className="mt-auto space-y-2 border-t border-ink-100 pt-4">
          <div className="flex items-center justify-between text-sm text-ink-500"><span>{qty} min × {money(settings.pricePerMinute)}</span><span>{money(total)}</span></div>
          <div className="flex items-center justify-between text-base font-bold text-ink-900"><span>Total</span><span>{money(total)}</span></div>
          <button
            onClick={() => toast("Purchases run through Stripe — add STRIPE_SECRET_KEY + a card to enable charging.", "info")}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 py-3 text-sm font-semibold text-white hover:bg-brand-700"
          >
            <ShieldCheck className="h-4 w-4" /> Purchase Minutes
          </button>
        </div>
      </div>
    </div>
  );
}

function AutoRechargeModal({ settings, onClose, onSaved }: { settings: BillingSettings; onClose: () => void; onSaved: () => void }) {
  const [on, setOn] = useState(settings.autoRecharge);
  const [below, setBelow] = useState(settings.rechargeBelow);
  const [to, setTo] = useState(settings.rechargeTo);
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    const res = await saveAutoRecharge({ autoRecharge: on, rechargeBelow: below, rechargeTo: to });
    setSaving(false);
    toast(res.message, res.ok ? "success" : "info");
    if (res.ok) onSaved();
  }
  return (
    <Modal open onClose={onClose} title="Auto-recharge Settings" subtitle="Never run out of minutes unexpectedly">
      <div className="space-y-3">
        <label className="flex items-center justify-between rounded-xl border border-ink-100 p-3">
          <span className="flex items-center gap-2.5"><Zap className="h-4 w-4 text-brand-500" /><span><span className="text-sm font-medium text-ink-800">Enable Auto-recharge</span><span className="block text-xs text-ink-400">Turn on to enable automatic top-ups</span></span></span>
          <button onClick={() => setOn((v) => !v)} className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-brand-600" : "bg-ink-200"}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`} /></button>
        </label>
        <div className="rounded-xl border border-ink-100 p-3">
          <p className="mb-1 flex items-center gap-2 text-sm text-ink-600"><Clock className="h-4 w-4 text-amber-500" /> Trigger when balance falls below</p>
          <input type="number" value={below} onChange={(e) => setBelow(Number(e.target.value) || 0)} disabled={!on} className="w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900 outline-none disabled:opacity-50" placeholder="10" />
        </div>
        <div className="rounded-xl border border-ink-100 p-3">
          <p className="mb-1 flex items-center gap-2 text-sm text-ink-600"><Plus className="h-4 w-4 text-emerald-500" /> Refill balance up to</p>
          <input type="number" value={to} onChange={(e) => setTo(Number(e.target.value) || 0)} disabled={!on} className="w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900 outline-none disabled:opacity-50" placeholder="60" />
        </div>
        <div className="flex items-center justify-between rounded-xl border border-ink-100 px-3 py-2.5 text-sm"><span className="text-ink-500">Price per minute</span><span className="font-semibold text-ink-900">{money(settings.pricePerMinute)} USD</span></div>
      </div>
      <ModalFooter onClose={onClose} submitLabel={saving ? "Saving…" : "Save"} onSubmit={save} />
    </Modal>
  );
}

function ManagePaymentDrawer({ settings, onClose }: { settings: BillingSettings; onClose: () => void }) {
  const [addOpen, setAddOpen] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {addOpen && <AddCardModal onClose={() => setAddOpen(false)} />}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-md flex-col bg-surface p-6 shadow-2xl">
        <div className="mb-5 flex items-start justify-between">
          <div className="flex items-center gap-2.5">
            <div className="rounded-xl bg-brand-500/15 p-2 text-brand-600"><CreditCard className="h-5 w-5" /></div>
            <div><p className="font-semibold text-ink-900">Manage Payment Methods</p><p className="text-xs text-ink-400">View, update, or remove your saved cards</p></div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-ink-400 hover:bg-ink-100"><X className="h-5 w-5" /></button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto">
          {settings.cardLast4 ? (
            <div className="flex items-center justify-between rounded-xl border border-ink-200 p-3">
              <div className="flex items-center gap-3">
                <CreditCard className="h-5 w-5 text-ink-400" />
                <div>
                  <p className="flex items-center gap-2 text-sm font-medium text-ink-900">•••• {settings.cardLast4} <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-600">Default</span></p>
                  <p className="text-xs text-ink-400">Expires {settings.cardExp ?? "••/••"}</p>
                </div>
              </div>
              <button className="rounded-lg p-1 text-ink-400 hover:bg-ink-100"><MoreVertical className="h-4 w-4" /></button>
            </div>
          ) : (
            <p className="rounded-xl border border-dashed border-ink-200 p-6 text-center text-sm text-ink-400">No saved cards yet. Add one securely through Stripe.</p>
          )}
        </div>

        <div className="mt-4 flex items-center gap-2 border-t border-ink-100 pt-4">
          <button onClick={() => setAddOpen(true)} className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-ink-200 py-2.5 text-sm font-semibold text-ink-700 hover:bg-ink-50"><Plus className="h-4 w-4" /> Add Card</button>
          <button onClick={onClose} className="flex-1 rounded-xl bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700">Close</button>
        </div>
      </div>
    </div>
  );
}

const COUNTRIES = ["United Arab Emirates", "Saudi Arabia", "Qatar", "Kuwait", "Bahrain", "Oman", "United States", "United Kingdom", "Canada", "Australia", "India", "Pakistan", "Other"];

// Card-entry form, styled like Stripe's. We never store the raw card number —
// when Stripe is connected this collects via Stripe Elements; until then it
// explains that and does NOT persist any card data.
function AddCardModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [addr1, setAddr1] = useState("");
  const [addr2, setAddr2] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("");
  function submit() {
    toast("Cards are added securely through Stripe — connect Stripe (STRIPE_SECRET_KEY) to save a card. Nothing was stored.", "info");
    onClose();
  }
  return (
    <Modal open onClose={onClose} title="Add New Payment Method" subtitle="Enter your card details below. Your payment information is securely processed by Stripe.">
      <div className="space-y-4">
        <Field label="Cardholder Name"><input className={inputCls} placeholder="Name on card" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div>
          <p className="mb-1.5 text-sm font-medium text-ink-700">Card Details</p>
          <div className="flex items-center gap-2 rounded-xl border border-ink-200 bg-surface px-3 py-2.5">
            <CreditCard className="h-4 w-4 text-ink-400" />
            <input className="flex-1 bg-transparent text-sm text-ink-800 outline-none placeholder:text-ink-400" placeholder="Card number" inputMode="numeric" />
          </div>
          <p className="mt-1 text-xs text-ink-400">Card number, expiry and CVC are captured by Stripe&apos;s secure field — never stored by Pydent.</p>
        </div>
        <Field label="Billing Address"><input className={inputCls} placeholder="e.g: 123 Main St" value={addr1} onChange={(e) => setAddr1(e.target.value)} /></Field>
        <input className={inputCls} placeholder="(Optional) e.g: Apt 123" value={addr2} onChange={(e) => setAddr2(e.target.value)} />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Billing City"><input className={inputCls} placeholder="Los Angeles" value={city} onChange={(e) => setCity(e.target.value)} /></Field>
          <Field label="Billing Country">
            <select className={inputCls} value={country} onChange={(e) => setCountry(e.target.value)}>
              <option value="">Select billing country</option>
              {COUNTRIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Tax Number (Optional)"><input className={inputCls} placeholder="(Optional) e.g: 123456789" /></Field>
      </div>
      <ModalFooter onClose={onClose} submitLabel="Add Card" onSubmit={submit} />
    </Modal>
  );
}
