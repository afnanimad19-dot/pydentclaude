"use client";

import { useEffect, useMemo, useState } from "react";
import { Users, CalendarClock, UserPlus, CalendarCheck2, Download, DollarSign, CalendarX, BarChart3, LineChart as LineIcon, Search, Plug, RefreshCw, MousePointerClick, Eye, Percent, TrendingUp } from "lucide-react";
import { Card, PageHeader, DemoBanner, StatCard, StatusBadge } from "@/components/ui";
import { LineChart, BarList, Donut } from "@/components/dashboard/charts";
import { fetchPatients, fetchAppointments, getWorkspaceId, type DataSource } from "@/lib/db";
import { patients as mockPatients, appointments as mockAppointments, type Patient, type Appointment } from "@/lib/mock-data";

const aptTone = { Confirmed: "green", Scheduled: "blue", Unconfirmed: "amber", Completed: "gray", Broken: "red" } as const;

function downloadCsv(filename: string, rows: (string | number)[][]) {
  const esc = (v: string | number) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = rows.map((r) => r.map(esc).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

type Tab = "overview" | "analytics" | "search";
const TABS: { id: Tab; label: string; icon: typeof BarChart3 }[] = [
  { id: "overview", label: "Overview", icon: BarChart3 },
  { id: "analytics", label: "Google Analytics", icon: LineIcon },
  { id: "search", label: "Search Console", icon: Search },
];

export default function ReportsPage() {
  const [tab, setTab] = useState<Tab>("overview");
  useEffect(() => {
    const sync = () => { const h = window.location.hash.replace("#", ""); setTab(h === "analytics" || h === "search" ? h : "overview"); };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  function go(t: Tab) { setTab(t); history.replaceState(null, "", t === "overview" ? "#" : `#${t}`); }

  return (
    <>
      <PageHeader title="Reports" subtitle="Your practice numbers, website analytics and search performance — all in one place." />
      <div className="mb-6 flex flex-wrap gap-1 rounded-xl border border-ink-200 bg-ink-50/50 p-1">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => go(t.id)} className={`flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${tab === t.id ? "bg-surface text-ink-900 shadow-sm" : "text-ink-500 hover:text-ink-800"}`}>
            <t.icon className="h-4 w-4" /> {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab />}
      {tab === "analytics" && <AnalyticsTab />}
      {tab === "search" && <SearchTab />}
    </>
  );
}

/* --------------------------------------------------------------- Overview */
function OverviewTab() {
  const [patients, setPatients] = useState<Patient[]>(mockPatients);
  const [appointments, setAppointments] = useState<Appointment[]>(mockAppointments);
  const [source, setSource] = useState<DataSource>("demo");
  const [{ today, in7 }] = useState(() => { const now = Date.now(); return { today: new Date(now).toISOString().slice(0, 10), in7: new Date(now + 7 * 86400000).toISOString().slice(0, 10) }; });
  const [from, setFrom] = useState(() => new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  const [to, setTo] = useState(today);

  useEffect(() => {
    fetchPatients().then((r) => { setPatients(r.patients); setSource(r.source); });
    fetchAppointments().then((r) => setAppointments(r.appointments));
  }, []);

  const upcoming = useMemo(() => appointments.filter((a) => a.date >= today && a.status !== "Broken").sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)), [appointments, today]);
  const thisWeek = upcoming.filter((a) => a.date <= in7);
  const newPatients = patients.filter((p) => p.status === "New").length;
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
          <span><strong className="font-semibold">Live database</strong> — these numbers come from your real patients &amp; appointments.</span>
        </div>
      ) : (
        <DemoBanner context="Showing sample data — connect your database (or turn off sample data) to report on real patients." />
      )}

      <div className="mb-4 flex flex-wrap justify-end gap-2">
        <button onClick={exportPatients} className="flex items-center gap-2 rounded-xl border border-ink-200 px-3.5 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"><Download className="h-4 w-4" /> Patients CSV</button>
        <button onClick={exportAppointments} className="flex items-center gap-2 rounded-xl bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700"><Download className="h-4 w-4" /> Appointments CSV</button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Users} label="Patients on file" value={String(patients.length)} hint="total contacts" accent="brand" />
        <StatCard icon={UserPlus} label="New patients" value={String(newPatients)} hint="status: new" accent="green" />
        <StatCard icon={CalendarClock} label="Upcoming appointments" value={String(upcoming.length)} hint="today onward" accent="violet" />
        <StatCard icon={CalendarCheck2} label="Coming this week" value={String(thisWeek.length)} hint="next 7 days" accent="amber" />
      </div>

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
              <thead><tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-400">
                <th className="py-2 pr-4 font-semibold">Patient</th><th className="py-2 pr-4 font-semibold">Service</th><th className="py-2 pr-4 font-semibold">Date</th><th className="py-2 pr-4 font-semibold">Time</th><th className="py-2 pr-4 font-semibold">Provider</th><th className="py-2 font-semibold">Status</th>
              </tr></thead>
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

/* ------------------------------------------------------- shared empty states */
function NotConnected({ what, error }: { what: string; error?: string }) {
  return (
    <Card className="p-8">
      <p className="flex items-center gap-2 font-semibold text-ink-900"><Plug className="h-5 w-5 text-amber-500" /> {what} isn&apos;t connected yet</p>
      <p className="mt-2 max-w-2xl text-sm text-ink-600">Connect {what} on the marketing engine and this tab fills itself with your real data.</p>
      {error && <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">{error}</p>}
      <a href="/dashboard/settings?tab=connections" className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">Open Connections</a>
    </Card>
  );
}

/* ------------------------------------------------------- Google Analytics */
interface GaData { configured: boolean; connected?: boolean; property?: string | null; error?: string; totals?: { sessions: number; users: number }; byDate?: { date: string; sessions: number }[]; byCountry?: { label: string; value: number }[]; byDevice?: { label: string; value: number }[]; byChannel?: { label: string; value: number }[]; topPages?: { label: string; value: number }[] }

function AnalyticsTab() {
  const [data, setData] = useState<GaData | null>(null);
  const [loading, setLoading] = useState(true);
  const load = () => { setLoading(true); getWorkspaceId().then((ws) => fetch(`/api/hyperfx/analytics?ws=${ws ?? ""}`)).then((r) => r.json()).then(setData).catch(() => setData({ configured: false, error: "Failed to load." })).finally(() => setLoading(false)); };
  useEffect(() => { getWorkspaceId().then((ws) => fetch(`/api/hyperfx/analytics?ws=${ws ?? ""}`)).then((r) => r.json()).then(setData).catch(() => setData({ configured: false })).finally(() => setLoading(false)); }, []);

  if (loading && !data) return <Card className="p-10 text-center text-sm text-ink-400">Loading Google Analytics…</Card>;
  if (data && (!data.configured || data.connected === false)) return <NotConnected what="Google Analytics" error={data.error} />;
  if (data && !data.property) return <NotConnected what="Google Analytics" error={data.error ?? "No GA4 property found."} />;

  return (
    <div className="space-y-6">
      <div className="flex justify-end"><button onClick={load} className="flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh</button></div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Users} label="Users (28d)" value={(data?.totals?.users ?? 0).toLocaleString()} accent="brand" />
        <StatCard icon={TrendingUp} label="Sessions (28d)" value={(data?.totals?.sessions ?? 0).toLocaleString()} accent="green" />
        <StatCard icon={LineIcon} label="Top channel" value={data?.byChannel?.[0]?.label ?? "—"} hint={data?.byChannel?.[0] ? `${data.byChannel[0].value.toLocaleString()} sessions` : ""} accent="violet" />
        <StatCard icon={Eye} label="Top country" value={data?.byCountry?.[0]?.label ?? "—"} hint={data?.byCountry?.[0] ? `${data.byCountry[0].value.toLocaleString()} sessions` : ""} accent="amber" />
      </div>
      <Card className="p-5"><h2 className="mb-3 font-semibold text-ink-900">Sessions over time</h2><LineChart data={(data?.byDate ?? []).map((d) => ({ date: d.date, value: d.sessions }))} label="sessions" /></Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5"><h2 className="mb-3 font-semibold text-ink-900">By device</h2><Donut data={data?.byDevice ?? []} /></Card>
        <Card className="p-5"><h2 className="mb-3 font-semibold text-ink-900">Traffic by channel</h2><BarList data={data?.byChannel ?? []} /></Card>
        <Card className="p-5"><h2 className="mb-3 font-semibold text-ink-900">Top countries</h2><BarList data={data?.byCountry ?? []} /></Card>
        <Card className="p-5"><h2 className="mb-3 font-semibold text-ink-900">Top pages</h2><BarList data={data?.topPages ?? []} /></Card>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- Search Console */
interface GscData { configured: boolean; connected?: boolean; site?: string | null; error?: string; totals?: { clicks: number; impressions: number; ctr: number; avgPos: number }; byDate?: { date: string; clicks: number; impressions: number }[]; topQueries?: { query: string; clicks: number; impressions: number; ctr: number; position: number }[]; byCountry?: { label: string; value: number }[]; byDevice?: { label: string; value: number }[] }

function SearchTab() {
  const [data, setData] = useState<GscData | null>(null);
  const [loading, setLoading] = useState(true);
  const load = () => { setLoading(true); getWorkspaceId().then((ws) => fetch(`/api/hyperfx/searchconsole?ws=${ws ?? ""}`)).then((r) => r.json()).then(setData).catch(() => setData({ configured: false })).finally(() => setLoading(false)); };
  useEffect(() => { getWorkspaceId().then((ws) => fetch(`/api/hyperfx/searchconsole?ws=${ws ?? ""}`)).then((r) => r.json()).then(setData).catch(() => setData({ configured: false })).finally(() => setLoading(false)); }, []);

  if (loading && !data) return <Card className="p-10 text-center text-sm text-ink-400">Loading Search Console…</Card>;
  if (data && (!data.configured || data.connected === false)) return <NotConnected what="Google Search Console" error={data.error} />;
  if (data && !data.site) return <NotConnected what="Google Search Console" error={data.error ?? "No verified site found."} />;

  const pct = (n: number) => `${n.toFixed(1)}%`;
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-500">Site: <span className="font-medium text-ink-800">{data?.site}</span> · last 30 days</p>
        <button onClick={load} className="flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh</button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={MousePointerClick} label="Clicks" value={(data?.totals?.clicks ?? 0).toLocaleString()} accent="brand" />
        <StatCard icon={Eye} label="Impressions" value={(data?.totals?.impressions ?? 0).toLocaleString()} accent="green" />
        <StatCard icon={Percent} label="CTR" value={pct(data?.totals?.ctr ?? 0)} accent="violet" />
        <StatCard icon={TrendingUp} label="Avg position" value={(data?.totals?.avgPos ?? 0).toFixed(1)} hint="top queries" accent="amber" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5"><h2 className="mb-3 font-semibold text-ink-900">Clicks over time</h2><LineChart data={(data?.byDate ?? []).map((d) => ({ date: d.date, value: d.clicks }))} label="clicks" /></Card>
        <Card className="p-5"><h2 className="mb-3 font-semibold text-ink-900">Impressions over time</h2><LineChart data={(data?.byDate ?? []).map((d) => ({ date: d.date, value: d.impressions }))} label="impressions" tone="text-violet-500" /></Card>
      </div>
      <Card className="p-5">
        <h2 className="mb-3 font-semibold text-ink-900">Top search queries (keywords)</h2>
        {(data?.topQueries?.length ?? 0) === 0 ? (
          <p className="rounded-xl border border-dashed border-ink-200 px-4 py-6 text-center text-sm text-ink-400">No query data yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead><tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-400">
                <th className="py-2 pr-4 font-semibold">Query</th><th className="py-2 pr-4 text-right font-semibold">Clicks</th><th className="py-2 pr-4 text-right font-semibold">Impressions</th><th className="py-2 pr-4 text-right font-semibold">CTR</th><th className="py-2 text-right font-semibold">Position</th>
              </tr></thead>
              <tbody>
                {data!.topQueries!.map((q, i) => (
                  <tr key={i} className="border-b border-ink-100 last:border-0">
                    <td className="py-2 pr-4 font-medium text-ink-900">{q.query}</td>
                    <td className="py-2 pr-4 text-right text-ink-700">{q.clicks.toLocaleString()}</td>
                    <td className="py-2 pr-4 text-right text-ink-600">{q.impressions.toLocaleString()}</td>
                    <td className="py-2 pr-4 text-right text-ink-600">{(q.ctr * 100).toFixed(1)}%</td>
                    <td className="py-2 text-right text-ink-600">{q.position.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5"><h2 className="mb-3 font-semibold text-ink-900">Clicks by device</h2><Donut data={data?.byDevice ?? []} /></Card>
        <Card className="p-5"><h2 className="mb-3 font-semibold text-ink-900">Clicks by country</h2><BarList data={data?.byCountry ?? []} /></Card>
      </div>
    </div>
  );
}
