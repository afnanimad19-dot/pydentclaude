"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PhoneCall, Bot, RefreshCw, Phone, AlertTriangle, CheckCircle2, ShieldAlert, Loader2, Undo2, Link2, XCircle, Clock } from "lucide-react";
import { Card, PageHeader } from "@/components/ui";
import { Modal, Field, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import { fetchAgents, fetchVoiceNumbers, fetchVoiceProvider, type AiAgent, type VoiceNumber, type VoiceProvider } from "@/lib/db";
import { bindNumberToAgent } from "@/lib/voice-binding";
import { authFetch, newIdempotencyKey } from "@/lib/auth-fetch";

// Voice Agent Settings — which AI agent RECEIVES each phone number.
//
// Provider-aware: for a number whose routing Pydent manages (a linked LiveKit
// dispatch rule, or a Vapi number) the page shows, separately, the agent in
// Pydent's database and the agent the provider ACTUALLY dispatches (read live
// by /api/voice-numbers/[id]/routing). Reassigning runs the guarded server
// transaction (provider updated in place, read back, and only then recorded);
// success is shown only after the server verified the provider. Protected
// production numbers need the number typed to confirm.

const PROVIDER_LABEL: Record<string, string> = {
  sip: "Custom SIP", ziwo: "Ziwo", goautodial: "Go Auto Dial", maqsam: "Maqsam", twilio: "Twilio (BYOT)", vocalcom: "Vocalcom", vapi: "Vapi", landline: "Clinic Landline", livekit: "LiveKit (SIP)",
};
const ROUTING_LABEL: Record<string, string> = {
  livekit: "LiveKit dispatch rule",
  vapi: "Vapi phone number",
  none: "Pydent only — not provider-routed",
};

interface Eligibility { agentId: string; name: string; eligible: boolean; reason?: string }
interface RoutingStatusView {
  numberId: string;
  number: string;
  provider: "none" | "livekit" | "vapi";
  protected: boolean;
  status: "unverified" | "synced" | "pending" | "failed" | "reconcile_needed";
  database: { agentId: string | null; name: string | null };
  routing: { agentId: string | null; name: string | null };
  providerAgent: { agentId: string | null; name: string | null; livekitAgentName?: string; reason?: string } | null;
  providerError: string | null;
  drift: boolean;
  verifiedAt: string | null;
  error: string | null;
  route: { trunkId?: string; ruleId?: string; ruleName?: string } | null;
  eligibleTargets: Eligibility[];
  rollbackCandidate: { assignmentId: string; restoresAgentId: string; restoresAgentName: string | null } | null;
}
type StatusState = { loading: boolean; data?: RoutingStatusView; error?: string; migrationMissing?: boolean };

function loadAll() {
  return Promise.all([fetchAgents(), fetchVoiceNumbers(), fetchVoiceProvider()]);
}

function fmtTime(iso: string | null) {
  if (!iso) return "never";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function StatusBadge({ s }: { s?: RoutingStatusView }) {
  if (!s) return null;
  if (s.drift) return <Badge tone="rose" icon={ShieldAlert} label="Drift — reconcile" />;
  switch (s.status) {
    case "synced": return <Badge tone="emerald" icon={CheckCircle2} label="Synced" />;
    case "pending": return <Badge tone="amber" icon={Clock} label="Pending" />;
    case "failed": return <Badge tone="rose" icon={XCircle} label="Last change failed" />;
    case "reconcile_needed": return <Badge tone="rose" icon={ShieldAlert} label="Reconcile needed" />;
    default: return <Badge tone="ink" icon={AlertTriangle} label={s.provider === "none" ? "Not provider-routed" : "Unverified"} />;
  }
}

function Badge({ tone, icon: Icon, label }: { tone: "emerald" | "amber" | "rose" | "ink" | "sky"; icon: typeof CheckCircle2; label: string }) {
  const cls = {
    emerald: "bg-emerald-500/15 text-emerald-600",
    amber: "bg-amber-500/15 text-amber-700",
    rose: "bg-rose-500/15 text-rose-600",
    ink: "bg-ink-100 text-ink-600",
    sky: "bg-sky-500/15 text-sky-700",
  }[tone];
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}><Icon className="h-3 w-3" /> {label}</span>;
}

export default function VoiceAgentSettingsPage() {
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [numbers, setNumbers] = useState<VoiceNumber[]>([]);
  const [engine, setEngine] = useState<VoiceProvider>("livekit");
  const [status, setStatus] = useState<Record<string, StatusState>>({});
  const [pick, setPick] = useState<Record<string, string>>({}); // numberId -> selected target agent
  const [confirm, setConfirm] = useState<null | { kind: "assign" | "rollback"; num: VoiceNumber; target?: AiAgent; assignmentId?: string; targetName: string }>(null);
  const [linkFor, setLinkFor] = useState<VoiceNumber | null>(null);

  const loadStatus = useCallback(async (n: VoiceNumber) => {
    setStatus((s) => ({ ...s, [n.id]: { ...(s[n.id] ?? {}), loading: true } }));
    try {
      const res = await authFetch(`/api/voice-numbers/${encodeURIComponent(n.id)}/routing`);
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.ok) setStatus((s) => ({ ...s, [n.id]: { loading: false, data: d as RoutingStatusView } }));
      else setStatus((s) => ({ ...s, [n.id]: { loading: false, error: d.error ?? d.message ?? `Could not load routing (${res.status}).`, migrationMissing: d.code === "migration_missing" } }));
    } catch {
      setStatus((s) => ({ ...s, [n.id]: { loading: false, error: "Could not reach Pydent." } }));
    }
  }, []);

  const apply = useCallback(([a, n, e]: [{ agents: AiAgent[] }, VoiceNumber[], VoiceProvider]) => {
    setAgents(a.agents.filter((x) => x.kind === "voice"));
    setNumbers(n);
    setEngine(e);
    n.forEach((x) => { void loadStatus(x); });
  }, [loadStatus]);
  const refresh = useCallback(() => loadAll().then(apply), [apply]);

  useEffect(() => {
    let alive = true;
    loadAll().then((r) => { if (alive) apply(r); });
    return () => { alive = false; };
  }, [apply]);

  const migrationMissing = Object.values(status).some((s) => s.migrationMissing);
  const agentName = (id: string | null | undefined) => (id ? agents.find((a) => a.id === id)?.name ?? "Unknown agent" : "—");

  async function reconcile(n: VoiceNumber) {
    if (!window.confirm(`Adopt the provider's current routing for ${n.number} into Pydent? No provider settings are changed.`)) return;
    const res = await authFetch(`/api/voice-numbers/${encodeURIComponent(n.id)}/routing`, { method: "POST", body: JSON.stringify({ action: "reconcile", idempotencyKey: newIdempotencyKey("reconcile") }) });
    const d = await res.json().catch(() => ({}));
    toast(d.message ?? d.error ?? "Reconcile failed.", d.ok ? "success" : "info");
    void refresh();
  }

  return (
    <>
      <PageHeader
        title="Voice Agent Settings"
        subtitle="Choose which voice agent receives each phone number. For provider-routed numbers Pydent updates the provider in place, verifies it, and only then shows the change — calls already in progress are never moved."
        actions={
          <button onClick={() => void refresh()} className="flex items-center gap-2 rounded-xl border border-ink-200 px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50">
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
        }
      />

      {migrationMissing && (
        <Card className="mb-5 flex items-center gap-3 border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-700">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <span>Routing management is not enabled yet (database migration 0064 has not been applied). Assignments are shown read-only; nothing can be changed from here until it is.</span>
        </Card>
      )}

      {numbers.length === 0 && (
        <Card className="mb-5 flex items-center gap-3 border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-700">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <span>No phone numbers connected yet. Add one in <Link href="/dashboard/agents/phone-numbers" className="font-semibold underline">Phone Numbers</Link> first.</span>
        </Card>
      )}

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Phone numbers — who answers</h2>
      <div className="mb-8 grid gap-4 lg:grid-cols-2">
        {numbers.map((n) => {
          const st = status[n.id];
          const s = st?.data;
          const routed = !!s && s.provider !== "none";
          const blocked = !s || st?.loading || s.status === "reconcile_needed" || s.status === "pending" || s.drift || (routed && !!s.providerError);
          const current = s?.database.agentId ?? n.agentId;
          const options = (s?.eligibleTargets ?? []).filter((e) => e.agentId !== current);
          const chosen = pick[n.id] ?? "";
          const chosenEl = options.find((o) => o.agentId === chosen);
          return (
            <Card key={n.id} className="flex flex-col p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-base font-semibold text-ink-900"><Phone className="h-4 w-4 text-ink-400" /> {n.number}</p>
                  <p className="text-xs text-ink-400">{n.nickname ? `${n.nickname} · ` : ""}{PROVIDER_LABEL[n.provider] ?? n.provider}</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  {st?.loading ? <Badge tone="ink" icon={Loader2} label="Checking…" /> : <StatusBadge s={s} />}
                  {s?.protected && <Badge tone="sky" icon={ShieldAlert} label="Production · protected" />}
                </div>
              </div>

              <dl className="mt-4 grid gap-1.5 rounded-xl border border-ink-100 p-3 text-xs">
                <div className="flex justify-between gap-3"><dt className="text-ink-400">Routing</dt><dd className="text-right font-medium text-ink-700">{s ? ROUTING_LABEL[s.provider] : st?.error ? "—" : "…"}</dd></div>
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-400">Actually receiving calls</dt>
                  <dd className="text-right font-semibold text-ink-900">
                    {!s ? "…" : s.provider === "none" ? <span className="font-normal text-ink-500">Not managed by Pydent</span> : s.providerAgent ? (
                      <>{s.providerAgent.name ?? "Unknown agent"}{s.providerAgent.livekitAgentName ? <span className="font-normal text-ink-400"> ({s.providerAgent.livekitAgentName})</span> : null}</>
                    ) : <span className="text-rose-600">Unknown</span>}
                  </dd>
                </div>
                <div className="flex justify-between gap-3"><dt className="text-ink-400">Pydent assignment (database)</dt><dd className="text-right font-medium text-ink-700">{agentName(current)}</dd></div>
                {routed && <div className="flex justify-between gap-3"><dt className="text-ink-400">Last verified</dt><dd className="text-right text-ink-600">{fmtTime(s!.verifiedAt)}</dd></div>}
                {s?.route?.ruleId && <div className="flex justify-between gap-3"><dt className="text-ink-400">Dispatch rule</dt><dd className="truncate text-right font-mono text-[11px] text-ink-600">{s.route.ruleName || s.route.ruleId}</dd></div>}
              </dl>

              {st?.error && <p className="mt-2 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-600">{st.error}</p>}
              {s?.providerError && <p className="mt-2 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-600">{s.providerError}</p>}
              {s?.error && s.status !== "synced" && <p className="mt-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700">Last attempt: {s.error}</p>}
              {s?.provider === "none" && (
                <p className="mt-2 rounded-lg bg-ink-50 px-3 py-2 text-[11px] text-ink-500">Changing the agent here only updates Pydent — it does not change which agent answers calls on this number.</p>
              )}
              {(s?.drift || s?.status === "reconcile_needed") && (
                <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-600">
                  <span>Pydent&apos;s record and the provider disagree. Reassignment is blocked until this is reconciled.</span>
                  <button onClick={() => void reconcile(n)} className="shrink-0 rounded-lg border border-rose-300 px-2 py-1 font-semibold hover:bg-rose-500/10">Reconcile</button>
                </div>
              )}

              <div className="mt-4 flex items-center gap-2 border-t border-ink-100 pt-4">
                <select className={`${inputCls} flex-1`} value={chosen} onChange={(e) => setPick((p) => ({ ...p, [n.id]: e.target.value }))} disabled={!!blocked || migrationMissing}>
                  <option value="">{blocked ? "Reassignment unavailable" : "Reassign to…"}</option>
                  {options.map((o) => (
                    <option key={o.agentId} value={o.agentId} disabled={!o.eligible}>{o.name}{o.eligible ? "" : ` — ${o.reason ?? "not eligible"}`}</option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    const target = agents.find((a) => a.id === chosen);
                    if (target && chosenEl?.eligible) setConfirm({ kind: "assign", num: n, target, targetName: target.name });
                  }}
                  disabled={!chosenEl?.eligible || !!blocked || migrationMissing}
                  className="rounded-xl bg-brand-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  Reassign…
                </button>
              </div>

              <div className="mt-2 flex flex-wrap gap-2">
                {s?.rollbackCandidate && !blocked && (
                  <button
                    onClick={() => setConfirm({ kind: "rollback", num: n, assignmentId: s.rollbackCandidate!.assignmentId, targetName: s.rollbackCandidate!.restoresAgentName ?? "the previous agent" })}
                    className="flex items-center gap-1 rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-semibold text-ink-600 hover:bg-ink-50"
                  >
                    <Undo2 className="h-3.5 w-3.5" /> Restore previous routing ({s.rollbackCandidate.restoresAgentName ?? "previous agent"})
                  </button>
                )}
                {s?.provider === "none" && (n.provider === "landline" || n.provider === "livekit") && !migrationMissing && (
                  <button onClick={() => setLinkFor(n)} className="flex items-center gap-1 rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-semibold text-ink-600 hover:bg-ink-50">
                    <Link2 className="h-3.5 w-3.5" /> Link existing LiveKit route
                  </button>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Voice agents</h2>
      {agents.length === 0 ? (
        <Card className="p-10 text-center text-sm text-ink-500">
          <Bot className="mx-auto mb-2 h-6 w-6 text-ink-300" /> No voice agents yet — create one in <Link href="/dashboard/agents/voice" className="font-semibold text-brand-600">All voice agents</Link>.
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {agents.map((agent) => {
            const receiving = numbers.filter((n) => {
              const s = status[n.id]?.data;
              return s && s.provider !== "none" ? s.providerAgent?.agentId === agent.id : n.agentId === agent.id;
            });
            const lkName = String(agent.voiceSettings?.livekit?.agentName ?? "").trim();
            return (
              <Card key={agent.id} className="flex flex-col p-5">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="rounded-xl bg-brand-500/15 p-2 text-brand-600"><PhoneCall className="h-5 w-5" /></div>
                    <div>
                      <p className="font-semibold text-ink-900">{agent.name}</p>
                      <p className="text-xs text-ink-400">{agent.role} · {agent.status}</p>
                    </div>
                  </div>
                  {engine === "vapi" ? (
                    agent.vapiAssistantId ? <Badge tone="emerald" icon={CheckCircle2} label="Synced to Vapi" /> : <Badge tone="amber" icon={AlertTriangle} label="Not synced to Vapi" />
                  ) : (
                    <Badge tone="sky" icon={Bot} label={lkName ? `LiveKit: ${lkName}` : "LiveKit: Pydent worker"} />
                  )}
                </div>
                <div className="mt-4">
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400">Receiving numbers</p>
                  {receiving.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-ink-200 px-3 py-3 text-center text-xs text-ink-400">No number routes to this agent.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {receiving.map((n) => (
                        <p key={n.id} className="flex items-center gap-1.5 rounded-lg border border-ink-100 px-3 py-2 text-sm font-semibold text-ink-900"><Phone className="h-3.5 w-3.5 text-ink-400" /> {n.number}</p>
                      ))}
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {confirm && (
        <ConfirmChange
          {...confirm}
          currentName={status[confirm.num.id]?.data?.providerAgent?.name ?? agentName(confirm.num.agentId)}
          isProtected={!!status[confirm.num.id]?.data?.protected}
          provider={status[confirm.num.id]?.data?.provider ?? "none"}
          onClose={() => setConfirm(null)}
          onDone={() => { setConfirm(null); setPick({}); void refresh(); }}
        />
      )}
      {linkFor && <LinkRouteModal num={linkFor} onClose={() => setLinkFor(null)} onDone={() => { setLinkFor(null); void refresh(); }} />}
    </>
  );
}

function ConfirmChange(props: {
  kind: "assign" | "rollback";
  num: VoiceNumber;
  target?: AiAgent;
  assignmentId?: string;
  targetName: string;
  currentName: string;
  isProtected: boolean;
  provider: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { kind, num, target, assignmentId, targetName, currentName, isProtected, provider } = props;
  // One key per confirmation dialog: a retry of the same click is idempotent.
  const [key] = useState(() => newIdempotencyKey(kind));
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; status?: string } | null>(null);
  const digits = (x: string) => x.replace(/\D/g, "");
  const confirmed = !isProtected || (digits(typed).length > 0 && digits(typed) === digits(num.number));

  async function run() {
    setBusy(true);
    setResult(null);
    let r: { ok: boolean; message: string; status?: string };
    if (kind === "assign") {
      r = await bindNumberToAgent(num, target, { confirmNumber: typed || undefined, idempotencyKey: key });
    } else {
      try {
        const res = await authFetch(`/api/voice-numbers/${encodeURIComponent(num.id)}/rollback`, { method: "POST", body: JSON.stringify({ assignmentId, idempotencyKey: key, confirmNumber: typed || undefined }) });
        const d = await res.json().catch(() => ({}));
        r = { ok: !!d.ok, message: d.message ?? d.error ?? `Request failed (${res.status}).`, status: d.status };
      } catch {
        r = { ok: false, message: "Couldn't confirm the result with Pydent — refresh to see the current routing before retrying." };
      }
    }
    setBusy(false);
    setResult(r);
    if (r.ok) toast(r.message, "success");
  }

  return (
    <Modal open onClose={busy ? () => {} : props.onClose} title={kind === "assign" ? "Reassign phone number" : "Restore previous routing"} subtitle={num.number}>
      <div className="space-y-3 text-sm">
        <div className="rounded-xl border border-ink-100 p-3">
          <p className="text-ink-500">Currently receiving calls: <span className="font-semibold text-ink-900">{currentName}</span></p>
          <p className="text-ink-500">New calls will go to: <span className="font-semibold text-ink-900">{targetName}</span></p>
          <p className="mt-1 text-[11px] text-ink-400">
            {provider === "livekit"
              ? "Pydent updates the existing LiveKit dispatch rule in place (same rule, same trunk) and verifies it before confirming."
              : provider === "vapi"
                ? "Pydent updates the Vapi phone number's assistant and verifies it before confirming."
                : "This number is not provider-routed: only Pydent's record changes."}{" "}
            Calls already in progress stay with their original agent.
          </p>
        </div>
        {isProtected && (
          <div className="rounded-xl border border-amber-300 bg-amber-500/5 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-amber-700"><ShieldAlert className="h-4 w-4" /> Production number — this changes who answers real patient calls.</p>
            <Field label={`Type ${num.number} to confirm`}>
              <input className={inputCls} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={num.number} autoComplete="off" />
            </Field>
          </div>
        )}
        {busy && <p className="flex items-center gap-2 text-xs text-amber-700"><Loader2 className="h-4 w-4 animate-spin" /> Pending — updating the provider and reading it back…</p>}
        {result && (
          <p className={`rounded-lg px-3 py-2 text-xs ${result.ok ? "bg-emerald-500/10 text-emerald-700" : result.status === "reconcile_needed" ? "bg-rose-500/10 text-rose-600" : "bg-amber-500/10 text-amber-700"}`}>
            {result.message}
          </p>
        )}
      </div>
      <div className="mt-6 flex justify-end gap-2">
        {result ? (
          <button onClick={props.onDone} className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700">Close</button>
        ) : (
          <>
            <button onClick={props.onClose} disabled={busy} className="rounded-xl border border-ink-200 px-4 py-2.5 text-sm font-semibold text-ink-700 hover:bg-ink-50 disabled:opacity-50">Cancel</button>
            <button onClick={() => void run()} disabled={busy || !confirmed} className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
              {busy ? "Verifying…" : kind === "assign" ? `Route new calls to ${targetName}` : `Restore ${targetName}`}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

// Register an EXISTING LiveKit inbound trunk + dispatch rule against a number.
// Read-only on LiveKit: the server verifies both objects and that they route to
// the agent Pydent already shows, then records the ids (and protects the number).
function LinkRouteModal({ num, onClose, onDone }: { num: VoiceNumber; onClose: () => void; onDone: () => void }) {
  const [trunkId, setTrunkId] = useState("");
  const [ruleId, setRuleId] = useState("");
  const [protect, setProtect] = useState(true);
  const [key] = useState(() => newIdempotencyKey("link"));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit() {
    setBusy(true);
    try {
      const res = await authFetch(`/api/voice-numbers/${encodeURIComponent(num.id)}/routing`, {
        method: "POST",
        body: JSON.stringify({ action: "link-livekit", trunkId: trunkId.trim(), ruleId: ruleId.trim(), protect, idempotencyKey: key }),
      });
      const d = await res.json().catch(() => ({}));
      setMsg({ ok: !!d.ok, text: d.message ?? d.error ?? `Request failed (${res.status}).` });
    } catch {
      setMsg({ ok: false, text: "Couldn't confirm the result — refresh before retrying." });
    }
    setBusy(false);
  }

  return (
    <Modal open onClose={busy ? () => {} : onClose} title="Link existing LiveKit route" subtitle={num.number}>
      <div className="space-y-3">
        <p className="rounded-xl border border-ink-100 bg-ink-50/60 p-3 text-xs text-ink-500">
          Pydent only READS these objects: it checks the rule is bound to exactly this trunk, that no other or wildcard rule overlaps it, and that it routes to the agent Pydent already shows. Nothing on LiveKit is changed.
        </p>
        <Field label="Inbound trunk id (ST_…)"><input className={inputCls} value={trunkId} onChange={(e) => setTrunkId(e.target.value)} placeholder="ST_…" autoComplete="off" /></Field>
        <Field label="Dispatch rule id (SDR_…)"><input className={inputCls} value={ruleId} onChange={(e) => setRuleId(e.target.value)} placeholder="SDR_…" autoComplete="off" /></Field>
        <label className="flex items-center gap-2 text-xs text-ink-600"><input type="checkbox" checked={protect} onChange={(e) => setProtect(e.target.checked)} /> Protected production number (typed confirmation for every change)</label>
        {msg && <p className={`rounded-lg px-3 py-2 text-xs ${msg.ok ? "bg-emerald-500/10 text-emerald-700" : "bg-amber-500/10 text-amber-700"}`}>{msg.text}</p>}
      </div>
      <div className="mt-6 flex justify-end gap-2">
        {msg?.ok ? (
          <button onClick={onDone} className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700">Close</button>
        ) : (
          <>
            <button onClick={onClose} disabled={busy} className="rounded-xl border border-ink-200 px-4 py-2.5 text-sm font-semibold text-ink-700 hover:bg-ink-50 disabled:opacity-50">Cancel</button>
            <button onClick={() => void submit()} disabled={busy || !trunkId.trim() || !ruleId.trim()} className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{busy ? "Verifying…" : "Verify and link"}</button>
          </>
        )}
      </div>
    </Modal>
  );
}
