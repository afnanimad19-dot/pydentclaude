"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LayoutGrid, Receipt, FileCheck2, Pill, Plus, ArrowRight, Trash2, Users, Stethoscope } from "lucide-react";
import { Card, StatusBadge } from "@/components/ui";
import { Modal, Field, ModalFooter, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import {
  fetchPatients,
  fetchPatientBundle,
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
  type ToothCondition,
  type LedgerAdjustment,
  type ClaimRecord,
  type PrescriptionRecord,
} from "@/lib/db";
import { formatMoney, type Patient } from "@/lib/mock-data";
import { CLINICAL_MODULES_ENABLED } from "@/lib/features";

// ----------------------------------------------------------------- constants

export const TOOTH_CONDITIONS: { key: ToothCondition; label: string; dot: string; cell: string }[] = [
  { key: "healthy", label: "Healthy", dot: "bg-ink-300", cell: "border-ink-200 bg-surface text-ink-700" },
  { key: "planned", label: "Treatment planned", dot: "bg-amber-500", cell: "border-amber-400 bg-amber-500/15 text-amber-700" },
  { key: "completed", label: "Completed", dot: "bg-emerald-500", cell: "border-emerald-400 bg-emerald-500/15 text-emerald-700" },
  { key: "watch", label: "Watch", dot: "bg-sky-500", cell: "border-sky-400 bg-sky-500/15 text-sky-700" },
  { key: "missing", label: "Missing / extracted", dot: "bg-rose-500", cell: "border-rose-300 bg-rose-500/10 text-rose-400 line-through" },
];
const CONDITION_ORDER: ToothCondition[] = ["healthy", "planned", "completed", "watch", "missing"];
const UPPER_TEETH = Array.from({ length: 16 }, (_, i) => i + 1); // 1–16
const LOWER_TEETH = Array.from({ length: 16 }, (_, i) => 32 - i); // 32–17
function conditionCell(c: ToothCondition) {
  return TOOTH_CONDITIONS.find((t) => t.key === c) ?? TOOTH_CONDITIONS[0];
}

const CLAIM_FLOW: ClaimRecord["status"][] = ["Draft", "Sent", "Received", "Paid"];
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

export interface LedgerRow {
  date: string;
  description: string;
  charge: number;
  credit: number;
  balance: number;
}

// ------------------------------------------------------------------ the hook

export function useClinicalModules(bundle: PatientBundle | null | "loading") {
  const [toothState, setToothState] = useState<Record<number, ToothCondition>>({});
  const [prescriptions, setPrescriptions] = useState<PrescriptionRecord[]>([]);
  const [claims, setClaims] = useState<ClaimRecord[]>([]);
  const [ledgerAdj, setLedgerAdj] = useState<LedgerAdjustment[]>([]);
  const seededRef = useRef<string | null>(null);

  useEffect(() => {
    if (bundle === "loading" || !bundle) return;
    if (seededRef.current === bundle.patient.id) return;
    seededRef.current = bundle.patient.id;
    const live = bundle.source === "live";
    const pid = bundle.patient.id;

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

    const claimsSeed: ClaimRecord[] = [];
    const realIns = bundle.insurance.filter((i) => i.carrier && i.carrier !== "—" && i.annualMax > 0);
    const billableProcs = bundle.plans.flatMap((pl) => pl.procedures).filter((pr) => pr.status !== "Planned");
    if (realIns.length && billableProcs.length) {
      const billed = billableProcs.reduce((s, p) => s + p.fee, 0);
      const codes = billableProcs.slice(0, 3).map((p) => p.code).join(", ") + (billableProcs.length > 3 ? ` +${billableProcs.length - 3}` : "");
      claimsSeed.push({ id: "claim-seed-1", carrier: realIns[0].carrier, procedures: codes, billed, estInsurance: Math.round(billed * 0.5), status: "Sent" });
    }
    /* eslint-disable react-hooks/set-state-in-effect -- seeding editable demo state from the loaded chart */
    setToothState(teeth);
    setClaims(claimsSeed);
    setPrescriptions(
      bundle.plans.length
        ? [{ id: "rx-seed-1", drug: "Amoxicillin 500mg", sig: "1 capsule three times daily for 7 days", quantity: "21", refills: 0, date: todayISO(), status: "Sent to pharmacy" }]
        : []
    );
    setLedgerAdj([]);
    /* eslint-enable react-hooks/set-state-in-effect */
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
    let newStatus: ClaimRecord["status"] | null = null;
    setClaims((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        newStatus = CLAIM_FLOW[Math.min(CLAIM_FLOW.indexOf(c.status) + 1, CLAIM_FLOW.length - 1)];
        return { ...c, status: newStatus };
      })
    );
    if (isLive && newStatus) updateClaimStatus(id, newStatus);
  }

  async function createClaimRec(c: Omit<ClaimRecord, "id">) {
    let id = `claim-${Date.now()}`;
    if (isLive) {
      const res = await createClaim(patientId, c);
      if (res.id) id = res.id;
    }
    setClaims((prev) => [{ ...c, id }, ...prev]);
    toast(`Claim to ${c.carrier} created for ${formatMoney(c.billed)}.`);
  }

  async function createRx(rx: Omit<PrescriptionRecord, "id">) {
    let id = `rx-${Date.now()}`;
    if (isLive) {
      const res = await createPrescription(patientId, rx);
      if (res.id) id = res.id;
    }
    setPrescriptions((prev) => [{ ...rx, id }, ...prev]);
    toast(`Prescription for ${rx.drug} added to the chart.`);
  }

  function deleteRx(id: string) {
    setPrescriptions((prev) => prev.filter((x) => x.id !== id));
    if (isLive) deletePrescription(id);
  }

  async function addAdjustment(adj: Omit<LedgerAdjustment, "id">) {
    let id = `adj-${Date.now()}`;
    if (isLive) {
      const res = await addLedgerAdjustment(patientId, adj);
      if (res.id) id = res.id;
    }
    setLedgerAdj((prev) => [...prev, { ...adj, id }]);
    toast("Adjustment recorded on the account.");
  }

  // Running-balance ledger from procedure charges, payments and adjustments.
  let ledger: LedgerRow[] = [];
  if (bundle !== "loading" && bundle) {
    const rows: Omit<LedgerRow, "balance">[] = [];
    bundle.plans.forEach((pl) =>
      pl.procedures
        .filter((pr) => pr.status !== "Planned")
        .forEach((pr) => rows.push({ date: pl.presentedOn || bundle.patient.lastVisit, description: `${pr.code} · ${pr.description}${pr.tooth ? ` (#${pr.tooth})` : ""}`, charge: pr.fee, credit: 0 }))
    );
    bundle.payments.forEach((p2) => rows.push({ date: p2.date, description: `${p2.description || "Payment"} · ${p2.method}`, charge: 0, credit: p2.amount }));
    ledgerAdj.forEach((a) => rows.push({ date: a.date, description: a.description, charge: a.amount >= 0 ? a.amount : 0, credit: a.amount < 0 ? -a.amount : 0 }));
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    let bal = 0;
    ledger = rows.map((r) => {
      bal += r.charge - r.credit;
      return { ...r, balance: bal };
    });
  }
  const ledgerBalance = ledger.length ? ledger[ledger.length - 1].balance : bundle !== "loading" && bundle ? bundle.patient.balance : 0;

  return { toothState, cycleTooth, prescriptions, createRx, deleteRx, claims, advanceClaim, createClaim: createClaimRec, ledger, ledgerBalance, addAdjustment };
}

type Modules = ReturnType<typeof useClinicalModules>;

// ------------------------------------------------------------ module cards

export function ToothChartCard({ toothState, onCycle }: { toothState: Modules["toothState"]; onCycle: Modules["cycleTooth"] }) {
  return (
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
                  onClick={() => onCycle(n)}
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
  );
}

export function LedgerCard({ patientName, ledger, balance, onAddAdjustment }: { patientName: string; ledger: Modules["ledger"]; balance: number; onAddAdjustment: Modules["addAdjustment"] }) {
  const [adjustModal, setAdjustModal] = useState(false);
  return (
    <>
      {adjustModal && <AdjustmentModal onClose={() => setAdjustModal(false)} onSave={onAddAdjustment} />}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200 px-5 py-4">
          <div>
            <h3 className="font-semibold text-ink-900">Account ledger</h3>
            <p className="text-sm text-ink-500">Charges, payments and adjustments with a running balance.</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-xs text-ink-400">Account balance</p>
              <p className={`text-lg font-semibold ${balance > 0 ? "text-rose-500" : "text-emerald-600"}`}>{formatMoney(balance)}</p>
            </div>
            <button onClick={() => setAdjustModal(true)} className="flex items-center gap-2 rounded-xl border border-ink-200 px-3.5 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50">
              <Plus className="h-4 w-4" /> Adjustment
            </button>
            <button onClick={() => toast(`Statement for ${patientName} queued — it emails/prints once billing delivery is connected.`, "info")} className="flex items-center gap-2 rounded-xl bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700">
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
    </>
  );
}

export function ClaimsCard({
  carriers,
  procedures,
  claims,
  onAdvance,
  onCreate,
}: {
  carriers: string[];
  procedures: { code: string; description: string; fee: number; status: string }[];
  claims: Modules["claims"];
  onAdvance: Modules["advanceClaim"];
  onCreate: Modules["createClaim"];
}) {
  const [claimModal, setClaimModal] = useState(false);
  return (
    <>
      {claimModal && <NewClaimModal carriers={carriers} procedures={procedures} onClose={() => setClaimModal(false)} onSave={onCreate} />}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200 px-5 py-4">
          <div>
            <h3 className="font-semibold text-ink-900">Insurance claims</h3>
            <p className="text-sm text-ink-500">Track each claim from draft to paid. Advance the status as the payer responds.</p>
          </div>
          <button
            onClick={() => setClaimModal(true)}
            disabled={carriers.length === 0}
            className="flex items-center gap-2 rounded-xl bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
            title={carriers.length === 0 ? "Add an insurance policy first" : "Create a claim"}
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
                        onClick={() => onAdvance(c.id)}
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
    </>
  );
}

export function RxCard({ patientName, prescriptions, onCreate, onDelete }: { patientName: string; prescriptions: Modules["prescriptions"]; onCreate: Modules["createRx"]; onDelete: Modules["deleteRx"] }) {
  const [rxModal, setRxModal] = useState(false);
  return (
    <>
      {rxModal && <WritePrescriptionModal patientName={patientName} onClose={() => setRxModal(false)} onSave={onCreate} />}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200 px-5 py-4">
          <div>
            <h3 className="font-semibold text-ink-900">Prescriptions</h3>
            <p className="text-sm text-ink-500">Medications written for {patientName}.</p>
          </div>
          <button onClick={() => setRxModal(true)} className="flex items-center gap-2 rounded-xl bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700">
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
                  <button onClick={() => onDelete(rx.id)} className="rounded-lg p-1.5 text-ink-400 hover:bg-rose-500/10 hover:text-rose-500" title="Delete prescription">
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
    </>
  );
}

// ----------------------------------------------------------------- workspace

const MODULE_META = {
  chart: { title: "Tooth chart", subtitle: "Mark conditions and procedures tooth-by-tooth." },
  ledger: { title: "Account / Ledger", subtitle: "Charges, payments and balances per patient." },
  claims: { title: "Insurance claims", subtitle: "Bill carriers and track claims to payment." },
  rx: { title: "Prescriptions", subtitle: "Write and manage patient medications." },
} as const;

export function ClinicalWorkspace({ module }: { module: keyof typeof MODULE_META }) {
  if (!CLINICAL_MODULES_ENABLED) return <ClinicalDisabled />;
  return <ClinicalWorkspaceInner module={module} />;
}

function ClinicalDisabled() {
  return (
    <div className="mx-auto max-w-md py-24 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-ink-100 text-ink-500">
        <Stethoscope className="h-6 w-6" />
      </div>
      <h1 className="text-xl font-semibold text-ink-900">Clinical charting is coming soon</h1>
      <p className="mt-2 text-sm text-ink-500">
        Tooth chart, ledger, insurance claims and prescriptions unlock once your OpenDental
        connection is set up. Until then, everything else in Pydental works as normal.
      </p>
      <Link href="/dashboard" className="mt-5 inline-block rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
        Back to dashboard
      </Link>
    </div>
  );
}

function ClinicalWorkspaceInner({ module }: { module: keyof typeof MODULE_META }) {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [bundle, setBundle] = useState<PatientBundle | null | "loading">("loading");

  useEffect(() => {
    fetchPatients().then((r) => {
      setPatients(r.patients);
      setSelectedId((cur) => cur || r.patients[0]?.id || "");
    });
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    fetchPatientBundle(selectedId).then(setBundle);
  }, [selectedId]);

  const mods = useClinicalModules(bundle);
  const meta = MODULE_META[module];
  const patient = bundle !== "loading" && bundle ? bundle.patient : null;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-900">{meta.title}</h1>
          <p className="mt-1 text-sm text-ink-500">{meta.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-2 rounded-xl border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-500">
            <Users className="h-4 w-4 text-brand-500" /> Patient
          </span>
          <select
            value={selectedId}
            onChange={(e) => {
              setBundle("loading");
              setSelectedId(e.target.value);
            }}
            className="rounded-xl border border-ink-200 bg-surface px-3 py-2 text-sm font-medium text-ink-800 outline-none focus:border-brand-400"
          >
            {patients.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          {patient && (
            <Link href={`/dashboard/patients/${patient.id}`} className="rounded-xl border border-ink-200 px-3.5 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50">
              Full chart →
            </Link>
          )}
        </div>
      </div>

      {bundle === "loading" ? (
        <p className="py-20 text-center text-sm text-ink-500">Loading chart…</p>
      ) : !bundle ? (
        <p className="py-20 text-center text-sm text-ink-500">No patients found.</p>
      ) : (
        <>
          {module === "chart" && <ToothChartCard toothState={mods.toothState} onCycle={mods.cycleTooth} />}
          {module === "ledger" && <LedgerCard patientName={bundle.patient.name} ledger={mods.ledger} balance={mods.ledgerBalance} onAddAdjustment={mods.addAdjustment} />}
          {module === "claims" && (
            <ClaimsCard
              carriers={bundle.insurance.filter((i) => i.carrier && i.carrier !== "—").map((i) => i.carrier)}
              procedures={bundle.plans.flatMap((pl) => pl.procedures)}
              claims={mods.claims}
              onAdvance={mods.advanceClaim}
              onCreate={mods.createClaim}
            />
          )}
          {module === "rx" && <RxCard patientName={bundle.patient.name} prescriptions={mods.prescriptions} onCreate={mods.createRx} onDelete={mods.deleteRx} />}
        </>
      )}
    </>
  );
}

// -------------------------------------------------------------------- modals

function WritePrescriptionModal({ patientName, onClose, onSave }: { patientName: string; onClose: () => void; onSave: (rx: Omit<PrescriptionRecord, "id">) => void }) {
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
    onSave({ drug: drug.trim(), sig: sig.trim(), quantity: quantity.trim() || "—", refills: Number(refills) || 0, date: todayISO(), status: sendToPharmacy ? "Sent to pharmacy" : "Active" });
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
  onSave: (c: Omit<ClaimRecord, "id">) => void;
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

function AdjustmentModal({ onClose, onSave }: { onClose: () => void; onSave: (adj: Omit<LedgerAdjustment, "id">) => void }) {
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
    onSave({ date: todayISO(), description: description.trim() || (kind === "charge" ? "Account charge" : "Account credit"), amount: kind === "charge" ? value : -value });
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
