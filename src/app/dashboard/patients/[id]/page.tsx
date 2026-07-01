"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CalendarPlus,
  Stethoscope,
  MessageCircle,
} from "lucide-react";
import { Card, DemoBanner, StatusBadge, Avatar } from "@/components/ui";
import { NewAppointmentModal } from "@/components/dashboard/create-modals";
import { useClinicalModules, ToothChartCard, LedgerCard, ClaimsCard, RxCard } from "@/components/dashboard/clinical";
import { CLINICAL_MODULES_ENABLED } from "@/lib/features";
import { fetchPatientBundle, type PatientBundle } from "@/lib/db";

type Tab =
  | "overview"
  | "chart"
  | "appointments"
  | "ledger"
  | "claims"
  | "rx";

const tabs: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "chart", label: "Tooth chart" },
  { key: "appointments", label: "Appointments" },
  { key: "ledger", label: "Account / Ledger" },
  { key: "claims", label: "Claims" },
  { key: "rx", label: "Prescriptions" },
];

const aptTone = { Confirmed: "green", Scheduled: "blue", Unconfirmed: "amber", Completed: "gray", Broken: "red" } as const;

export default function PatientProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [tab, setTab] = useState<Tab>("overview");
  const [aptModal, setAptModal] = useState(false);
  const [bundle, setBundle] = useState<PatientBundle | null | "loading">("loading");

  // Tooth chart, ledger, claims and prescriptions — shared with the Patient
  // chart sidebar pages so both stay in sync.
  const mods = useClinicalModules(bundle);

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

  const { patient, appointments: pAppointments, plans: pPlans, insurance: pInsurance } = bundle;

  return (
    <>
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
            ["Last visit", patient.lastVisit],
            ["Next appointment", patient.nextAppointment ?? "None scheduled"],
          ].map(([k, v]) => (
            <div key={k}>
              <p className="text-xs text-ink-400">{k}</p>
              <p className="mt-0.5 text-sm font-medium text-ink-900">{v}</p>
            </div>
          ))}
        </div>
      </Card>

      <div className="mb-5 flex flex-wrap gap-1 rounded-xl border border-ink-200 bg-surface p-1">
        {tabs
          .filter((t) => CLINICAL_MODULES_ENABLED || !["chart", "ledger", "claims", "rx"].includes(t.key))
          .map((t) => (
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
              <li>Preferred channel: WhatsApp</li>
            </ul>
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

      {tab === "chart" && <ToothChartCard toothState={mods.toothState} onCycle={mods.cycleTooth} />}

      {tab === "ledger" && (
        <LedgerCard patientName={patient.name} ledger={mods.ledger} balance={mods.ledgerBalance} onAddAdjustment={mods.addAdjustment} onDeleteAdjustment={mods.deleteAdjustment} />
      )}

      {tab === "claims" && (
        <ClaimsCard
          carriers={pInsurance.filter((i) => i.carrier && i.carrier !== "—").map((i) => i.carrier)}
          procedures={pPlans.flatMap((pl) => pl.procedures)}
          claims={mods.claims}
          onAdvance={mods.advanceClaim}
          onCreate={mods.createClaim}
          onDelete={mods.deleteClaim}
        />
      )}

      {tab === "rx" && (
        <RxCard patientName={patient.name} prescriptions={mods.prescriptions} onCreate={mods.createRx} onDelete={mods.deleteRx} />
      )}
    </>
  );
}
