"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PhoneCall, PhoneIncoming, PhoneOutgoing, CalendarCheck2, Timer, FileText, Search, RefreshCw, Play, ChevronLeft, ChevronRight } from "lucide-react";
import { Card, PageHeader, StatCard, StatusBadge } from "@/components/ui";
import { fetchVoiceCalls, type VoiceCallRecord } from "@/lib/db";

// Duration as M:SS (e.g. 3:12), matching the Callab call log.
function fmtDur(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
function fmtDateTime(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

const PER_PAGE = 15;

function statusTone(c: VoiceCallRecord): "green" | "amber" | "red" | "gray" {
  if (c.status === "in-progress") return "amber";
  if (c.status === "failed") return "red";
  if (c.outcome === "Success") return "green";
  return "gray";
}
function statusText(c: VoiceCallRecord): string {
  if (c.status === "in-progress") return "live";
  if (c.status === "failed") return "failed";
  return c.status === "ended" ? "ended" : c.status;
}

export default function CallLogsPage() {
  const router = useRouter();
  const [calls, setCalls] = useState<VoiceCallRecord[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [directionFilter, setDirectionFilter] = useState("");
  const [page, setPage] = useState(1);

  const refresh = useCallback(() => { fetchVoiceCalls().then(setCalls); }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 8000); // pick up live calls
    return () => clearInterval(t);
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return calls.filter((c) => {
      if (statusFilter && statusText(c) !== statusFilter) return false;
      if (directionFilter && c.direction !== directionFilter) return false;
      if (!q) return true;
      return [c.callerPhone, c.toPhone, c.agentName, c.summary].some((v) => String(v).toLowerCase().includes(q));
    });
  }, [calls, query, statusFilter, directionFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const current = Math.min(page, pageCount);
  const pageRows = filtered.slice((current - 1) * PER_PAGE, current * PER_PAGE);

  const today = new Date().toISOString().slice(0, 10);
  const callsToday = calls.filter((c) => (c.startedAt ?? "").slice(0, 10) === today).length;
  const booked = calls.filter((c) => c.outcome === "Success").length;
  const avg = calls.length ? Math.round(calls.reduce((s, c) => s + c.durationSec, 0) / calls.length) : 0;

  function exportCalls() {
    const esc = (v: string | number) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows: (string | number)[][] = [["Date", "From", "To", "Direction", "Duration", "Status", "Agent", "Summary"]];
    filtered.forEach((c) => rows.push([fmtDateTime(c.startedAt), c.callerPhone, c.toPhone, c.direction, fmtDur(c.durationSec), statusText(c), c.agentName, c.summary]));
    const url = URL.createObjectURL(new Blob([rows.map((r) => r.map(esc).join(",")).join("\r\n")], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = `call-logs-${today}.csv`; a.click(); URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHeader
        title="Call Logs"
        subtitle="View and manage your AI agent calls — every call transcribed, recorded and summarised."
        actions={
          <button onClick={exportCalls} className="flex items-center gap-2 rounded-xl border border-ink-200 px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50">
            <FileText className="h-4 w-4" /> Export CSV
          </button>
        }
      />

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <StatCard icon={PhoneCall} label="Calls today" value={String(callsToday)} hint={`${calls.length} total`} accent="brand" />
        <StatCard icon={CalendarCheck2} label="Successful outcomes" value={String(booked)} hint="booked / resolved" accent="green" />
        <StatCard icon={Timer} label="Avg call duration" value={fmtDur(avg)} hint="across all calls" accent="violet" />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} placeholder="Search number, agent or summary…" className="w-full rounded-xl border border-ink-200 bg-surface py-2.5 pl-9 pr-3 text-sm text-ink-800 outline-none placeholder:text-ink-400 focus:border-brand-400" />
        </div>
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} className="rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-700 outline-none">
          <option value="">All Statuses</option>
          <option value="live">In progress</option>
          <option value="ended">Ended</option>
          <option value="failed">Failed</option>
        </select>
        <select value={directionFilter} onChange={(e) => { setDirectionFilter(e.target.value); setPage(1); }} className="rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-700 outline-none">
          <option value="">All Directions</option>
          <option value="inbound">Incoming</option>
          <option value="outbound">Outgoing</option>
        </select>
        <button onClick={refresh} title="Refresh" className="rounded-xl border border-ink-200 p-2.5 text-ink-500 hover:bg-ink-50"><RefreshCw className="h-4 w-4" /></button>
      </div>

      <Card className="overflow-hidden">
        {filtered.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-ink-400">
            No calls yet. Connect a Vapi assistant + phone number — calls appear here automatically (the assistant Server URL is set to <code>/api/vapi/events</code> on save).
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="border-b border-ink-200 bg-ink-50/60 text-xs font-semibold uppercase tracking-wide text-ink-500">
                  <tr>
                    <th className="px-5 py-3">Date</th>
                    <th className="px-4 py-3">From</th>
                    <th className="px-4 py-3">To</th>
                    <th className="px-4 py-3">Direction</th>
                    <th className="px-4 py-3">Duration</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Agent</th>
                    <th className="px-4 py-3">Recording</th>
                    <th className="px-4 py-3">Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((c) => (
                    <tr
                      key={c.id}
                      onClick={() => router.push(`/dashboard/voice/${c.id}`)}
                      className="cursor-pointer border-b border-ink-100 last:border-0 hover:bg-ink-50/60"
                    >
                      <td className="px-5 py-3.5 text-ink-700">{fmtDateTime(c.startedAt)}</td>
                      <td className="px-4 py-3.5 text-ink-700">{c.callerPhone || "—"}</td>
                      <td className="px-4 py-3.5 text-ink-700">{c.toPhone || "—"}</td>
                      <td className="px-4 py-3.5">
                        <span className="flex items-center gap-1.5 text-ink-600">
                          {c.direction === "inbound" ? <PhoneIncoming className="h-3.5 w-3.5 text-orange-500" /> : <PhoneOutgoing className="h-3.5 w-3.5 text-blue-500" />}
                          {c.direction === "inbound" ? "incoming" : "outgoing"}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-ink-700">{fmtDur(c.durationSec)}</td>
                      <td className="px-4 py-3.5">
                        {c.status === "in-progress" ? (
                          <span className="flex w-fit items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase text-rose-600"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-500" /> live</span>
                        ) : (
                          <StatusBadge status={statusText(c)} tone={statusTone(c)} />
                        )}
                      </td>
                      <td className="px-4 py-3.5 text-ink-700">{c.agentName || "—"}</td>
                      <td className="px-4 py-3.5">
                        {c.recordingUrl ? <Play className="h-4 w-4 text-brand-500" /> : <span className="text-ink-300">—</span>}
                      </td>
                      <td className="max-w-xs truncate px-4 py-3.5 text-ink-500">{c.summary ? `${c.summary.slice(0, 60)}…` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-200 px-5 py-3 text-sm text-ink-500">
              <span>Showing {(current - 1) * PER_PAGE + 1} to {Math.min(current * PER_PAGE, filtered.length)} of {filtered.length} calls</span>
              <div className="flex items-center gap-1">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={current === 1} className="flex items-center gap-1 rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40"><ChevronLeft className="h-3.5 w-3.5" /> Previous</button>
                <span className="px-2 text-xs">Page {current} of {pageCount}</span>
                <button onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={current === pageCount} className="flex items-center gap-1 rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40">Next <ChevronRight className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          </>
        )}
      </Card>
    </>
  );
}
