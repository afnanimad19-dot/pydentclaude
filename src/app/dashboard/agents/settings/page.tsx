"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PhoneCall, Bot, Plus, X, RefreshCw, Phone, AlertTriangle, CheckCircle2, PhoneOutgoing, PhoneIncoming } from "lucide-react";
import { Card, PageHeader } from "@/components/ui";
import { inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import { fetchAgents, fetchVoiceNumbers, type AiAgent, type VoiceNumber } from "@/lib/db";
import { bindNumberToAgent } from "@/lib/voice-binding";

const PROVIDER_LABEL: Record<string, string> = {
  sip: "Custom SIP", ziwo: "Ziwo", goautodial: "Go Auto Dial", maqsam: "Maqsam", twilio: "Twilio (BYOT)", vocalcom: "Vocalcom", vapi: "Vapi", landline: "Clinic Landline",
};

export default function VoiceAgentSettingsPage() {
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [numbers, setNumbers] = useState<VoiceNumber[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({}); // agentId -> selected numberId

  function refresh() {
    fetchAgents().then((r) => setAgents(r.agents.filter((a) => a.kind === "voice")));
    fetchVoiceNumbers().then(setNumbers);
  }
  useEffect(() => { refresh(); }, []);

  const unassigned = useMemo(() => numbers.filter((n) => !n.agentId), [numbers]);

  async function assign(agent: AiAgent, numberId: string) {
    const num = numbers.find((n) => n.id === numberId);
    if (!num) return;
    setBusy(agent.id);
    const res = await bindNumberToAgent(num, agent);
    setBusy(null);
    toast(res.message, res.ok ? "success" : "info");
    setPick((p) => ({ ...p, [agent.id]: "" }));
    refresh();
  }

  async function unassign(num: VoiceNumber) {
    setBusy(num.agentId ?? num.id);
    const res = await bindNumberToAgent(num, undefined);
    setBusy(null);
    toast(res.message, res.ok ? "success" : "info");
    refresh();
  }

  return (
    <>
      <PageHeader
        title="Voice Agent Settings"
        subtitle="Connect an existing phone number to a voice agent. The agent answers inbound calls on that number and uses it as the caller ID for outbound campaigns — we configure Vapi for you automatically."
        actions={
          <button onClick={refresh} className="flex items-center gap-2 rounded-xl border border-ink-200 px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50">
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
        }
      />

      {numbers.length === 0 && (
        <Card className="mb-5 flex items-center gap-3 border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-700">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <span>No phone numbers connected yet. Add one in <Link href="/dashboard/agents/phone-numbers" className="font-semibold underline">Phone Numbers</Link> first, then assign it to an agent here.</span>
        </Card>
      )}

      {agents.length === 0 ? (
        <Card className="p-10 text-center text-sm text-ink-500">
          <Bot className="mx-auto mb-2 h-6 w-6 text-ink-300" /> No voice agents yet — create one in <Link href="/dashboard/agents/voice" className="font-semibold text-brand-600">All voice agents</Link>.
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {agents.map((agent) => {
            const mine = numbers.filter((n) => n.agentId === agent.id);
            const selectable = [...unassigned, ...numbers.filter((n) => n.agentId && n.agentId !== agent.id)];
            return (
              <Card key={agent.id} className="flex flex-col p-5">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="rounded-xl bg-brand-500/15 p-2 text-brand-600"><PhoneCall className="h-5 w-5" /></div>
                    <div>
                      <p className="font-semibold text-ink-900">{agent.name}</p>
                      <p className="text-xs text-ink-400">{agent.role}</p>
                    </div>
                  </div>
                  {agent.vapiAssistantId ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-600"><CheckCircle2 className="h-3 w-3" /> Synced to Vapi</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-700"><AlertTriangle className="h-3 w-3" /> Not synced</span>
                  )}
                </div>

                {!agent.vapiAssistantId && (
                  <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                    Open <Link href="/dashboard/agents/voice" className="font-semibold underline">{agent.name}</Link> and Save once so it syncs to Vapi — then assigning a number here will route real calls to it.
                  </p>
                )}

                <div className="mt-4">
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400">Assigned numbers</p>
                  {mine.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-ink-200 px-3 py-3 text-center text-xs text-ink-400">No number assigned yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {mine.map((n) => (
                        <div key={n.id} className="flex items-center justify-between rounded-lg border border-ink-100 px-3 py-2">
                          <div className="min-w-0">
                            <p className="flex items-center gap-1.5 text-sm font-semibold text-ink-900"><Phone className="h-3.5 w-3.5 text-ink-400" /> {n.number}</p>
                            <p className="flex items-center gap-2 text-[11px] text-ink-400">
                              <span>{PROVIDER_LABEL[n.provider] ?? n.provider}</span>
                              <span className="inline-flex items-center gap-1 capitalize">
                                {n.direction === "outbound" ? <PhoneOutgoing className="h-3 w-3" /> : n.direction === "both" ? <PhoneCall className="h-3 w-3" /> : <PhoneIncoming className="h-3 w-3" />}
                                {n.direction}
                              </span>
                              {n.vapiPhoneNumberId ? <span className="text-emerald-600">· live on Vapi</span> : <span className="text-amber-600">· not on Vapi yet</span>}
                            </p>
                          </div>
                          <button onClick={() => unassign(n)} disabled={busy === agent.id} className="rounded-lg p-1.5 text-ink-400 hover:bg-rose-500/10 hover:text-rose-500 disabled:opacity-50" title="Unassign"><X className="h-4 w-4" /></button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="mt-4 flex items-center gap-2 border-t border-ink-100 pt-4">
                  <select
                    className={`${inputCls} flex-1`}
                    value={pick[agent.id] ?? ""}
                    onChange={(e) => setPick((p) => ({ ...p, [agent.id]: e.target.value }))}
                    disabled={selectable.length === 0}
                  >
                    <option value="">{selectable.length === 0 ? "No available numbers" : "Assign an existing number…"}</option>
                    {selectable.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.number}{n.nickname ? ` (${n.nickname})` : ""}{n.agentId ? " — currently on another agent" : ""}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => pick[agent.id] && assign(agent, pick[agent.id])}
                    disabled={!pick[agent.id] || busy === agent.id}
                    className="flex items-center gap-1.5 rounded-xl bg-brand-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                  >
                    <Plus className="h-4 w-4" /> {busy === agent.id ? "Connecting…" : "Assign"}
                  </button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
