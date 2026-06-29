"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, CalendarCheck2, Check, CalendarClock, X } from "lucide-react";
import { Card, PageHeader } from "@/components/ui";
import { Modal, Field, inputCls } from "@/components/modal";
import { NewAppointmentModal } from "@/components/dashboard/create-modals";
import { BookingModal } from "@/components/dashboard/booking-modal";
import { toast } from "@/components/toast";
import { fetchAppointments, fetchPatients, updateAppointment, cancelAppointment } from "@/lib/db";
import { type Appointment, type Patient } from "@/lib/mock-data";

const HOURS = Array.from({ length: 24 }, (_, i) => i); // all 24 hours
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]; // full week

function mondayOf(d: Date): Date {
  // Start of the week = Sunday (we show Sun → Sat).
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() - out.getUTCDay());
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

// Friendly label for where a booking came from.
function sourceLabel(a: Appointment): string {
  const src = a.source ?? a.confirmedVia;
  const who = a.bookedBy ? ` — ${a.bookedBy}` : "";
  if (src === "voice") return `Calling agent${who}`;
  if (src === "manual") return `Front desk${a.bookedBy ? ` — ${a.bookedBy}` : ""}`;
  if (src === "whatsapp") return `Chat agent · WhatsApp${who}`;
  if (src === "instagram") return `Chat agent · Instagram${who}`;
  if (src === "messenger") return `Chat agent · Messenger${who}`;
  if (src === "sms") return `Chat agent · SMS${who}`;
  if (src === "email") return `Chat agent · Email${who}`;
  if (a.bookedBy) return a.bookedBy;
  return "—";
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
  const [view, setView] = useState<"week" | "15" | "30">("week");
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [aptModal, setAptModal] = useState(false);
  const [bookModal, setBookModal] = useState(false);
  const [selected, setSelected] = useState<Appointment | null>(null);
  const months = monthOptions();
  const rangeDays = view === "15" ? 15 : view === "30" ? 30 : 7;

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
      next.setUTCDate(next.getUTCDate() + delta * (view === "week" ? 7 : rangeDays));
      return next;
    });
  }

  // For the 15/30-day agenda: a flat list of days from the range start.
  const agendaDays = Array.from({ length: rangeDays }, (_, i) => {
    const d = new Date(weekStart);
    d.setUTCDate(d.getUTCDate() + i);
    return d;
  });
  function aptsOn(date: string): Appointment[] {
    return appointments.filter((a) => a.date === date).sort((a, b) => a.time.localeCompare(b.time));
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
      <BookingModal open={bookModal} onClose={() => setBookModal(false)} onBooked={refresh} />
      {selected && (
        <ApptDetail
          appt={selected}
          patient={selectedPatient}
          onClose={() => setSelected(null)}
          onChanged={() => { setSelected(null); refresh(); }}
        />
      )}
      <div className="mb-6 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-600">
        <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500" />
        <span><strong className="font-semibold">Live schedule</strong> — every booking (including from chat) appears here.</span>
      </div>
      <PageHeader
        title="Calendar"
        subtitle="The clinic schedule at a glance — click any appointment for the patient's details."
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => setBookModal(true)}
              className="flex items-center gap-2 rounded-xl border border-ink-200 px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"
            >
              <CalendarCheck2 className="h-4 w-4" /> Quick booking
            </button>
            <button
              onClick={() => setAptModal(true)}
              className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" /> New appointment
            </button>
          </div>
        }
      />

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-200 px-5 py-3.5">
          <div className="flex items-center gap-2">
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
            <select
              value={view}
              onChange={(e) => setView(e.target.value as typeof view)}
              className="rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-sm font-medium text-ink-700 outline-none focus:border-brand-400"
              title="How many days to show"
            >
              <option value="week">Week view</option>
              <option value="15">Next 15 days</option>
              <option value="30">Next 30 days</option>
            </select>
          </div>
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

        {view !== "week" ? (
          <div className="max-h-[calc(100vh-260px)] divide-y divide-ink-100 overflow-y-auto">
            {agendaDays.map((d, i) => {
              const date = iso(d);
              const dayApts = aptsOn(date);
              const isToday = date === iso(new Date());
              return (
                <div key={i} className="flex gap-4 px-5 py-3">
                  <div className={`w-28 shrink-0 ${isToday ? "text-brand-600 dark:text-brand-300" : "text-ink-700"}`}>
                    <p className="text-sm font-semibold">{d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })} {d.getUTCDate()}</p>
                    <p className="text-xs text-ink-400">{d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })}</p>
                  </div>
                  <div className="flex flex-1 flex-col gap-1.5">
                    {dayApts.length === 0 ? (
                      <button onClick={() => setAptModal(true)} className="self-start rounded-lg border border-dashed border-ink-200 px-3 py-1.5 text-xs text-ink-400 hover:border-brand-400 hover:text-brand-600">No appointments — add one</button>
                    ) : (
                      dayApts.map((a) => (
                        <button
                          key={a.id}
                          onClick={() => setSelected(a)}
                          className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm ${STATUS_STYLES[a.status]}`}
                        >
                          <span className="w-16 shrink-0 font-semibold">{a.time}</span>
                          <span className="flex-1 truncate"><span className="font-semibold">{a.patientName}</span> · {a.procedure}</span>
                          <span className="shrink-0 text-xs opacity-80">{a.status}</span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
        <div className="overflow-x-auto">
          <div className="grid min-w-[920px] grid-cols-[56px_repeat(7,1fr)]">
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
                  {((h % 12) || 12)}:00 {h < 12 ? "AM" : "PM"}
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
        )}

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

// Appointment detail with Confirm / Reschedule / Cancel actions.
function ApptDetail({ appt, patient, onClose, onChanged }: { appt: Appointment; patient?: Patient; onClose: () => void; onChanged: () => void }) {
  const [date, setDate] = useState(appt.date);
  const [time, setTime] = useState(appt.time);
  const [busy, setBusy] = useState(false);
  const isClosed = appt.status === "Completed" || appt.status === "Broken";

  async function setStatus(status: string) {
    setBusy(true);
    const res = await updateAppointment(appt.id, { status });
    setBusy(false);
    toast(res.message, res.ok ? "success" : "info");
    if (res.ok) onChanged();
  }
  async function reschedule() {
    if (!date || !time) { toast("Pick a date and time.", "info"); return; }
    setBusy(true);
    const res = await updateAppointment(appt.id, { date, time, status: "Scheduled" });
    setBusy(false);
    toast(res.ok ? "Appointment rescheduled." : res.message, res.ok ? "success" : "info");
    if (res.ok) onChanged();
  }
  async function cancel() {
    if (!confirm("Cancel this appointment?")) return;
    setBusy(true);
    const res = await cancelAppointment(appt.id);
    setBusy(false);
    toast(res.message, res.ok ? "success" : "info");
    if (res.ok) onChanged();
  }

  return (
    <Modal open onClose={onClose} title={appt.patientName} subtitle={appt.procedure}>
      <div className="grid gap-3 text-sm">
        {[
          ["Treatment", appt.procedure],
          ["Fee", appt.fee != null ? String(appt.fee) : "—"],
          ["Provider", appt.provider || "—"],
          ["Operatory", appt.operatory || "—"],
          ["Status", appt.status],
          ["Phone", patient?.phone || "—"],
          ["Email", patient?.email || "—"],
          ["Booked via", sourceLabel(appt)],
        ].map(([k, v]) => (
          <div key={k} className="flex items-center justify-between border-b border-ink-100 pb-2 last:border-0">
            <span className="text-ink-500">{k}</span>
            <span className="font-medium text-ink-900">{v}</span>
          </div>
        ))}

        {!isClosed && (
          <div className="rounded-xl border border-ink-100 p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Reschedule</p>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Date"><input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
              <Field label="Time"><input type="time" className={inputCls} value={time.length === 5 ? time : "09:00"} onChange={(e) => setTime(e.target.value)} /></Field>
            </div>
            <button onClick={reschedule} disabled={busy} className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl border border-ink-200 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50 disabled:opacity-50">
              <CalendarClock className="h-4 w-4" /> Reschedule
            </button>
          </div>
        )}

        <div className="flex gap-2">
          {!isClosed && appt.status !== "Confirmed" && (
            <button onClick={() => setStatus("Confirmed")} disabled={busy} className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
              <Check className="h-4 w-4" /> Confirm
            </button>
          )}
          {!isClosed && (
            <button onClick={cancel} disabled={busy} className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-ink-200 py-2 text-sm font-semibold text-rose-600 hover:bg-rose-500/10 disabled:opacity-50">
              <X className="h-4 w-4" /> Cancel
            </button>
          )}
        </div>

        {patient && (
          <a href={`/dashboard/patients/${patient.id}`} className="rounded-xl bg-brand-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-brand-700">
            Open patient chart →
          </a>
        )}
      </div>
    </Modal>
  );
}
