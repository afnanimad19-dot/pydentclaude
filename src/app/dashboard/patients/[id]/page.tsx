"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CalendarPlus,
  Upload,
  FileText,
  Image as ImageIcon,
  ShieldCheck,
  CreditCard,
  Stethoscope,
  MessageCircle,
  Receipt,
  Pill,
  LayoutGrid,
  FileCheck2,
  Plus,
  ArrowRight,
  Trash2,
} from "lucide-react";
import { Card, DemoBanner, StatusBadge, Avatar } from "@/components/ui";
import { Modal, Field, ModalFooter, inputCls } from "@/components/modal";
import { NewAppointmentModal } from "@/components/dashboard/create-modals";
import { toast } from "@/components/toast";
import {
  fetchPatientBundle,
  addDocument,
  addPayment,
  fetchToothMarks,
  setToothMark,
  fetchLedgerAdjustments,
  addLedgerAdjustment,
  fetchClaims,
  createClaim,
  updateClaimStatus,
  fetchPrescriptions,
  createPrescription,
  deletePrescription,
  type PatientBundle,
} from "@/lib/db";
import { formatMoney } from "@/lib/mock-data";

function categoryFor(name: string): string {
  if (/\.(png|jpe?g|webp|heic)$/i.test(name)) return "Photo (before)";
  if (/xray|pano|bitewing/i.test(name)) return "X-ray";
  if (/consent/i.test(name)) return "Consent form";
  if (/insurance|card/i.test(name)) return "Insurance";
  return "Other";
}

function sizeLabel(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// ---------------------------------------------------- clinical-module types

type ToothCondition = "healthy" | "planned" | "completed" | "watch" | "missing";

const TOOTH_CONDITIONS: { key: ToothCondition; label: string; dot: string; cell: string }[] = [
  { key: "healthy", label: "Healthy", dot: "bg-ink-300", cell: "border-ink-200 bg-surface text-ink-700" },
  { key: "planned", label: "Treatment planned", dot: "bg-amber-500", cell: "border-amber-400 bg-amber-500/15 text-amber-700" },
  { key: "completed", label: "Completed", dot: "bg-emerald-500", cell: "border-emerald-400 bg-emerald-500/15 text-emerald-700" },
  { key: "watch", label: "Watch", dot: "bg-sky-500", cell: "border-sky-400 bg-sky-500/15 text-sky-700" },
  { key: "missing", label: "Missing / extracted", dot: "bg-rose-500", cell: "border-rose-300 bg-rose-500/10 text-rose-400 line-through" },
];

const CONDITION_ORDER: ToothCondition[] = ["healthy", "planned", "completed", "watch", "missing"];
const UPPER_TEETH = Array.from({ length: 16 }, (_, i) => i + 1); // 1–16, patient's right → left
const LOWER_TEETH = Array.from({ length: 16 }, (_, i) => 32 - i); // 32–17, aligned under the upper arch

function conditionCell(c: ToothCondition) {
  return TOOTH_CONDITIONS.find((t) => t.key === c) ?? TOOTH_CONDITIONS[0];
}

interface Prescription {
  id: string;
  drug: string;
  sig: string;
  quantity: string;
  refills: number;
  date: string;
  status: "Active" | "Sent to pharmacy" | "Completed";
}

interface Claim {
  id: string;
  carrier: string;
  procedures: string;
  billed: number;
  estInsurance: number;
  status: "Draft" | "Sent" | "Received" | "Paid";
}

const CLAIM_FLOW: Claim["status"][] = ["Draft", "Sent", "Received", "Paid"];
const claimTone = { Draft: "gray", Sent: "amber", Received: "blue", Paid: "green" } as const;
const rxTone = { Active: "blue", "Sent to pharmacy": "amber", Completed: "green" } as const;

const COMMON_DRUGS = [
  "Amoxicillin 500mg",
  "Clindamycin 300mg",
  "Ibuprofen 600mg",
  "Acetaminophen 500mg",
  "Penicillin VK 500mg",
  "Chlorhexidine 0.12% rinse",
  "Hydrocodone/APAP 5-325mg",
  "Metronidazole 500mg",
];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

type Tab =
  | "overview"
  | "chart"
  | "appointments"
  | "treatment"
  | "ledger"
  | "claims"
  | "rx"
  | "documents"
  | "insurance"
  | "payments";

const tabs: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "chart", label: "Tooth chart" },
  { key: "appointments", label: "Appointments" },
  { key: "treatment", label: "Treatment plans" },
  { key: "ledger", label: "Account / Ledger" },
  { key: "claims", label: "Claims" },
  { key: "rx", label: "Prescriptions" },
  { key: "documents", label: "Documents" },
  { key: "insurance", label: "Insurance" },
  { key: "payments", label: "Payments" },
];

const aptTone = { Confirmed: "green", Scheduled: "blue", Unconfirmed: "amber", Completed: "gray", Broken: "red" } as const;
const planTone = { Presented: "amber", Accepted: "blue", "In progress": "blue", Completed: "green" } as const;
const payTone = { Paid: "green", Pending: "amber", Refunded: "gray" } as const;

export default function PatientProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [tab, setTab] = useState<Tab>("overview");
  const [aptModal, setAptModal] = useState(false);
  const [payModal, setPayModal] = useState(false);
  const [bundle, setBundle] = useState<PatientBundle | null | "loading">("loading");
  const fileRef = useRef<HTMLInputElement>(null);

  // Clinical-module state (tooth chart, prescriptions, claims, ledger adjustments)
  const [toothState, setToothState] = useState<Record<number, ToothCondition>>({});
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [ledgerAdj, setLedgerAdj] = useState<{ id: string; date: string; description: string; amount: number }[]>([]);
  const [rxModal, setRxModal] = useState(false);
  const [claimModal, setClaimModal] = useState(false);
  const [adjustModal, setAdjustModal] = useState(false);
  const seededRef = useRef<string | null>(null);

  // Seed the clinical modules once per patient. Live charts load from Supabase;
  // demo charts fall back to data derived from the patient's plan.
  useEffect(() => {
    if (bundle === "loading" || !bundle) return;
    if (seededRef.current === bundle.patient.id) return;
    seededRef.current = bundle.patient.id;
    const live = bundle.source === "live";
    const pid = bundle.patient.id;

    // Tooth chart — plan-derived defaults, overlaid with any saved marks.
    const teeth: Record<number, ToothCondition> = {};
    bundle.plans.forEach((pl) =>
      pl.procedures.forEach((pr) => {
        const m = String(pr.tooth).match(/\d{1,2}/);
        if (m) {
          const n = parseInt(m[0], 10);
          if (n >= 1 && n <= 32) teeth[n] = pr.status === "Completed" ? "completed" : "planned";
        }
      })
    );
    if (live) {
      fetchToothMarks(pid).then((saved) => setToothState({ ...teeth, ...saved }));
      fetchClaims(pid).then(setClaims);
      fetchPrescriptions(pid).then(setPrescriptions);
      fetchLedgerAdjustments(pid).then(setLedgerAdj);
      return;
    }

    setToothState(teeth);
    const claimsSeed: Claim[] = [];
    const realIns = bundle.insurance.filter((i) => i.carrier && i.carrier !== "—" && i.annualMax > 0);
    const billableProcs = bundle.plans.flatMap((pl) => pl.procedures).filter((pr) => pr.status !== "Planned");
    if (realIns.length && billableProcs.length) {
      const billed = billableProcs.reduce((s, p) => s + p.fee, 0);
      const codes = billableProcs.slice(0, 3).map((p) => p.code).join(", ") + (billableProcs.length > 3 ? ` +${billableProcs.length - 3}` : "");
      claimsSeed.push({ id: "claim-seed-1", carrier: realIns[0].carrier, procedures: codes, billed, estInsurance: Math.round(billed * 0.5), status: "Sent" });
    }
    setClaims(claimsSeed);
    setPrescriptions(
      bundle.plans.length
        ? [{ id: "rx-seed-1", drug: "Amoxicillin 500mg", sig: "1 capsule three times daily for 7 days", quantity: "21", refills: 0, date: todayISO(), status: "Sent to pharmacy" }]
        : []
    );
    setLedgerAdj([]);
  }, [bundle]);

  const isLive = bundle !== "loading" && !!bundle && bundle.source === "live";
  const patientId = bundle !== "loading" && bundle ? bundle.patient.id : "";

  function cycleTooth(n: number) {
    const cur = toothState[n] ?? "healthy";
    const next = CONDITION_ORDER[(CONDITION_ORDER.indexOf(cur) + 1) % CONDITION_ORDER.length];
    setToothState((prev) => ({ ...prev, [n]: next }));
    if (isLive) setToothMark(patientId, n, next);
  }

  function advanceClaim(id: string) {
    let newStatus: Claim["status"] | null = null;
    setClaims((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        newStatus = CLAIM_FLOW[Math.min(CLAIM_FLOW.indexOf(c.status) + 1, CLAIM_FLOW.length - 1)];
        return { ...c, status: newStatus };
      })
    );
    if (isLive && newStatus) updateClaimStatus(id, newStatus);
  }

  async function onUpload(files: FileList | null) {
    if (!files || bundle === "loading" || !bundle) return;
    for (const f of Array.from(files)) {
      const res = await addDocument(bundle.patient.id, f.name, categoryFor(f.name), sizeLabel(f.size));
      toast(res.ok ? `“${f.name}” added to ${bundle.patient.name}'s chart.` : `Upload failed: ${res.message}`, res.ok ? "success" : "info");
    }
    if (fileRef.current) fileRef.current.value = "";
    refresh();
  }

  const refresh = useCallback(() => {
    fetchPatientBundle(id).then(setBundle);
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (bundle === "loading") {
    return <p className="py-20 text-center text-sm text-ink-500">Loading patient chart…</p>;
  }
  if (!bundle) {
    return (
      <div className="py-20 text-center">
        <p className="text-ink-500">Patient not found.</p>
        <Link href="/dashboard/patients" className="mt-3 inline-block text-sm font-medium text-brand-600">
          ← Back to roster
        </Link>
      </div>
    );
  }

  const { patient, appointments: pAppointments, plans: pPlans, documents: pDocs, insurance: pInsurance, payments: pPayments } = bundle;

  // Build a running-balance ledger from procedure charges, payments and manual adjustments.
  const ledger = (() => {
    type Row = { date: string; description: string; charge: number; credit: number };
    const rows: Row[] = [];
    pPlans.forEach((pl) =>
      pl.procedures
        .filter((pr) => pr.status !== "Planned")
        .forEach((pr) =>
          rows.push({ date: pl.presentedOn || patient.lastVisit, description: `${pr.code} · ${pr.description}${pr.tooth ? ` (#${pr.tooth})` : ""}`, charge: pr.fee, credit: 0 })
        )
    );
    pPayments.forEach((p2) => rows.push({ date: p2.date, description: `${p2.description || "Payment"} · ${p2.method}`, charge: 0, credit: p2.amount }));
    ledgerAdj.forEach((a) =>
      rows.push({ date: a.date, description: a.description, charge: a.amount >= 0 ? a.amount : 0, credit: a.amount < 0 ? -a.amount : 0 })
    );
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    let bal = 0;
    return rows.map((r) => {
      bal += r.charge - r.credit;
      return { ...r, balance: bal };
    });
  })();
  const ledgerBalance = ledger.length ? ledger[ledger.length - 1].balance : patient.balance;

  return (
    <>
      {payModal && (
        <CollectPaymentModal
          patientId={patient.id}
          patientName={patient.name}
          onClose={() => setPayModal(false)}
          onSaved={refresh}
        />
      )}
      <NewAppointmentModal
        open={aptModal}
        onClose={() => setAptModal(false)}
        patientId={patient.id}
        patientName={patient.name}
        onCreated={refresh}
      />
      {bundle.source === "live" ? (
        <div className="mb-6 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-600">
          <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500" />
          <span><strong className="font-semibold">Live chart</strong> — reading from your Supabase database.</span>
        </div>
      ) : (
        <DemoBanner context="Sample patient chart — connect the database to manage real charts." />
      )}
      <Link href="/dashboard/patients" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-ink-500 hover:text-ink-900">
        <ArrowLeft className="h-4 w-4" /> All patients
      </Link>

      <Card className="mb-6 p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Avatar name={patient.name} size="lg" />
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-xl font-semibold text-ink-900">{patient.name}</h1>
                <StatusBadge status={patient.status} tone={patient.status === "Active" ? "green" : patient.status === "New" ? "blue" : "gray"} />
              </div>
              <p className="mt-0.5 text-sm text-ink-500">
                PatNum {patient.patNum} · DOB {patient.birthdate} · {patient.phone} · {patient.email}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Link
              href="/dashboard/inbox"
              className="flex items-center gap-2 rounded-xl border border-ink-200 px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"
            >
              <MessageCircle className="h-4 w-4" /> Message
            </Link>
            <button
              onClick={() => setAptModal(true)}
              className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              <CalendarPlus className="h-4 w-4" /> New appointment
            </button>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-4 border-t border-ink-100 pt-5 md:grid-cols-4">
          {[
            ["Insurance", patient.insurance],
            ["Last visit", patient.lastVisit],
            ["Next appointment", patient.nextAppointment ?? "None scheduled"],
            ["Balance", `$${patient.balance.toFixed(2)}`],
          ].map(([k, v]) => (
            <div key={k}>
              <p className="text-xs text-ink-400">{k}</p>
              <p className="mt-0.5 text-sm font-medium text-ink-900">{v}</p>
            </div>
          ))}
        </div>
      </Card>

      <div className="mb-5 flex flex-wrap gap-1 rounded-xl border border-ink-200 bg-surface p-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.key ? "bg-brand-600 text-white" : "text-ink-600 hover:bg-ink-50"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="p-5">
            <h3 className="mb-3 flex items-center gap-2 font-semibold text-ink-900">
              <Stethoscope className="h-4 w-4 text-brand-500" /> Clinical status
            </h3>
            <ul className="space-y-2.5 text-sm text-ink-600">
              <li>Recall: {patient.recallDue ? "Overdue — enrolled in recall flow" : "Up to date"}</li>
              <li>Open treatment plans: {pPlans.length || "None"}</li>
              <li>Documents on file: {pDocs.length}</li>
              <li>Preferred channel: WhatsApp</li>
            </ul>
          </Card>
          <Card className="p-5">
            <h3 className="mb-3 flex items-center gap-2 font-semibold text-ink-900">
              <ShieldCheck className="h-4 w-4 text-brand-500" /> Insurance snapshot
            </h3>
            {pInsurance.length ? (
              pInsurance.map((i) => (
                <div key={i.id} className="text-sm text-ink-600">
                  <p className="font-medium text-ink-900">{i.carrier === "—" ? "Self-pay" : `${i.carrier} · ${i.plan}`}</p>
                  {i.annualMax > 0 && (
                    <p className="mt-1">
                      Benefits used: {formatMoney(i.usedBenefits)} of {formatMoney(i.annualMax)} (
                      {Math.round((i.usedBenefits / i.annualMax) * 100)}%)
                    </p>
                  )}
                  <p className="mt-1"><StatusBadge status={i.status} tone={i.status === "Verified" ? "green" : "amber"} /></p>
                </div>
              ))
            ) : (
              <p className="text-sm text-ink-500">No policy on file.</p>
            )}
          </Card>
          <Card className="p-5">
            <h3 className="mb-3 flex items-center gap-2 font-semibold text-ink-900">
              <CreditCard className="h-4 w-4 text-brand-500" /> Recent payments
            </h3>
            {pPayments.length ? (
              <ul className="space-y-2 text-sm">
                {pPayments.slice(0, 3).map((p2) => (
                  <li key={p2.id} className="flex items-center justify-between gap-2 text-ink-600">
                    <span className="truncate">{p2.date} · {p2.method}</span>
                    <span className="font-medium text-ink-900">{formatMoney(p2.amount)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-500">No payments recorded.</p>
            )}
          </Card>
        </div>
      )}

      {tab === "appointments" && (
        <Card className="p-5">
          {pAppointments.length ? (
            <ul className="space-y-2.5">
              {pAppointments.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 rounded-xl border border-ink-100 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-ink-900">{a.procedure}</p>
                    <p className="text-xs text-ink-500">
                      {a.date} {a.time} · {a.provider} · {a.operatory} · {a.durationMin} min
                    </p>
                  </div>
                  <StatusBadge status={a.status} tone={aptTone[a.status]} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-8 text-center text-sm text-ink-500">No upcoming appointments — book one with the button above.</p>
          )}
        </Card>
      )}

      {tab === "treatment" && (
        <div className="space-y-4">
          {pPlans.length ? (
            pPlans.map((plan) => (
              <Card key={plan.id} className="overflow-hidden">
                <div className="flex items-center justify-between border-b border-ink-200 px-5 py-4">
                  <div>
                    <h3 className="font-semibold text-ink-900">{plan.name}</h3>
                    <p className="text-xs text-ink-400">Presented {plan.presentedOn}</p>
                  </div>
                  <StatusBadge status={plan.status} tone={planTone[plan.status]} />
                </div>
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-ink-200 bg-ink-50 text-xs font-semibold uppercase tracking-wide text-ink-500">
                    <tr>
                      <th className="px-5 py-2.5">Code</th>
                      <th className="px-4 py-2.5">Procedure</th>
                      <th className="px-4 py-2.5">Tooth</th>
                      <th className="px-4 py-2.5 text-right">Fee</th>
                      <th className="px-4 py-2.5">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.procedures.map((proc) => (
                      <tr key={proc.code + proc.tooth} className="border-b border-ink-100 last:border-0">
                        <td className="px-5 py-3 font-mono text-xs text-ink-500">{proc.code}</td>
                        <td className="px-4 py-3 text-ink-900">{proc.description}</td>
                        <td className="px-4 py-3 text-ink-600">{proc.tooth}</td>
                        <td className="px-4 py-3 text-right font-medium text-ink-900">{formatMoney(proc.fee)}</td>
                        <td className="px-4 py-3">
                          <StatusBadge status={proc.status} tone={proc.status === "Completed" ? "green" : proc.status === "Accepted" ? "blue" : "amber"} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            ))
          ) : (
            <Card className="p-8 text-center text-sm text-ink-500">No treatment plans on file.</Card>
          )}
        </div>
      )}

      {tab === "documents" && (
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-semibold text-ink-900">Documents — X-rays, before/after photos, forms</h3>
            <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => onUpload(e.target.files)} />
            <button
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-2 rounded-xl border border-ink-200 px-3.5 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
            >
              <Upload className="h-4 w-4" /> Upload
            </button>
          </div>
          {pDocs.length ? (
            <ul className="grid gap-2.5 md:grid-cols-2">
              {pDocs.map((d) => (
                <li key={d.id} className="flex items-center gap-3 rounded-xl border border-ink-100 px-4 py-3">
                  <div className="rounded-lg bg-brand-500/15 p-2 text-brand-500">
                    {d.category.startsWith("Photo") || d.category === "X-ray" ? <ImageIcon className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink-900">{d.name}</p>
                    <p className="text-xs text-ink-400">{d.category} · {d.uploadedAt} · {d.size}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-8 text-center text-sm text-ink-500">No documents yet — upload X-rays, photos or forms.</p>
          )}
        </Card>
      )}

      {tab === "insurance" && (
        <Card className="p-5">
          {pInsurance.length ? (
            pInsurance.map((i) => (
              <div key={i.id} className="grid gap-4 md:grid-cols-2">
                {[
                  ["Carrier", i.carrier],
                  ["Plan", i.plan],
                  ["Member ID", i.memberId],
                  ["Group number", i.groupNumber],
                  ["Annual maximum", i.annualMax ? formatMoney(i.annualMax) : "—"],
                  ["Benefits used", i.annualMax ? `${formatMoney(i.usedBenefits)} (${Math.round((i.usedBenefits / i.annualMax) * 100)}%)` : "—"],
                  ["Deductible", i.deductible ? formatMoney(i.deductible) : "—"],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-xl border border-ink-100 px-4 py-3">
                    <p className="text-xs text-ink-400">{k}</p>
                    <p className="mt-0.5 text-sm font-medium text-ink-900">{v}</p>
                  </div>
                ))}
                <div className="rounded-xl border border-ink-100 px-4 py-3">
                  <p className="text-xs text-ink-400">Verification</p>
                  <p className="mt-1"><StatusBadge status={i.status} tone={i.status === "Verified" ? "green" : "amber"} /></p>
                </div>
              </div>
            ))
          ) : (
            <p className="py-8 text-center text-sm text-ink-500">No insurance on file.</p>
          )}
        </Card>
      )}

      {tab === "payments" && (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-ink-200 px-5 py-4">
            <h3 className="font-semibold text-ink-900">Payment history</h3>
            <button
              onClick={() => setPayModal(true)}
              className="flex items-center gap-2 rounded-xl bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              <CreditCard className="h-4 w-4" /> Collect payment
            </button>
          </div>
          {pPayments.length ? (
            <table className="w-full text-left text-sm">
              <thead className="border-b border-ink-200 bg-ink-50 text-xs font-semibold uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-5 py-2.5">Date</th>
                  <th className="px-4 py-2.5">Description</th>
                  <th className="px-4 py-2.5">Method</th>
                  <th className="px-4 py-2.5 text-right">Amount</th>
                  <th className="px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {pPayments.map((p2) => (
                  <tr key={p2.id} className="border-b border-ink-100 last:border-0">
                    <td className="px-5 py-3 text-ink-600">{p2.date}</td>
                    <td className="px-4 py-3 text-ink-900">{p2.description}</td>
                    <td className="px-4 py-3 text-ink-600">{p2.method}</td>
                    <td className="px-4 py-3 text-right font-medium text-ink-900">{formatMoney(p2.amount)}</td>
                    <td className="px-4 py-3"><StatusBadge status={p2.status} tone={payTone[p2.status]} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="py-8 text-center text-sm text-ink-500">No payments recorded yet.</p>
          )}
        </Card>
      )}

      {tab === "chart" && (
        <Card className="p-6">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 font-semibold text-ink-900">
                <LayoutGrid className="h-4 w-4 text-brand-500" /> Odontogram
              </h3>
              <p className="mt-0.5 text-sm text-ink-500">Click a tooth to cycle its condition. Planned/completed teeth are seeded from the treatment plan.</p>
            </div>
            <div className="flex flex-wrap gap-3">
              {TOOTH_CONDITIONS.map((c) => (
                <span key={c.key} className="flex items-center gap-1.5 text-xs text-ink-600">
                  <span className={`h-2.5 w-2.5 rounded-full ${c.dot}`} /> {c.label}
                </span>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            {[UPPER_TEETH, LOWER_TEETH].map((arch, ai) => (
              <div key={ai} className="grid grid-cols-8 gap-1.5 sm:grid-cols-[repeat(16,minmax(0,1fr))]">
                {arch.map((n) => {
                  const cell = conditionCell(toothState[n] ?? "healthy");
                  return (
                    <button
                      key={n}
                      onClick={() => cycleTooth(n)}
                      title={`Tooth ${n} — ${cell.label}`}
                      className={`flex h-12 flex-col items-center justify-center rounded-lg border text-xs font-semibold transition-colors ${cell.cell}`}
                    >
                      {n}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-ink-400">Universal numbering · upper arch 1–16, lower arch 17–32.</p>
        </Card>
      )}

      {tab === "ledger" && (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200 px-5 py-4">
            <div>
              <h3 className="font-semibold text-ink-900">Account ledger</h3>
              <p className="text-sm text-ink-500">Charges, payments and adjustments with a running balance.</p>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right">
                <p className="text-xs text-ink-400">Account balance</p>
                <p className={`text-lg font-semibold ${ledgerBalance > 0 ? "text-rose-500" : "text-emerald-600"}`}>{formatMoney(ledgerBalance)}</p>
              </div>
              <button
                onClick={() => setAdjustModal(true)}
                className="flex items-center gap-2 rounded-xl border border-ink-200 px-3.5 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"
              >
                <Plus className="h-4 w-4" /> Adjustment
              </button>
              <button
                onClick={() => toast(`Statement for ${patient.name} queued — it emails/prints once billing delivery is connected.`, "info")}
                className="flex items-center gap-2 rounded-xl bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700"
              >
                <Receipt className="h-4 w-4" /> Statement
              </button>
            </div>
          </div>
          {ledger.length ? (
            <table className="w-full text-left text-sm">
              <thead className="border-b border-ink-200 bg-ink-50 text-xs font-semibold uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-5 py-2.5">Date</th>
                  <th className="px-4 py-2.5">Description</th>
                  <th className="px-4 py-2.5 text-right">Charge</th>
                  <th className="px-4 py-2.5 text-right">Payment</th>
                  <th className="px-4 py-2.5 text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((r, i) => (
                  <tr key={i} className="border-b border-ink-100 last:border-0">
                    <td className="px-5 py-3 text-ink-600">{r.date}</td>
                    <td className="px-4 py-3 text-ink-900">{r.description}</td>
                    <td className="px-4 py-3 text-right text-ink-700">{r.charge ? formatMoney(r.charge) : "—"}</td>
                    <td className="px-4 py-3 text-right text-emerald-600">{r.credit ? formatMoney(r.credit) : "—"}</td>
                    <td className={`px-4 py-3 text-right font-medium ${r.balance > 0 ? "text-rose-500" : "text-ink-900"}`}>{formatMoney(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="py-8 text-center text-sm text-ink-500">No ledger activity yet — charges appear as procedures complete and payments are collected.</p>
          )}
        </Card>
      )}

      {tab === "claims" && (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200 px-5 py-4">
            <div>
              <h3 className="font-semibold text-ink-900">Insurance claims</h3>
              <p className="text-sm text-ink-500">Track each claim from draft to paid. Advance the status as the payer responds.</p>
            </div>
            <button
              onClick={() => setClaimModal(true)}
              disabled={pInsurance.filter((i) => i.carrier && i.carrier !== "—").length === 0}
              className="flex items-center gap-2 rounded-xl bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
              title={pInsurance.length === 0 ? "Add an insurance policy first" : "Create a claim"}
            >
              <FileCheck2 className="h-4 w-4" /> New claim
            </button>
          </div>
          {claims.length ? (
            <table className="w-full text-left text-sm">
              <thead className="border-b border-ink-200 bg-ink-50 text-xs font-semibold uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-5 py-2.5">Carrier</th>
                  <th className="px-4 py-2.5">Procedures</th>
                  <th className="px-4 py-2.5 text-right">Billed</th>
                  <th className="px-4 py-2.5 text-right">Est. insurance</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.id} className="border-b border-ink-100 last:border-0">
                    <td className="px-5 py-3 font-medium text-ink-900">{c.carrier}</td>
                    <td className="px-4 py-3 font-mono text-xs text-ink-600">{c.procedures}</td>
                    <td className="px-4 py-3 text-right text-ink-700">{formatMoney(c.billed)}</td>
                    <td className="px-4 py-3 text-right text-ink-700">{formatMoney(c.estInsurance)}</td>
                    <td className="px-4 py-3"><StatusBadge status={c.status} tone={claimTone[c.status]} /></td>
                    <td className="px-4 py-3 text-right">
                      {c.status !== "Paid" && (
                        <button
                          onClick={() => advanceClaim(c.id)}
                          className="inline-flex items-center gap-1 rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50"
                          title={`Mark as ${CLAIM_FLOW[CLAIM_FLOW.indexOf(c.status) + 1]}`}
                        >
                          {CLAIM_FLOW[CLAIM_FLOW.indexOf(c.status) + 1]} <ArrowRight className="h-3 w-3" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="py-8 text-center text-sm text-ink-500">No claims yet — create one from a completed procedure once insurance is on file.</p>
          )}
        </Card>
      )}

      {tab === "rx" && (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200 px-5 py-4">
            <div>
              <h3 className="font-semibold text-ink-900">Prescriptions</h3>
              <p className="text-sm text-ink-500">Medications written for {patient.name}.</p>
            </div>
            <button
              onClick={() => setRxModal(true)}
              className="flex items-center gap-2 rounded-xl bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              <Pill className="h-4 w-4" /> Write prescription
            </button>
          </div>
          {prescriptions.length ? (
            <ul className="divide-y divide-ink-100">
              {prescriptions.map((rx) => (
                <li key={rx.id} className="flex items-center justify-between gap-3 px-5 py-3.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink-900">{rx.drug}</p>
                    <p className="text-xs text-ink-500">{rx.sig} · Qty {rx.quantity} · {rx.refills} refills · {rx.date}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusBadge status={rx.status} tone={rxTone[rx.status]} />
                    <button
                      onClick={() => {
                        setPrescriptions((prev) => prev.filter((x) => x.id !== rx.id));
                        if (isLive) deletePrescription(rx.id);
                      }}
                      className="rounded-lg p-1.5 text-ink-400 hover:bg-rose-500/10 hover:text-rose-500"
                      title="Delete prescription"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-8 text-center text-sm text-ink-500">No prescriptions yet — write one with the button above.</p>
          )}
        </Card>
      )}

      {rxModal && (
        <WritePrescriptionModal
          patientName={patient.name}
          onClose={() => setRxModal(false)}
          onSave={async (rx) => {
            let id = `rx-${Date.now()}`;
            if (isLive) {
              const res = await createPrescription(patientId, rx);
              if (res.id) id = res.id;
            }
            setPrescriptions((prev) => [{ ...rx, id }, ...prev]);
            toast(`Prescription for ${rx.drug} added to ${patient.name}'s chart.`);
          }}
        />
      )}
      {claimModal && (
        <NewClaimModal
          carriers={pInsurance.filter((i) => i.carrier && i.carrier !== "—").map((i) => i.carrier)}
          procedures={pPlans.flatMap((pl) => pl.procedures)}
          onClose={() => setClaimModal(false)}
          onSave={async (c) => {
            let id = `claim-${Date.now()}`;
            if (isLive) {
              const res = await createClaim(patientId, c);
              if (res.id) id = res.id;
            }
            setClaims((prev) => [{ ...c, id }, ...prev]);
            toast(`Claim to ${c.carrier} created for ${formatMoney(c.billed)}.`);
          }}
        />
      )}
      {adjustModal && (
        <AdjustmentModal
          onClose={() => setAdjustModal(false)}
          onSave={async (adj) => {
            let id = `adj-${Date.now()}`;
            if (isLive) {
              const res = await addLedgerAdjustment(patientId, adj);
              if (res.id) id = res.id;
            }
            setLedgerAdj((prev) => [...prev, { ...adj, id }]);
            toast(`Adjustment recorded on ${patient.name}'s account.`);
          }}
        />
      )}
    </>
  );
}

function CollectPaymentModal({
  patientId,
  patientName,
  onClose,
  onSaved,
}: {
  patientId: string;
  patientName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("Card (Stripe)");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const value = Number(amount);
    if (!value || value <= 0) {
      setError("Enter a valid amount.");
      return;
    }
    setSaving(true);
    const res = await addPayment(patientId, value, method, description || "Payment collected at front desk");
    setSaving(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    toast(`${formatMoney(value)} recorded for ${patientName}.`);
    onSaved();
    onClose();
  }

  return (
    <Modal open onClose={onClose} title="Collect payment" subtitle={`Record a payment on ${patientName}'s chart. Card processing activates when Stripe is connected.`}>
      {error && <p className="mb-3 text-sm text-amber-600">{error}</p>}
      <div className="grid gap-4">
        <Field label="Amount ($)">
          <input type="number" min="0" step="0.01" className={inputCls} placeholder="120.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Method">
          <select className={inputCls} value={method} onChange={(e) => setMethod(e.target.value)}>
            <option>Card (Stripe)</option>
            <option>Cash</option>
            <option>Bank transfer</option>
            <option>Insurance</option>
            <option>Financing</option>
          </select>
        </Field>
        <Field label="Description">
          <input className={inputCls} placeholder="Cleaning copay" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
      <ModalFooter onClose={onClose} submitLabel={saving ? "Recording…" : "Record payment"} onSubmit={submit} />
    </Modal>
  );
}

function WritePrescriptionModal({
  patientName,
  onClose,
  onSave,
}: {
  patientName: string;
  onClose: () => void;
  onSave: (rx: Omit<Prescription, "id">) => void;
}) {
  const [drug, setDrug] = useState(COMMON_DRUGS[0]);
  const [sig, setSig] = useState("1 tablet three times daily for 7 days");
  const [quantity, setQuantity] = useState("21");
  const [refills, setRefills] = useState("0");
  const [sendToPharmacy, setSendToPharmacy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (!drug.trim() || !sig.trim()) {
      setError("Drug and instructions are required.");
      return;
    }
    onSave({
      drug: drug.trim(),
      sig: sig.trim(),
      quantity: quantity.trim() || "—",
      refills: Number(refills) || 0,
      date: todayISO(),
      status: sendToPharmacy ? "Sent to pharmacy" : "Active",
    });
    onClose();
  }

  return (
    <Modal open onClose={onClose} title="Write prescription" subtitle={`New medication for ${patientName}.`}>
      {error && <p className="mb-3 text-sm text-amber-600">{error}</p>}
      <div className="grid gap-4">
        <Field label="Medication">
          <input className={inputCls} list="common-drugs" value={drug} onChange={(e) => setDrug(e.target.value)} placeholder="Amoxicillin 500mg" />
          <datalist id="common-drugs">
            {COMMON_DRUGS.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </Field>
        <Field label="Sig (directions)">
          <input className={inputCls} value={sig} onChange={(e) => setSig(e.target.value)} placeholder="1 capsule three times daily for 7 days" />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Quantity">
            <input className={inputCls} value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="21" />
          </Field>
          <Field label="Refills">
            <input className={inputCls} type="number" min="0" value={refills} onChange={(e) => setRefills(e.target.value)} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input type="checkbox" checked={sendToPharmacy} onChange={(e) => setSendToPharmacy(e.target.checked)} className="h-4 w-4 accent-brand-600" />
          Send electronically to the patient&apos;s pharmacy
        </label>
      </div>
      <ModalFooter onClose={onClose} submitLabel="Add prescription" onSubmit={submit} />
    </Modal>
  );
}

function NewClaimModal({
  carriers,
  procedures,
  onClose,
  onSave,
}: {
  carriers: string[];
  procedures: { code: string; description: string; fee: number; status: string }[];
  onClose: () => void;
  onSave: (c: Omit<Claim, "id">) => void;
}) {
  const [carrier, setCarrier] = useState(carriers[0] ?? "");
  const [selected, setSelected] = useState<Set<number>>(new Set(procedures.map((_, i) => i)));
  const [error, setError] = useState<string | null>(null);

  const chosen = procedures.filter((_, i) => selected.has(i));
  const billed = chosen.reduce((s, p) => s + p.fee, 0);

  function toggle(i: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  function submit() {
    if (!carrier) {
      setError("Choose an insurance carrier.");
      return;
    }
    if (chosen.length === 0) {
      setError("Select at least one procedure to bill.");
      return;
    }
    const codes = chosen.slice(0, 3).map((p) => p.code).join(", ") + (chosen.length > 3 ? ` +${chosen.length - 3}` : "");
    onSave({ carrier, procedures: codes, billed, estInsurance: Math.round(billed * 0.5), status: "Draft" });
    onClose();
  }

  return (
    <Modal open onClose={onClose} title="New insurance claim" subtitle="Bill selected procedures to the patient's carrier.">
      {error && <p className="mb-3 text-sm text-amber-600">{error}</p>}
      <div className="grid gap-4">
        <Field label="Carrier">
          <select className={inputCls} value={carrier} onChange={(e) => setCarrier(e.target.value)}>
            {carriers.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Procedures to bill">
          {procedures.length ? (
            <div className="max-h-52 space-y-1.5 overflow-y-auto rounded-xl border border-ink-200 p-2">
              {procedures.map((p, i) => (
                <label key={i} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-ink-50">
                  <span className="flex items-center gap-2">
                    <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)} className="h-4 w-4 accent-brand-600" />
                    <span className="font-mono text-xs text-ink-500">{p.code}</span>
                    <span className="text-ink-800">{p.description}</span>
                  </span>
                  <span className="font-medium text-ink-900">{formatMoney(p.fee)}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="text-sm text-ink-500">No procedures on the treatment plan to bill.</p>
          )}
        </Field>
        <div className="flex items-center justify-between rounded-xl bg-ink-50 px-4 py-3 text-sm">
          <span className="text-ink-600">Billed total · est. insurance (50%)</span>
          <span className="font-semibold text-ink-900">{formatMoney(billed)} · {formatMoney(Math.round(billed * 0.5))}</span>
        </div>
      </div>
      <ModalFooter onClose={onClose} submitLabel="Create claim" onSubmit={submit} />
    </Modal>
  );
}

function AdjustmentModal({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (adj: { date: string; description: string; amount: number }) => void;
}) {
  const [kind, setKind] = useState<"charge" | "credit">("charge");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const value = Number(amount);
    if (!value || value <= 0) {
      setError("Enter a valid amount.");
      return;
    }
    onSave({
      date: todayISO(),
      description: description.trim() || (kind === "charge" ? "Account charge" : "Account credit"),
      amount: kind === "charge" ? value : -value,
    });
    onClose();
  }

  return (
    <Modal open onClose={onClose} title="Account adjustment" subtitle="Add a manual charge or credit to the ledger.">
      {error && <p className="mb-3 text-sm text-amber-600">{error}</p>}
      <div className="grid gap-4">
        <Field label="Type">
          <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as "charge" | "credit")}>
            <option value="charge">Charge (increases balance)</option>
            <option value="credit">Credit / write-off (decreases balance)</option>
          </select>
        </Field>
        <Field label="Amount ($)">
          <input type="number" min="0" step="0.01" className={inputCls} placeholder="50.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Description">
          <input className={inputCls} placeholder="Courtesy adjustment" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
      <ModalFooter onClose={onClose} submitLabel="Add adjustment" onSubmit={submit} />
    </Modal>
  );
}
