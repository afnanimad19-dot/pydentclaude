"use client";

import { useEffect, useState } from "react";
import { CircleDollarSign, Receipt, FileText, AlertCircle, Send, Check } from "lucide-react";
import { Card, PageHeader, DemoBanner, StatCard, StatusBadge, Avatar } from "@/components/ui";
import { toast } from "@/components/toast";
import {
  payments,
  patients,
  insuranceClaims,
  formatMoney,
  type InsuranceClaim,
} from "@/lib/mock-data";

const claimTone: Record<InsuranceClaim["status"], "green" | "amber" | "red" | "gray" | "blue"> = {
  Paid: "green",
  Sent: "blue",
  Received: "blue",
  Pending: "amber",
  Unsent: "gray",
  Denied: "red",
};

const patientName = (id: string) => patients.find((p) => p.id === id)?.name ?? "Unknown";

export default function BillingPage() {
  const [claims, setClaims] = useState<InsuranceClaim[]>(insuranceClaims);

  useEffect(() => {
    Promise.resolve().then(() => {
      try {
        const saved = localStorage.getItem("pydental-claims");
        if (saved) {
          const map = JSON.parse(saved) as Record<string, InsuranceClaim["status"]>;
          setClaims((prev) => prev.map((c) => (map[c.id] ? { ...c, status: map[c.id] } : c)));
        }
      } catch {}
    });
  }, []);

  function advance(id: string, status: InsuranceClaim["status"]) {
    setClaims((prev) => {
      const next = prev.map((c) => (c.id === id ? { ...c, status, paid: status === "Paid" ? c.estimated : c.paid } : c));
      try {
        const map = Object.fromEntries(next.map((c) => [c.id, c.status]));
        localStorage.setItem("pydental-claims", JSON.stringify(map));
      } catch {}
      return next;
    });
    toast(`Claim marked ${status}.`);
  }

  const collected = payments.filter((p) => p.status === "Paid").reduce((s, p) => s + p.amount, 0);
  const pendingPay = payments.filter((p) => p.status === "Pending").reduce((s, p) => s + p.amount, 0);
  const totalAR = patients.reduce((s, p) => s + p.balance, 0);
  const outstandingClaims = claims
    .filter((c) => c.status !== "Paid" && c.status !== "Denied")
    .reduce((s, c) => s + (c.estimated - c.paid), 0);

  const ledger = [...payments]
    .map((p) => ({ ...p, name: patientName(p.patientId) }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  return (
    <>
      <DemoBanner context="Demo ledger and claims. Connect OpenDental + Stripe to post real payments and submit electronic claims." />
      <PageHeader
        title="Billing & Claims"
        subtitle="Patient ledger, collections and the insurance-claim worklist — all in one place."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={CircleDollarSign} label="Collected" value={formatMoney(collected)} hint="posted payments" accent="green" />
        <StatCard icon={Receipt} label="Pending payments" value={formatMoney(pendingPay)} hint="financing / in-flight" accent="amber" />
        <StatCard icon={AlertCircle} label="Accounts receivable" value={formatMoney(totalAR)} hint="patient balances" accent="violet" />
        <StatCard icon={FileText} label="Insurance outstanding" value={formatMoney(outstandingClaims)} hint={`${claims.filter((c) => c.status !== "Paid" && c.status !== "Denied").length} open claims`} accent="brand" />
      </div>

      {/* Insurance claims worklist */}
      <Card className="mt-6 scroll-mt-20 overflow-hidden" id="claims">
        <div className="border-b border-ink-200 px-5 py-4">
          <h2 className="flex items-center gap-2 font-semibold text-ink-900">
            <FileText className="h-5 w-5 text-brand-500" /> Insurance claims
          </h2>
          <p className="mt-0.5 text-sm text-ink-500">Track each claim from creation to payment. Use the buttons to advance status.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink-200 bg-ink-50 text-xs font-semibold uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-5 py-3">Claim</th>
                <th className="px-4 py-3">Patient</th>
                <th className="px-4 py-3">Carrier</th>
                <th className="px-4 py-3">Procedures</th>
                <th className="px-4 py-3 text-right">Billed</th>
                <th className="px-4 py-3 text-right">Est. ins.</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {claims.map((c) => (
                <tr key={c.id} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/60">
                  <td className="px-5 py-3.5">
                    <p className="font-medium text-ink-900">#{c.claimNum}</p>
                    <p className="text-xs text-ink-400">{c.dateOfService}</p>
                  </td>
                  <td className="px-4 py-3.5 text-ink-700">{c.patientName}</td>
                  <td className="px-4 py-3.5 text-ink-700">{c.carrier}</td>
                  <td className="px-4 py-3.5 text-ink-600">{c.procedures}</td>
                  <td className="px-4 py-3.5 text-right text-ink-700">{formatMoney(c.billed)}</td>
                  <td className="px-4 py-3.5 text-right text-ink-700">{formatMoney(c.estimated)}</td>
                  <td className="px-4 py-3.5"><StatusBadge status={c.status} tone={claimTone[c.status]} /></td>
                  <td className="px-4 py-3.5 text-right">
                    {c.status === "Unsent" && (
                      <button onClick={() => advance(c.id, "Sent")} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700">
                        <Send className="h-3.5 w-3.5" /> Send
                      </button>
                    )}
                    {(c.status === "Sent" || c.status === "Received" || c.status === "Pending") && (
                      <button onClick={() => advance(c.id, "Paid")} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs font-semibold text-emerald-600 hover:bg-emerald-500/10">
                        <Check className="h-3.5 w-3.5" /> Mark paid
                      </button>
                    )}
                    {(c.status === "Paid" || c.status === "Denied") && <span className="text-xs text-ink-400">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Ledger */}
      <Card className="mt-6 scroll-mt-20 overflow-hidden" id="ledger">
        <div className="border-b border-ink-200 px-5 py-4">
          <h2 className="flex items-center gap-2 font-semibold text-ink-900">
            <Receipt className="h-5 w-5 text-brand-500" /> Payment ledger
          </h2>
          <p className="mt-0.5 text-sm text-ink-500">Every posted and pending transaction across the practice.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink-200 bg-ink-50 text-xs font-semibold uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-5 py-3">Date</th>
                <th className="px-4 py-3">Patient</th>
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3">Method</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((p) => (
                <tr key={p.id} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/60">
                  <td className="px-5 py-3.5 text-ink-700">{p.date}</td>
                  <td className="px-4 py-3.5">
                    <span className="flex items-center gap-2.5">
                      <Avatar name={p.name} size="sm" />
                      <span className="font-medium text-ink-900">{p.name}</span>
                    </span>
                  </td>
                  <td className="px-4 py-3.5 text-ink-600">{p.description}</td>
                  <td className="px-4 py-3.5 text-ink-700">{p.method}</td>
                  <td className="px-4 py-3.5 text-right font-medium text-ink-900">{formatMoney(p.amount)}</td>
                  <td className="px-4 py-3.5">
                    <StatusBadge status={p.status} tone={p.status === "Paid" ? "green" : p.status === "Pending" ? "amber" : "gray"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
