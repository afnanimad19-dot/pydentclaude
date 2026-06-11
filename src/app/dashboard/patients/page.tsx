"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Users, CalendarClock, BellRing, Database, Plus, CalendarPlus } from "lucide-react";
import { Card, PageHeader, DemoBanner, StatCard, StatusBadge, Avatar } from "@/components/ui";
import { NewPatientModal, NewAppointmentModal } from "@/components/dashboard/create-modals";
import { fetchPatients, fetchAppointments, type DataSource } from "@/lib/db";
import {
  patients as mockPatients,
  appointments as mockAppointments,
  type Patient,
  type Appointment,
} from "@/lib/mock-data";

const aptTone = { Confirmed: "green", Scheduled: "blue", Unconfirmed: "amber", Completed: "gray", Broken: "red" } as const;

function LiveBanner() {
  return (
    <div className="mb-6 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-600">
      <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500" />
      <span>
        <strong className="font-semibold">Live database</strong> — patients and appointments are
        reading and writing to your Supabase project in real time.
      </span>
    </div>
  );
}

export default function PatientsPage() {
  const [patientModal, setPatientModal] = useState(false);
  const [aptModal, setAptModal] = useState(false);
  const [patients, setPatients] = useState<Patient[]>(mockPatients);
  const [appointments, setAppointments] = useState<Appointment[]>(mockAppointments);
  const [source, setSource] = useState<DataSource>("demo");

  const refresh = useCallback(() => {
    fetchPatients().then((r) => {
      setPatients(r.patients);
      setSource(r.source);
    });
    fetchAppointments().then((r) => setAppointments(r.appointments));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const recallDue = patients.filter((p) => p.recallDue);

  return (
    <>
      <NewPatientModal open={patientModal} onClose={() => setPatientModal(false)} onCreated={refresh} />
      <NewAppointmentModal
        open={aptModal}
        onClose={() => setAptModal(false)}
        patientOptions={patients.map((p) => ({ id: p.id, name: p.name }))}
        onCreated={refresh}
      />
      {source === "live" ? (
        <LiveBanner />
      ) : (
        <DemoBanner context="Database not reachable — showing the bundled sample roster." />
      )}
      <PageHeader
        title="Patients"
        subtitle="Roster, schedule, recalls — click any patient for their full profile."
        actions={
          <>
            <span className="hidden items-center gap-2 rounded-xl border border-ink-200 bg-surface px-3.5 py-2 text-xs font-medium text-ink-500 md:flex">
              <Database className="h-4 w-4 text-brand-500" />
              {source === "live" ? "Supabase · live" : "Demo data"}
            </span>
            <button
              onClick={() => setAptModal(true)}
              className="flex items-center gap-2 rounded-xl border border-ink-200 bg-surface px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"
            >
              <CalendarPlus className="h-4 w-4" /> New appointment
            </button>
            <button
              onClick={() => setPatientModal(true)}
              className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" /> New patient
            </button>
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          icon={Users}
          label="Patients on file"
          value={String(patients.length)}
          hint={`${patients.filter((p) => p.status === "New").length} new`}
          accent="brand"
        />
        <StatCard
          icon={BellRing}
          label="Recall due"
          value={String(recallDue.length)}
          hint="auto-enrolled in recall flow"
          accent="amber"
        />
        <StatCard
          icon={CalendarClock}
          label="Upcoming appointments"
          value={String(appointments.length)}
          hint={`${appointments.filter((a) => a.status === "Unconfirmed").length} unconfirmed`}
          accent="violet"
        />
      </div>

      <Card className="mt-6 overflow-hidden">
        <div className="border-b border-ink-200 px-5 py-4">
          <h2 className="font-semibold text-ink-900">Patient roster</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink-200 bg-ink-50 text-xs font-semibold uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-5 py-3">Patient</th>
                <th className="px-4 py-3">Contact</th>
                <th className="px-4 py-3">Insurance</th>
                <th className="px-4 py-3">Last visit</th>
                <th className="px-4 py-3">Next appt</th>
                <th className="px-4 py-3 text-right">Balance</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {patients.map((p) => (
                <tr key={p.id} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/60">
                  <td className="px-5 py-3.5">
                    <Link href={`/dashboard/patients/${p.id}`} className="flex items-center gap-3">
                      <Avatar name={p.name} size="sm" />
                      <div>
                        <p className="font-medium text-ink-900 hover:text-brand-600">{p.name}</p>
                        <p className="text-xs text-ink-400">PatNum {p.patNum}</p>
                      </div>
                    </Link>
                  </td>
                  <td className="px-4 py-3.5">
                    <p className="text-ink-700">{p.phone}</p>
                    <p className="text-xs text-ink-400">{p.email}</p>
                  </td>
                  <td className="px-4 py-3.5 text-ink-700">{p.insurance}</td>
                  <td className="px-4 py-3.5 text-ink-700">{p.lastVisit}</td>
                  <td className="px-4 py-3.5">
                    {p.nextAppointment ? (
                      <span className="text-ink-700">{p.nextAppointment}</span>
                    ) : p.recallDue ? (
                      <StatusBadge status="Recall due" tone="amber" />
                    ) : (
                      <span className="text-ink-400">—</span>
                    )}
                  </td>
                  <td className={`px-4 py-3.5 text-right font-medium ${p.balance > 0 ? "text-rose-500" : "text-ink-700"}`}>
                    ${p.balance.toFixed(2)}
                  </td>
                  <td className="px-4 py-3.5">
                    <StatusBadge status={p.status} tone={p.status === "Active" ? "green" : p.status === "New" ? "blue" : "gray"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-6 grid gap-4 xl:grid-cols-2">
        <Card className="scroll-mt-20 p-5" id="appointments">
          <h2 className="mb-4 font-semibold text-ink-900">Upcoming appointments</h2>
          <ul className="space-y-2.5">
            {appointments.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 rounded-xl border border-ink-100 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink-900">
                    {a.patientName} <span className="font-normal text-ink-400">· AptNum {a.aptNum}</span>
                  </p>
                  <p className="text-xs text-ink-500">
                    {a.procedure} · {a.date} {a.time} · {a.provider} · {a.operatory}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {a.confirmedVia && (
                    <span className="text-[11px] text-ink-400">confirmed via {a.confirmedVia}</span>
                  )}
                  <StatusBadge status={a.status} tone={aptTone[a.status]} />
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="scroll-mt-20 p-5" id="recall">
          <h2 className="mb-1 font-semibold text-ink-900">Recall worklist</h2>
          <p className="mb-4 text-sm text-ink-500">
            Patients overdue for hygiene — automatically enrolled in the WhatsApp recall flow.
          </p>
          <ul className="space-y-2.5">
            {recallDue.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
                <div className="flex items-center gap-3">
                  <Avatar name={p.name} size="sm" />
                  <div>
                    <p className="text-sm font-medium text-ink-900">{p.name}</p>
                    <p className="text-xs text-ink-500">Last visit {p.lastVisit} · {p.phone}</p>
                  </div>
                </div>
                <button className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700">
                  Send recall
                </button>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
