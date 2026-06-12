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
} from "lucide-react";
import { Card, DemoBanner, StatusBadge, Avatar } from "@/components/ui";
import { Modal, Field, ModalFooter, inputCls } from "@/components/modal";
import { NewAppointmentModal } from "@/components/dashboard/create-modals";
import { toast } from "@/components/toast";
import { fetchPatientBundle, addDocument, addPayment, type PatientBundle } from "@/lib/db";
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

type Tab = "overview" | "appointments" | "treatment" | "documents" | "insurance" | "payments";

const tabs: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "appointments", label: "Appointments" },
  { key: "treatment", label: "Treatment plans" },
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
            className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
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
