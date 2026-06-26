"use client";

import { useEffect, useState } from "react";
import { Phone, Plus, Trash2, Info, Server, ArrowLeft } from "lucide-react";
import { Card, PageHeader } from "@/components/ui";
import { Modal, Field, ModalFooter, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import {
  fetchVoiceNumbers,
  createVoiceNumber,
  deleteVoiceNumber,
  fetchAgents,
  type VoiceNumber,
  type SipCategory,
  type AiAgent,
} from "@/lib/db";

export default function PhoneNumbersPage() {
  const [numbers, setNumbers] = useState<VoiceNumber[]>([]);
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [open, setOpen] = useState(false);

  function refresh() { fetchVoiceNumbers().then(setNumbers); }
  useEffect(() => {
    refresh();
    fetchAgents().then((r) => setAgents(r.agents.filter((a) => a.kind === "voice")));
  }, []);

  return (
    <>
      {open && <AddNumberModal agents={agents} onClose={() => setOpen(false)} onAdded={() => { setOpen(false); refresh(); }} />}
      <PageHeader
        title="Phone Numbers"
        subtitle="Connect a number to a voice agent — import an existing one, bring a Twilio number, or build a SIP trunk."
        actions={
          <button onClick={() => setOpen(true)} className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
            <Plus className="h-4 w-4" /> Add phone number
          </button>
        }
      />

      {numbers.length === 0 ? (
        <Card className="p-10 text-center text-sm text-ink-500">
          <Phone className="mx-auto mb-2 h-6 w-6 text-ink-300" /> No phone numbers yet — add one and assign a voice agent.
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-ink-200 bg-ink-50/50 text-left text-xs uppercase tracking-wide text-ink-400">
                <th className="px-5 py-3 font-semibold">Number</th>
                <th className="px-5 py-3 font-semibold">Nickname</th>
                <th className="px-5 py-3 font-semibold">Type</th>
                <th className="px-5 py-3 font-semibold">Concurrency</th>
                <th className="px-5 py-3 font-semibold">Direction</th>
                <th className="px-5 py-3 font-semibold">Agent</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {numbers.map((n) => (
                <tr key={n.id} className="border-b border-ink-100 last:border-0">
                  <td className="px-5 py-3 font-medium text-ink-900"><span className="flex items-center gap-2"><Phone className="h-4 w-4 text-brand-500" /> {n.number}</span></td>
                  <td className="px-5 py-3 text-ink-600">{n.nickname || "—"}</td>
                  <td className="px-5 py-3"><span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium uppercase text-ink-600">{n.provider}</span></td>
                  <td className="px-5 py-3 text-ink-600">{n.concurrency}</td>
                  <td className="px-5 py-3 capitalize text-ink-600">{n.direction}</td>
                  <td className="px-5 py-3 text-ink-600">{agents.find((a) => a.id === n.agentId)?.name ?? "— not assigned —"}</td>
                  <td className="px-5 py-3 text-right">
                    <button onClick={async () => { await deleteVoiceNumber(n.id); refresh(); }} className="rounded-lg p-1.5 text-ink-400 hover:bg-rose-500/10 hover:text-rose-500"><Trash2 className="h-4 w-4" /></button>
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

type Method = "existing" | "twilio" | "sip" | null;

function AddNumberModal({ agents, onClose, onAdded }: { agents: AiAgent[]; onClose: () => void; onAdded: () => void }) {
  const [method, setMethod] = useState<Method>(null);

  if (!method) {
    return (
      <Modal open onClose={onClose} title="Add a phone number" subtitle="Choose how you want to connect a number.">
        <div className="grid gap-3">
          <MethodCard icon={Phone} title="Add an existing number" detail="A number already in Vapi — just register it here and assign an agent." onClick={() => setMethod("existing")} />
          <MethodCard icon={Phone} title="Import from Twilio" detail="Bring a Twilio number (Account SID + Auth Token)." onClick={() => setMethod("twilio")} />
          <MethodCard icon={Server} title="Create a SIP trunk from scratch" detail="For a UAE +971 or carrier number via SIP — full trunk configuration." onClick={() => setMethod("sip")} />
        </div>
      </Modal>
    );
  }
  if (method === "existing") return <ExistingForm agents={agents} onBack={() => setMethod(null)} onClose={onClose} onAdded={onAdded} />;
  if (method === "twilio") return <TwilioForm agents={agents} onBack={() => setMethod(null)} onClose={onClose} onAdded={onAdded} />;
  return <SipForm agents={agents} onBack={() => setMethod(null)} onClose={onClose} onAdded={onAdded} />;
}

function MethodCard({ icon: Icon, title, detail, onClick }: { icon: typeof Phone; title: string; detail: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-start gap-3 rounded-xl border border-ink-200 p-4 text-left hover:border-brand-400 hover:bg-brand-50/40">
      <div className="rounded-lg bg-brand-500/15 p-2 text-brand-600"><Icon className="h-5 w-5" /></div>
      <div><p className="text-sm font-semibold text-ink-900">{title}</p><p className="text-xs text-ink-500">{detail}</p></div>
    </button>
  );
}

function AgentDir({ agentId, setAgentId, direction, setDirection, agents }: { agentId: string; setAgentId: (v: string) => void; direction: string; setDirection: (v: string) => void; agents: AiAgent[] }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Field label="Assign voice agent">
        <select className={inputCls} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">Choose agent…</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name} — {a.role}</option>)}
        </select>
      </Field>
      <Field label="Direction">
        <select className={inputCls} value={direction} onChange={(e) => setDirection(e.target.value)}>
          <option value="inbound">Inbound</option><option value="outbound">Outbound</option><option value="both">Both</option>
        </select>
      </Field>
    </div>
  );
}

function BackBar({ onBack, title }: { onBack: () => void; title: string }) {
  return <button onClick={onBack} className="mb-3 flex items-center gap-1.5 text-sm font-medium text-ink-500 hover:text-ink-800"><ArrowLeft className="h-4 w-4" /> {title}</button>;
}

function ExistingForm({ agents, onBack, onClose, onAdded }: { agents: AiAgent[]; onBack: () => void; onClose: () => void; onAdded: () => void }) {
  const [number, setNumber] = useState(""); const [nickname, setNickname] = useState(""); const [agentId, setAgentId] = useState(""); const [direction, setDirection] = useState("inbound"); const [saving, setSaving] = useState(false);
  async function submit() {
    if (!number.trim()) { toast("Enter the number.", "info"); return; }
    setSaving(true);
    const res = await createVoiceNumber({ number: number.trim(), nickname, agentId: agentId || null, direction: direction as VoiceNumber["direction"], provider: "vapi", concurrency: 1, config: {} });
    setSaving(false);
    if (!res.ok) { toast(res.message, "info"); return; } toast("Number added.", "success"); onAdded();
  }
  return (
    <Modal open onClose={onClose} title="Add an existing number">
      <BackBar onBack={onBack} title="Back" />
      <div className="space-y-4">
        <Field label="Phone number (E.164, e.g. +9714…)"><input className={inputCls} value={number} onChange={(e) => setNumber(e.target.value)} /></Field>
        <Field label="Nickname"><input className={inputCls} placeholder="Reception line" value={nickname} onChange={(e) => setNickname(e.target.value)} /></Field>
        <AgentDir agentId={agentId} setAgentId={setAgentId} direction={direction} setDirection={setDirection} agents={agents} />
      </div>
      <ModalFooter onClose={onClose} submitLabel={saving ? "Adding…" : "Add number"} onSubmit={submit} />
    </Modal>
  );
}

function TwilioForm({ agents, onBack, onClose, onAdded }: { agents: AiAgent[]; onBack: () => void; onClose: () => void; onAdded: () => void }) {
  const [number, setNumber] = useState(""); const [nickname, setNickname] = useState(""); const [sid, setSid] = useState(""); const [token, setToken] = useState(""); const [agentId, setAgentId] = useState(""); const [direction, setDirection] = useState("inbound"); const [saving, setSaving] = useState(false);
  async function submit() {
    if (!number.trim() || !sid.trim() || !token.trim()) { toast("Number, Account SID and Auth Token are required.", "info"); return; }
    setSaving(true);
    const res = await createVoiceNumber({ number: number.trim(), nickname, agentId: agentId || null, direction: direction as VoiceNumber["direction"], provider: "twilio", concurrency: 1, config: { twilioAccountSid: sid.trim(), twilioAuthToken: token.trim() } });
    setSaving(false);
    if (!res.ok) { toast(res.message, "info"); return; } toast("Twilio number added.", "success"); onAdded();
  }
  return (
    <Modal open onClose={onClose} title="Import from Twilio">
      <BackBar onBack={onBack} title="Back" />
      <div className="space-y-4">
        <Field label="Phone number"><input className={inputCls} placeholder="+1…" value={number} onChange={(e) => setNumber(e.target.value)} /></Field>
        <Field label="Nickname"><input className={inputCls} value={nickname} onChange={(e) => setNickname(e.target.value)} /></Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Twilio Account SID"><input className={inputCls} placeholder="ACxxxxxxxx" value={sid} onChange={(e) => setSid(e.target.value)} /></Field>
          <Field label="Twilio Auth Token"><input type="password" className={inputCls} value={token} onChange={(e) => setToken(e.target.value)} /></Field>
        </div>
        <AgentDir agentId={agentId} setAgentId={setAgentId} direction={direction} setDirection={setDirection} agents={agents} />
      </div>
      <ModalFooter onClose={onClose} submitLabel={saving ? "Importing…" : "Import number"} onSubmit={submit} />
    </Modal>
  );
}

function Check({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-2 rounded-lg border border-ink-100 px-3 py-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#7c3aed]" />
      <span><span className="font-medium text-ink-800">{label}</span><span className="block text-xs text-ink-400">{detail}</span></span>
    </label>
  );
}

function SipForm({ agents, onBack, onClose, onAdded }: { agents: AiAgent[]; onBack: () => void; onClose: () => void; onAdded: () => void }) {
  const [number, setNumber] = useState(""); const [nickname, setNickname] = useState(""); const [concurrency, setConcurrency] = useState(1);
  const [agentId, setAgentId] = useState(""); const [direction, setDirection] = useState("inbound");
  const [terminationUri, setTerminationUri] = useState("");
  const [e164, setE164] = useState(true); const [requiresReg, setRequiresReg] = useState(false); const [publicIp, setPublicIp] = useState(false);
  const [username, setUsername] = useState(""); const [password, setPassword] = useState("");
  const [categories, setCategories] = useState<SipCategory[]>([]);
  const [saving, setSaving] = useState(false);

  function addCategory() { setCategories((c) => [...c, { ipOrDomain: "", port: "5060", protocol: "UDP", direction: "inbound", active: true, ping: false }]); }
  function setCat(i: number, patch: Partial<SipCategory>) { setCategories((c) => c.map((x, idx) => (idx === i ? { ...x, ...patch } : x))); }

  async function submit() {
    if (!number.trim()) { toast("Enter the phone number.", "info"); return; }
    setSaving(true);
    const res = await createVoiceNumber({
      number: number.trim(), nickname, agentId: agentId || null, direction: direction as VoiceNumber["direction"], provider: "sip", concurrency,
      config: { terminationUri: terminationUri.trim(), e164LeadingPlus: e164, requiresRegistration: requiresReg, registeredPublicIp: publicIp, username: requiresReg ? username : "", password: requiresReg ? password : "", categories },
    });
    setSaving(false);
    if (!res.ok) { toast(res.message, "info"); return; } toast("SIP trunk number created.", "success"); onAdded();
  }

  return (
    <Modal open onClose={onClose} title="Create a SIP trunk" subtitle="Connect a carrier / UAE +971 number over SIP." wide>
      <BackBar onBack={onBack} title="Back" />
      <div className="max-h-[62vh] space-y-4 overflow-y-auto pr-1">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Phone number"><input className={inputCls} placeholder="+9714…" value={number} onChange={(e) => setNumber(e.target.value)} /></Field>
          <Field label="Nickname"><input className={inputCls} placeholder="Clinic SIP" value={nickname} onChange={(e) => setNickname(e.target.value)} /></Field>
          <Field label="Concurrency limit (max simultaneous calls)"><input type="number" min={1} className={inputCls} value={concurrency} onChange={(e) => setConcurrency(Math.max(1, Number(e.target.value) || 1))} /></Field>
        </div>
        <AgentDir agentId={agentId} setAgentId={setAgentId} direction={direction} setDirection={setDirection} agents={agents} />

        <Field label="SIP termination URI (host / domain)"><input className={inputCls} placeholder="sip.yourprovider.com" value={terminationUri} onChange={(e) => setTerminationUri(e.target.value)} /></Field>

        <div className="grid gap-2">
          <Check label="E.164 leading plus" detail="Add a leading plus to all phone numbers, e.g. +1234567890." checked={e164} onChange={setE164} />
          <Check label="Requires registration" detail="This SIP trunk requires registration (username + password)." checked={requiresReg} onChange={setRequiresReg} />
          <Check label="Registered public IP in contact" detail="Use the public address listed in your SIP trunk connector header for proper routing." checked={publicIp} onChange={setPublicIp} />
        </div>
        {requiresReg && (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="SIP username"><input className={inputCls} value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
            <Field label="SIP password"><input type="password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          </div>
        )}

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-sm font-medium text-ink-700">Categories (gateways)</p>
            <button onClick={addCategory} className="flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"><Plus className="h-3 w-3" /> Add category</button>
          </div>
          {categories.length === 0 ? (
            <p className="rounded-lg border border-dashed border-ink-200 px-3 py-3 text-center text-xs text-ink-400">No categories — add a gateway IP/domain + port.</p>
          ) : (
            <div className="space-y-2">
              {categories.map((c, i) => (
                <div key={i} className="rounded-lg border border-ink-100 p-2.5">
                  <div className="grid gap-2 md:grid-cols-4">
                    <input className={inputCls} placeholder="IP address / domain" value={c.ipOrDomain} onChange={(e) => setCat(i, { ipOrDomain: e.target.value })} />
                    <input className={inputCls} placeholder="Port (5060)" value={c.port} onChange={(e) => setCat(i, { port: e.target.value })} />
                    <select className={inputCls} value={c.protocol} onChange={(e) => setCat(i, { protocol: e.target.value as SipCategory["protocol"] })}><option>UDP</option><option>TCP</option><option>TLS</option></select>
                    <select className={inputCls} value={c.direction} onChange={(e) => setCat(i, { direction: e.target.value as SipCategory["direction"] })}><option value="inbound">Inbound</option><option value="outbound">Outbound</option></select>
                  </div>
                  <div className="mt-2 flex items-center gap-4 text-xs text-ink-600">
                    <label className="flex items-center gap-1.5"><input type="checkbox" checked={c.active} onChange={(e) => setCat(i, { active: e.target.checked })} className="h-3.5 w-3.5 accent-[#7c3aed]" /> Active</label>
                    <label className="flex items-center gap-1.5"><input type="checkbox" checked={c.ping} onChange={(e) => setCat(i, { ping: e.target.checked })} className="h-3.5 w-3.5 accent-[#7c3aed]" /> Ping</label>
                    <button onClick={() => setCategories((cs) => cs.filter((_, idx) => idx !== i))} className="ml-auto text-rose-500 hover:underline">Remove</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-start gap-2 rounded-xl border border-ink-100 bg-ink-50/60 p-3 text-xs text-ink-500">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Pydent stores this trunk config and assigns the agent. The live SIP connection is completed in Vapi (Phone Numbers → SIP/BYO) using these same values. See VOICE_SETUP.md.
        </div>
      </div>
      <ModalFooter onClose={onClose} submitLabel={saving ? "Creating…" : "Create number"} onSubmit={submit} />
    </Modal>
  );
}
