"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { Card, PageHeader } from "@/components/ui";
import { Modal } from "@/components/modal";
import { NewAppointmentModal } from "@/components/dashboard/create-modals";
import { fetchAppointments, fetchPatients } from "@/lib/db";
import { type Appointment, type Patient } from "@/lib/mock-data";

const HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function mondayOf(d: Date): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() - ((out.getUTCDay() + 6) % 7));
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// 3 months back to 12 months ahead, for the jump-to-month dropdown.
function monthOptions(): { value: string; label: string }[] {
  const now = new Date();
  const out: { value: string; label: string }[] = [];
  for (let i = -3; i <= 12; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    out.push({ value: iso(d), label: d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) });
  }
  return out;
}

const STATUS_STYLES: Record<Appointment["status"], string> = {
  Confirmed: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  Scheduled: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  Unconfirmed: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  Completed: "border-ink-300 bg-ink-100 text-ink-600",
  Broken: "border-rose-500/40 bg-rose-500/10 text-rose-600",
};

export default function CalendarPage() {
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [aptModal, setAptModal] = useState(false);
  const [selected, setSelected] = useState<Appointment | null>(null);
  const months = monthOptions();

  const refresh = useCallback(() => {
    fetchAppointments().then((r) => setAppointments(r.appointments));
    fetchPatients().then((r) => setPatients(r.patients));
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const days = DAY_NAMES.map((_, i) => {
    const d = new Date(weekStart);
    d.setUTCDate(d.getUTCDate() + i);
    return d;
  });

  function shiftWeek(delta: number) {
    setWeekStart((prev) => {
      const next = new Date(prev);
      next.setUTCDate(next.getUTCDate() + delta * 7);
      return next;
    });
  }

  function aptsAt(date: string, hour: number): Appointment[] {
    return appointments.filter((a) => a.date === date && parseInt(a.time, 10) === hour);
  }

  const monthValue = iso(new Date(Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), 1)));
  const selectedPatient = selected?.patientId ? patients.find((p) => p.id === selected.patientId) : undefined;

  return (
    <>
      <NewAppointmentModal
        open={aptModal}
        onClose={() => setAptModal(false)}
        patientOptions={patients.map((p) => ({ id: p.id, name: p.name }))}
        onCreated={refresh}
      />
      {selected && (
        <Modal open onClose={() => setSelected(null)} title={selected.patientName} subtitle={`${selected.procedure}`}>
          <div className="grid gap-3 text-sm">
            <div className="flex items-center justify-between rounded-xl bg-ink-50 px-4 py-3">
              <span className="text-ink-500">When</span>
              <span className="font-medium text-ink-900">{selected.date} · {selected.time}</span>
            </div>
            {[
              ["Reason", selected.procedure],
              ["Provider", selected.provider || "—"],
              ["Operatory", selected.operatory || "—"],
              ["Status", selected.status],
              ["Phone", selectedPatient?.phone || "—"],
              ["Email", selectedPatient?.email || "—"],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between border-b border-ink-100 pb-2 last:border-0">
                <span className="text-ink-500">{k}</span>
                <span className="font-medium text-ink-900">{v}</span>
              </div>
            ))}
            {selectedPatient && (
              <a href={`/dashboard/patients/${selectedPatient.id}`} className="mt-1 rounded-xl bg-brand-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-brand-700">
                Open patient chart →
              </a>
            )}
          </div>
        </Modal>
      )}
      <div className="mb-6 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-600">
        <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500" />
        <span><strong className="font-semibold">Live schedule</strong> — every booking (including from chat) appears here.</span>
      </div>
      <PageHeader
        title="Calendar"
        subtitle="The clinic schedule at a glance — click any appointment for the patient's details."
        actions={
          <button
            onClick={() => setAptModal(true)}
            className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" /> New appointment
          </button>
        }
      />

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-200 px-5 py-3.5">
          <select
            value={months.some((m) => m.value === monthValue) ? monthValue : ""}
            onChange={(e) => e.target.value && setWeekStart(mondayOf(new Date(e.target.value)))}
            className="rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-sm font-semibold text-ink-900 outline-none focus:border-brand-400"
          >
            {!months.some((m) => m.value === monthValue) && (
              <option value="">{weekStart.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}</option>
            )}
            {months.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <div className="flex items-center gap-1">
            <button onClick={() => shiftWeek(-1)} className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-50">
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button onClick={() => setWeekStart(mondayOf(new Date()))} className="rounded-lg border border-ink-200 px-3 py-1 text-xs font-medium text-ink-600 hover:bg-ink-50">
              Today
            </button>
            <button onClick={() => shiftWeek(1)} className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-50">
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <div className="grid min-w-[800px] grid-cols-[56px_repeat(6,1fr)]">
            {/* Header row */}
            <div className="border-b border-ink-200 bg-ink-50" />
            {days.map((d, i) => (
              <div key={i} className="border-b border-l border-ink-200 bg-ink-50 px-2 py-2.5 text-center">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">{DAY_NAMES[i]}</p>
                <p className="text-sm font-semibold text-ink-900">{d.getUTCDate()} {d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })}</p>
              </div>
            ))}

            {/* Hour rows */}
            {HOURS.map((h) => (
              <div key={h} className="contents">
                <div className="border-b border-ink-100 px-2 py-1 text-right text-[11px] text-ink-400">
                  {h <= 12 ? `${h}:00` : `${h - 12}:00`} {h < 12 ? "AM" : "PM"}
                </div>
                {days.map((d, i) => {
                  const date = iso(d);
                  const slotApts = aptsAt(date, h);
                  return (
                    <div
                      key={i}
                      onClick={() => slotApts.length === 0 && setAptModal(true)}
                      className="min-h-14 cursor-pointer border-b border-l border-ink-100 p-1 transition-colors hover:bg-ink-50/60"
                    >
                      {slotApts.map((a) => (
                        <button
                          key={a.id}
                          onClick={(e) => { e.stopPropagation(); setSelected(a); }}
                          title={`${a.patientName} — ${a.procedure}`}
                          className={`mb-1 block w-full rounded-lg border px-2 py-1 text-left text-[11px] font-medium leading-tight ${STATUS_STYLES[a.status]}`}
                        >
                          <p className="truncate font-semibold">{a.time} · {a.patientName}</p>
                          <p className="truncate opacity-80">{a.procedure}</p>
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 border-t border-ink-200 px-5 py-3 text-xs text-ink-500">
          {(["Scheduled", "Unconfirmed", "Completed", "Broken"] as Appointment["status"][]).map((s) => (
            <span key={s} className="flex items-center gap-1.5">
              <span className={`inline-block h-2.5 w-2.5 rounded-full border ${STATUS_STYLES[s]}`} /> {s === "Broken" ? "Cancelled" : s}
            </span>
          ))}
        </div>
      </Card>
    </>
  );
}
