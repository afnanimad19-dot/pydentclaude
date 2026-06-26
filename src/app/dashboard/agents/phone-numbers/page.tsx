"use client";

import { useEffect, useState } from "react";
import { Phone, Plus, Trash2, Info } from "lucide-react";
import { Card, PageHeader } from "@/components/ui";
import { Modal, Field, ModalFooter, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import { fetchPhoneLines, addPhoneLine, removePhoneLine, fetchAgents, type PhoneLine, type AiAgent } from "@/lib/db";

export default function PhoneNumbersPage() {
  const [lines, setLines] = useState<PhoneLine[]>([]);
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [open, setOpen] = useState(false);

  function refresh() { fetchPhoneLines().then(setLines); }
  useEffect(() => {
    refresh();
    fetchAgents().then((r) => setAgents(r.agents.filter((a) => a.kind === "voice")));
  }, []);

  return (
    <>
      {open && <AddNumberModal agents={agents} onClose={() => setOpen(false)} onAdded={() => { setOpen(false); refresh(); }} />}
      <PageHeader
        title="Phone Numbers"
        subtitle="Connect a phone number to a voice agent — inbound calls are answered by the agent."
        actions={
          <button onClick={() => setOpen(true)} className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
            <Plus className="h-4 w-4" /> Add phone number
          </button>
        }
      />

      <Card className="mb-6 flex items-start gap-2 p-4 text-sm text-ink-500">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
        <span>
          Numbers run through <strong>Vapi</strong>. Buy a number in Vapi (or import a Twilio / SIP number), then add it here and
          assign a voice agent. For a UAE <strong>+971</strong> local number, import it from Twilio or your carrier as a SIP trunk
          — see <strong>VOICE_SETUP.md</strong> for the steps.
        </span>
      </Card>

      {lines.length === 0 ? (
        <Card className="p-10 text-center text-sm text-ink-500">No phone numbers yet — add one and assign a voice agent.</Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-200 bg-ink-50/50 text-left text-xs uppercase tracking-wide text-ink-400">
                <th className="px-5 py-3 font-semibold">Number</th>
                <th className="px-5 py-3 font-semibold">Direction</th>
                <th className="px-5 py-3 font-semibold">Voice agent</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className="border-b border-ink-100 last:border-0">
                  <td className="px-5 py-3 font-medium text-ink-900"><span className="flex items-center gap-2"><Phone className="h-4 w-4 text-brand-500" /> {l.number}</span></td>
                  <td className="px-5 py-3 capitalize text-ink-600">{l.direction}</td>
                  <td className="px-5 py-3 text-ink-600">{agents.find((a) => a.id === l.agentId)?.name ?? "— not assigned —"}</td>
                  <td className="px-5 py-3 text-right">
                    <button onClick={async () => { await removePhoneLine(l.id); refresh(); }} className="rounded-lg p-1.5 text-ink-400 hover:bg-rose-500/10 hover:text-rose-500"><Trash2 className="h-4 w-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

function AddNumberModal({ agents, onClose, onAdded }: { agents: AiAgent[]; onClose: () => void; onAdded: () => void }) {
  const [number, setNumber] = useState("");
  const [agentId, setAgentId] = useState("");
  const [direction, setDirection] = useState<PhoneLine["direction"]>("inbound");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!number.trim()) { toast("Enter the phone number.", "info"); return; }
    setSaving(true);
    const res = await addPhoneLine(number.trim(), agentId || null, direction);
    setSaving(false);
    if (!res.ok) { toast(res.message, "info"); return; }
    toast("Phone number added.", "success");
    onAdded();
  }

  return (
    <Modal open onClose={onClose} title="Add a phone number" subtitle="Connect a Vapi / Twilio / SIP number to a voice agent.">
      <div className="space-y-4">
        <Field label="Phone number (E.164, e.g. +971 4 398 5241)">
          <input className={inputCls} placeholder="+9714xxxxxxx" value={number} onChange={(e) => setNumber(e.target.value)} />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Assign voice agent">
            <select className={inputCls} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">Choose agent…</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name} — {a.role}</option>)}
            </select>
          </Field>
          <Field label="Direction">
            <select className={inputCls} value={direction} onChange={(e) => setDirection(e.target.value as PhoneLine["direction"])}>
              <option value="inbound">Inbound</option>
              <option value="outbound">Outbound</option>
              <option value="both">Both</option>
            </select>
          </Field>
        </div>
        <div className="rounded-xl border border-ink-100 bg-ink-50/60 p-3 text-xs leading-relaxed text-ink-500">
          <strong>Where the number comes from:</strong> buy/import it in <strong>Vapi → Phone Numbers</strong> (Vapi can provision
          a number or import a Twilio/SIP one). For a <strong>UAE +971</strong> number, get it from Twilio or your carrier and add it
          to Vapi as a SIP trunk. Then paste it here and assign the agent.
        </div>
      </div>
      <ModalFooter onClose={onClose} submitLabel={saving ? "Adding…" : "Add number"} onSubmit={submit} />
    </Modal>
  );
}
