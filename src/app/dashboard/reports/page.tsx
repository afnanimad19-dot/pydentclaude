"use client";

import { useEffect, useMemo, useState } from "react";
import { Users, CalendarClock, UserPlus, CalendarCheck2, Download, DollarSign, CalendarX } from "lucide-react";
import { Card, PageHeader, DemoBanner, StatCard, StatusBadge } from "@/components/ui";
import { fetchPatients, fetchAppointments, type DataSource } from "@/lib/db";
import { patients as mockPatients, appointments as mockAppointments, type Patient, type Appointment } from "@/lib/mock-data";

const aptTone = {
  Confirmed: "green", Scheduled: "blue", Unconfirmed: "amber", Completed: "gray", Broken: "red",
} as const;

function downloadCsv(filename: string, rows: (string | number)[][]) {
  const esc = (v: string | number) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = rows.map((r) => r.map(esc).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ReportsPage() {
  const [patients, setPatients] = useState<Patient[]>(mockPatients);
  const [appointments, setAppointments] = useState<Appointment[]>(mockAppointments);
  const [source, setSource] = useState<DataSource>("demo");
  const [{ today, in7 }] = useState(() => {
    const now = Date.now();
    return { today: new Date(now).toISOString().slice(0, 10), in7: new Date(now + 7 * 86400000).toISOString().slice(0, 10) };
  });
  // Reporting date range — defaults to the last 30 days.
  const [from, setFrom] = useState(() => new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  const [to, setTo] = useState(today);

  useEffect(() => {
    fetchPatients().then((r) => { setPatients(r.patients); setSource(r.source); });
    fetchAppointments().then((r) => setAppointments(r.appointments));
  }, []);

  const upcoming = useMemo(
    () => appointments.filter((a) => a.date >= today && a.status !== "Broken").sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)),
    [appointments, today]
  );
  const thisWeek = upcoming.filter((a) => a.date <= in7);
  const newPatients = patients.filter((p) => p.status === "New").length;

  // Range metrics — bookings, production (completed fees), and no-show/broken rate.
  const broken = new Set(["Broken", "Cancelled", "No-show", "Failed"]);
  const inRange = useMemo(() => appointments.filter((a) => a.date >= from && a.date <= to), [appointments, from, to]);
  const completed = inRange.filter((a) => a.status === "Completed");
  const brokenInRange = inRange.filter((a) => broken.has(String(a.status)));
  const production = completed.reduce((n, a) => n + Number(a.fee ?? 0), 0);
  const noShowRate = inRange.length ? Math.round((brokenInRange.length / inRange.length) * 100) : 0;

  function exportAppointments() {
    const rows: (string | number)[][] = [["Patient", "Service", "Date", "Time", "Provider", "Status"]];
    upcoming.forEach((a) => rows.push([a.patientName, a.procedure, a.date, a.time, a.provider, a.status]));
    downloadCsv(`appointments-${today}.csv`, rows);
  }
  function exportPatients() {
    const rows: (string | number)[][] = [["Name", "Phone", "Email", "Status", "Last visit", "Next appointment"]];
    patients.forEach((p) => rows.push([p.name, p.phone, p.email, p.status, p.lastVisit ?? "", p.nextAppointment ?? ""]));
    downloadCsv(`patients-${today}.csv`, rows);
  }

  return (
    <>
      {source === "live" ? (
        <div className="mb-6 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-600">
          <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500" />
          <span><strong className="font-semibold">Live database</strong> — these numbers come from your real patients & appointments.</span>
        </div>
      ) : (
        <DemoBanner context="Showing sample data — connect your database (or turn off sample data) to report on real patients." />
      )}

      <PageHeader
        title="Reports"
        subtitle="Your real numbers — patients on file and who's coming in. Export any list to a spreadsheet."
        actions={
          <div className="flex items-center gap-2">
            <button onClick={exportPatients} className="flex items-center gap-2 rounded-xl border border-ink-200 px-3.5 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50">
              <Download className="h-4 w-4" /> Patients CSV
            </button>
            <button onClick={exportAppointments} className="flex items-center gap-2 rounded-xl bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700">
              <Download className="h-4 w-4" /> Appointments CSV
            </button>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Users} label="Patients on file" value={String(patients.length)} hint="total contacts" accent="brand" />
        <StatCard icon={UserPlus} label="New patients" value={String(newPatients)} hint="status: new" accent="green" />
        <StatCard icon={CalendarClock} label="Upcoming appointments" value={String(upcoming.length)} hint="today onward" accent="violet" />
        <StatCard icon={CalendarCheck2} label="Coming this week" value={String(thisWeek.length)} hint="next 7 days" accent="amber" />
      </div>

      {/* Date-range analytics */}
      <Card className="mt-6 p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold text-ink-900">Performance</h2>
          <div className="flex items-center gap-2 text-sm">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-ink-700 outline-none" />
            <span className="text-ink-400">→</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-ink-700 outline-none" />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard icon={CalendarCheck2} label="Booked (range)" value={String(inRange.length)} hint={`${from} → ${to}`} accent="brand" />
          <StatCard icon={CalendarCheck2} label="Completed" value={String(completed.length)} hint="in range" accent="green" />
          <StatCard icon={DollarSign} label="Production" value={production.toLocaleString()} hint="completed fees" accent="violet" />
          <StatCard icon={CalendarX} label="No-show / broken" value={`${noShowRate}%`} hint={`${brokenInRange.length} of ${inRange.length}`} accent="amber" />
        </div>
      </Card>

      <Card className="mt-6 p-5">
        <h2 className="mb-1 font-semibold text-ink-900">Upcoming appointments</h2>
        <p className="mb-4 text-sm text-ink-500">Everyone booked from today onward, soonest first.</p>
        {upcoming.length === 0 ? (
          <p className="rounded-xl border border-dashed border-ink-200 px-4 py-8 text-center text-sm text-ink-400">No upcoming appointments yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-400">
                  <th className="py-2 pr-4 font-semibold">Patient</th>
                  <th className="py-2 pr-4 font-semibold">Service</th>
                  <th className="py-2 pr-4 font-semibold">Date</th>
                  <th className="py-2 pr-4 font-semibold">Time</th>
                  <th className="py-2 pr-4 font-semibold">Provider</th>
                  <th className="py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {upcoming.map((a) => (
                  <tr key={a.id} className="border-b border-ink-100 last:border-0">
                    <td className="py-2.5 pr-4 font-medium text-ink-900">{a.patientName}</td>
                    <td className="py-2.5 pr-4 text-ink-600">{a.procedure}</td>
                    <td className="py-2.5 pr-4 text-ink-600">{a.date}</td>
                    <td className="py-2.5 pr-4 text-ink-600">{a.time}</td>
                    <td className="py-2.5 pr-4 text-ink-600">{a.provider || "—"}</td>
                    <td className="py-2.5"><StatusBadge status={a.status} tone={aptTone[a.status]} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
