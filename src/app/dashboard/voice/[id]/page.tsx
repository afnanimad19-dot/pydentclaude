"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Phone, MessageSquare, Info, CheckCircle2, Download, User } from "lucide-react";
import { Card } from "@/components/ui";
import { fetchVoiceCall, fetchCampaigns, type VoiceCallRecord, type CallMessage } from "@/lib/db";

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
function clock(secs: number | null) {
  if (secs == null) return "";
  const s = Math.max(0, Math.round(secs));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function Detail({ label, value, accent }: { label: string; value: React.ReactNode; accent?: string }) {
  return (
    <div>
      <p className="text-xs text-ink-400">{label}</p>
      <p className={`mt-0.5 text-sm font-semibold ${accent ?? "text-ink-900"}`}>{value}</p>
    </div>
  );
}

// A single tool call (e.g. get_available_slots) as a request/response card.
function ToolCard({ name, args, result }: { name: string; args: unknown; result?: string }) {
  return (
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
      <div className="mb-2 flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
        <span className="font-mono text-xs font-semibold text-ink-800">{name}</span>
        <span className="ml-auto rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase text-emerald-600">success</span>
      </div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">Request</p>
      <pre className="mb-2 max-h-40 overflow-auto rounded-lg bg-emerald-500/10 p-2 text-[11px] leading-relaxed text-ink-700">{typeof args === "string" ? args : JSON.stringify(args, null, 2)}</pre>
      {result && (
        <>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">Response</p>
          <pre className="max-h-40 overflow-auto rounded-lg bg-emerald-500/10 p-2 text-[11px] leading-relaxed text-ink-700">{result}</pre>
        </>
      )}
    </div>
  );
}

function TimelineRow({ m }: { m: CallMessage }) {
  // Tool call request (+ optional inline result).
  if (m.toolCalls?.length) {
    return (
      <div className="flex flex-col gap-2">
        <p className="flex items-center gap-1.5 text-xs text-ink-400"><span className="grid h-6 w-6 place-items-center rounded-full bg-ink-100 text-[10px] font-bold text-ink-500">AI</span> AI Agent</p>
        {m.toolCalls.map((tc, i) => <ToolCard key={i} name={tc.name} args={tc.args} result={m.toolResult} />)}
        {m.text && <div className="max-w-[80%] rounded-xl border border-ink-200 bg-surface px-3.5 py-2 text-sm text-ink-800">{m.text}</div>}
        {m.secondsFromStart != null && <span className="text-[10px] text-ink-400">{clock(m.secondsFromStart)}</span>}
      </div>
    );
  }
  // Standalone tool result.
  if (m.role === "tool_call_result" && m.toolResult) {
    return <ToolCard name={m.toolName || "tool result"} args={m.toolResult} />;
  }
  if (!m.text) return null;
  const isUser = m.role === "user";
  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      {!isUser && <p className="mb-1 flex items-center gap-1.5 text-xs text-ink-400"><span className="grid h-6 w-6 place-items-center rounded-full bg-ink-100 text-[10px] font-bold text-ink-500">AI</span> AI Agent</p>}
      <div className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${isUser ? "rounded-br-sm bg-brand-600 text-white" : "rounded-bl-sm border border-ink-200 bg-surface text-ink-800"}`}>
        {m.text}
      </div>
      {m.secondsFromStart != null && <span className="mt-1 text-[10px] text-ink-400">{clock(m.secondsFromStart)}</span>}
    </div>
  );
}

export default function CallDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [call, setCall] = useState<VoiceCallRecord | null>(null);
  const [campaignName, setCampaignName] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchVoiceCall(id).then((c) => {
      setCall(c);
      if (c?.campaignId) fetchCampaigns().then((cs) => setCampaignName(cs.find((x) => x.id === c.campaignId)?.name ?? ""));
    }).finally(() => setLoading(false));
  }, [id]);

  if (loading) return <p className="py-20 text-center text-sm text-ink-400">Loading call…</p>;
  if (!call) return (
    <div className="py-20 text-center">
      <p className="text-sm text-ink-500">Call not found.</p>
      <Link href="/dashboard/voice" className="mt-3 inline-block text-sm font-semibold text-brand-600">← Back to Call Logs</Link>
    </div>
  );

  const ended = call.status === "ended";
  const outcomeEntries = Object.entries(call.structuredData ?? {});

  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard/voice" className="mb-3 inline-flex items-center gap-2 text-sm font-medium text-ink-500 hover:text-ink-800"><ArrowLeft className="h-4 w-4" /> Back</Link>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-ink-900">Call Details</h1>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${ended ? "bg-emerald-500/15 text-emerald-600" : call.status === "failed" ? "bg-rose-500/15 text-rose-600" : "bg-amber-500/15 text-amber-600"}`}>
            {ended ? "Ended" : call.status === "failed" ? "Failed" : "In progress"}
          </span>
        </div>
        <p className="mt-1 text-sm text-ink-500">{call.callerPhone || "Unknown"} → {call.toPhone || "—"} · {fmtDateTime(call.startedAt)}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Call Details */}
        <Card className="p-6">
          <h2 className="mb-5 flex items-center gap-2 font-semibold text-ink-900"><Phone className="h-4 w-4 text-brand-500" /> Call Details</h2>
          <div className="grid grid-cols-2 gap-5">
            <Detail label="From" value={call.callerPhone || "—"} />
            <Detail label="To" value={call.toPhone || "—"} />
            <Detail label="Started" value={fmtDateTime(call.startedAt)} />
            <Detail label="Ended" value={fmtDateTime(call.endedAt)} />
            <Detail label="Status" value={ended ? "Ended" : call.status} accent={ended ? "text-emerald-600" : "text-amber-600"} />
            <Detail label="Direction" value={call.direction === "inbound" ? "Incoming" : "Outgoing"} />
            <Detail label="Connection Duration" value={fmtDur(call.durationSec)} />
            <Detail label="Reason" value={call.endedReason || "—"} />
            <Detail label="Agent" value={call.agentName || "—"} />
            <Detail label="Campaign" value={campaignName || "—"} />
            {call.patientId && (
              <div className="col-span-2">
                <Link href={`/dashboard/patients/${call.patientId}`} className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-semibold text-ink-700 hover:bg-ink-50"><User className="h-3.5 w-3.5" /> Open caller&apos;s contact →</Link>
              </div>
            )}
          </div>
        </Card>

        <div className="space-y-6">
          {/* Call Outcome */}
          <Card className="p-6">
            <h2 className="mb-4 flex items-center gap-2 font-semibold text-ink-900"><CheckCircle2 className="h-4 w-4 text-brand-500" /> Call Outcome</h2>
            {outcomeEntries.length === 0 ? (
              <p className="py-6 text-center text-sm text-ink-400">No outcomes recorded for this call</p>
            ) : (
              <dl className="grid gap-2">
                {outcomeEntries.map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between gap-3 rounded-lg bg-ink-50 px-3 py-2 text-sm">
                    <dt className="text-ink-500">{k}</dt>
                    <dd className="font-medium text-ink-900">{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>

          {/* Call Summary */}
          <Card className="p-6">
            <h2 className="mb-3 flex items-center gap-2 font-semibold text-ink-900"><Info className="h-4 w-4 text-brand-500" /> Call Summary</h2>
            {call.summary ? (
              <p className="text-sm leading-relaxed text-ink-700">{call.summary}</p>
            ) : (
              <p className="py-4 text-center text-sm text-ink-400">No summary recorded.</p>
            )}
            {call.outcome === "Success" && (
              <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-semibold text-emerald-600"><CheckCircle2 className="h-3.5 w-3.5" /> Goal met</p>
            )}
          </Card>
        </div>
      </div>

      {/* Call Transcript */}
      <Card className="p-6">
        <h2 className="mb-4 flex items-center gap-2 font-semibold text-ink-900"><MessageSquare className="h-4 w-4 text-brand-500" /> Call Transcript</h2>

        {call.recordingUrl ? (
          <div className="mb-5 flex items-center gap-3 rounded-xl border border-ink-100 bg-ink-50/60 p-3">
            <audio controls src={call.recordingUrl} className="w-full" />
            <a href={call.recordingUrl} download title="Download recording" className="shrink-0 rounded-lg p-2 text-ink-500 hover:bg-ink-100"><Download className="h-4 w-4" /></a>
          </div>
        ) : (
          <p className="mb-5 text-xs text-ink-400">{call.status === "in-progress" ? "Call in progress — recording appears when it ends." : "No recording available."}</p>
        )}

        {call.messages.length > 0 ? (
          <>
            <div className="mb-3 flex items-center justify-between border-b border-ink-100 pb-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Conversation Timeline</p>
              <span className="text-xs text-ink-400">{call.messages.length} messages</span>
            </div>
            <div className="space-y-4">
              {call.messages.map((m, i) => <TimelineRow key={i} m={m} />)}
            </div>
          </>
        ) : call.transcript ? (
          <>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Transcript</p>
            <pre className="max-h-[32rem] overflow-y-auto whitespace-pre-wrap rounded-xl bg-ink-50 p-4 text-sm leading-relaxed text-ink-800">{call.transcript}</pre>
          </>
        ) : (
          <p className="text-sm text-ink-400">{call.status === "in-progress" ? "Transcript appears when the call ends." : "No transcript."}</p>
        )}
      </Card>
    </div>
  );
}
