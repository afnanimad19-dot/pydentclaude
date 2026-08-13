"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Phone, Plus, Trash2, Info, Server, ArrowLeft, Search, RefreshCw, MoreVertical, Radio, PhoneForwarded, LayoutGrid, Smartphone, Network, Pencil, Home } from "lucide-react";
import { Card, PageHeader } from "@/components/ui";
import { Modal, Field, ModalFooter, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import {
  fetchVoiceNumbers,
  createVoiceNumber,
  deleteVoiceNumber,
  updateVoiceNumber,
  fetchAgents,
  type VoiceNumber,
  type SipCategory,
  type AiAgent,
} from "@/lib/db";
import { bindNumberToAgent } from "@/lib/voice-binding";

type ProviderKey = "landline" | "sip" | "ziwo" | "goautodial" | "maqsam" | "twilio" | "vocalcom";

const PROVIDERS: { key: ProviderKey; name: string; desc: string; icon: typeof Phone; color: string }[] = [
  { key: "landline", name: "Clinic Landline (on-prem)", desc: "Your existing landline answers with the AI agent — via a small on-prem box (Raspberry Pi / mini-PC).", icon: Home, color: "text-brand-500 bg-brand-500/10" },
  { key: "sip", name: "Custom SIP Trunk", desc: "Connect your own SIP trunk configuration", icon: Server, color: "text-violet-500 bg-violet-500/10" },
  { key: "ziwo", name: "Ziwo", desc: "Add extensions from your Ziwo account", icon: Radio, color: "text-fuchsia-500 bg-fuchsia-500/10" },
  { key: "goautodial", name: "Go Auto Dial", desc: "Connect extensions from Go Auto Dial system", icon: PhoneForwarded, color: "text-emerald-500 bg-emerald-500/10" },
  { key: "maqsam", name: "Maqsam", desc: "Add numbers from Maqsam provider", icon: LayoutGrid, color: "text-rose-500 bg-rose-500/10" },
  { key: "twilio", name: "BYOT Phone", desc: "Bring your own Twilio phone number", icon: Smartphone, color: "text-red-500 bg-red-500/10" },
  { key: "vocalcom", name: "Vocalcom Hermes", desc: "Add phone numbers from Vocalcom Hermes", icon: Network, color: "text-blue-500 bg-blue-500/10" },
];

const PROVIDER_LABEL: Record<string, string> = {
  landline: "Clinic Landline (on-prem)", sip: "Custom SIP Trunk", ziwo: "Ziwo", goautodial: "Go Auto Dial", maqsam: "Maqsam", twilio: "BYOT Phone", vocalcom: "Vocalcom Hermes", vapi: "Vapi",
};

// Per-provider credential fields (stored in config; live connection done in the
// provider / Vapi). SIP has its own richer form below.
const PROVIDER_FIELDS: Record<string, { key: string; label: string; placeholder?: string; password?: boolean }[]> = {
  ziwo: [
    { key: "subdomain", label: "Ziwo subdomain", placeholder: "yourcompany" },
    { key: "apiKey", label: "API key", password: true },
    { key: "extension", label: "Extension", placeholder: "1001" },
  ],
  goautodial: [
    { key: "serverUrl", label: "Server URL", placeholder: "https://dialer.yourclinic.com" },
    { key: "username", label: "Username" },
    { key: "password", label: "Password", password: true },
    { key: "extension", label: "Extension", placeholder: "1001" },
  ],
  maqsam: [
    { key: "apiKey", label: "API key", password: true },
    { key: "apiSecret", label: "API secret", password: true },
  ],
  vocalcom: [
    { key: "endpoint", label: "Hermes endpoint", placeholder: "https://hermes.yourclinic.com" },
    { key: "apiKey", label: "API key", password: true },
  ],
  twilio: [
    { key: "twilioAccountSid", label: "Twilio Account SID", placeholder: "ACxxxxxxxx" },
    { key: "twilioAuthToken", label: "Twilio Auth Token", password: true },
  ],
};

// After saving a number with an assigned agent, register it on Vapi + attach the
// agent so inbound calls actually route to that agent. Returns a status message.
async function connectNumberToVapi(opts: { provider: string; number: string; nickname: string; agent?: AiAgent; config: Record<string, unknown> }): Promise<{ ok: boolean; message: string; vapiPhoneNumberId?: string }> {
  if (!opts.agent) return { ok: false, message: "Saved — but assign a voice agent so the number can be registered on Vapi and answer calls." };
  if (!opts.agent.vapiAssistantId) return { ok: false, message: `Saved — but open "${opts.agent.name}" and Save it once so it syncs to Vapi, then Edit this number to connect it.` };
  try {
    const res = await fetch("/api/vapi/phone-numbers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: opts.provider, number: opts.number, nickname: opts.nickname, assistantId: opts.agent.vapiAssistantId, config: opts.config }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok && data.vapiPhoneNumberId) return { ok: true, message: data.message ?? "Number connected to Vapi.", vapiPhoneNumberId: data.vapiPhoneNumberId };
    return { ok: false, message: `Saved locally, but NOT registered on Vapi — ${data.error ?? "Vapi error"}. Fix it and use Edit → reassign the agent to retry.` };
  } catch {
    return { ok: false, message: "Saved locally, but couldn't reach Vapi to register the number. Try Edit → reassign the agent to retry." };
  }
}

function fmtDate(iso: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function PhoneNumbersPage() {
  const [numbers, setNumbers] = useState<VoiceNumber[]>([]);
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  function refresh() { fetchVoiceNumbers().then(setNumbers); }
  useEffect(() => {
    refresh();
    fetchAgents().then((r) => setAgents(r.agents.filter((a) => a.kind === "voice")));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return numbers.filter((n) => {
      if (providerFilter && n.provider !== providerFilter) return false;
      const status = (n.config?.status as string) || "active";
      if (statusFilter && status !== statusFilter) return false;
      if (!q) return true;
      return [n.number, n.nickname].some((v) => String(v).toLowerCase().includes(q));
    });
  }, [numbers, query, providerFilter, statusFilter]);

  return (
    <>
      {open && <AddNumberModal agents={agents} onClose={() => setOpen(false)} onAdded={() => { setOpen(false); refresh(); }} />}
      <PageHeader
        title="Phone Numbers"
        subtitle="Manage phone numbers for your calling campaigns — SIP trunk, Twilio (BYOT), Ziwo, Maqsam, Go Auto Dial or Vocalcom Hermes."
        actions={
          <button onClick={() => setOpen(true)} className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
            <Plus className="h-4 w-4" /> Add Phone Number
          </button>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search phone numbers…" className="w-full rounded-xl border border-ink-200 bg-surface py-2.5 pl-9 pr-3 text-sm text-ink-800 outline-none placeholder:text-ink-400 focus:border-brand-400" />
        </div>
        <select value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)} className="rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-700 outline-none">
          <option value="">All Providers</option>
          {PROVIDERS.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-700 outline-none">
          <option value="">All Statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        <button onClick={refresh} title="Refresh" className="rounded-xl border border-ink-200 p-2.5 text-ink-500 hover:bg-ink-50"><RefreshCw className="h-4 w-4" /></button>
      </div>

      {filtered.length === 0 ? (
        <Card className="p-10 text-center text-sm text-ink-500">
          <Phone className="mx-auto mb-2 h-6 w-6 text-ink-300" /> No phone numbers yet — add one and assign a voice agent.
        </Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((n) => (
              <NumberCard key={n.id} n={n} agents={agents} onChanged={refresh} />
            ))}
          </div>
          <p className="mt-6 text-center text-sm text-ink-400">You&apos;ve reached the end of the list.</p>
        </>
      )}
    </>
  );
}

function NumberCard({ n, agents, onChanged }: { n: VoiceNumber; agents: AiAgent[]; onChanged: () => void }) {
  const [menu, setMenu] = useState(false);
  const [edit, setEdit] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setMenu(false); }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  const status = (n.config?.status as string) || "active";
  const numberType = (n.config?.numberType as string) || "national";
  const scope = (n.config?.scope as string) || "Global";
  const agentName = agents.find((a) => a.id === n.agentId)?.name;

  async function del() {
    if (!confirm(`Delete ${n.number}? This cannot be undone.`)) return;
    await deleteVoiceNumber(n.id);
    toast("Phone number deleted.", "success");
    onChanged();
  }

  return (
    <Card className="flex flex-col p-5">
      {edit && <EditNumberModal n={n} agents={agents} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); onChanged(); }} />}
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-ink-500">{PROVIDER_LABEL[n.provider] ?? n.provider}</p>
        <div className="relative" ref={ref}>
          <button onClick={() => setMenu((m) => !m)} className="rounded-lg p-1 text-ink-400 hover:bg-ink-100"><MoreVertical className="h-4 w-4" /></button>
          {menu && (
            <div className="absolute right-0 z-10 mt-1 w-36 rounded-xl border border-ink-200 bg-surface py-1 shadow-lg">
              <button onClick={() => { setMenu(false); setEdit(true); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-700 hover:bg-ink-50"><Pencil className="h-4 w-4" /> Edit</button>
              <button onClick={del} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-rose-600 hover:bg-rose-500/10"><Trash2 className="h-4 w-4" /> Delete</button>
            </div>
          )}
        </div>
      </div>

      <p className="mt-1 text-2xl font-bold tracking-tight text-ink-900">{n.number}</p>
      <p className="mt-0.5 text-sm text-ink-500">{n.nickname || "Untitled number"}</p>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="rounded-md bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-600">{numberType}</span>
        <span className="rounded-md bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-600">{scope}</span>
        <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${status === "active" ? "bg-emerald-500/15 text-emerald-600" : "bg-ink-100 text-ink-500"}`}>{status}</span>
        {agentName && <span className="rounded-md bg-brand-500/10 px-2 py-0.5 text-xs font-medium text-brand-600">{agentName}</span>}
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-ink-100 pt-3 text-[11px] text-ink-400">
        <span>Created {fmtDate(n.createdAt)}</span>
        <span className="capitalize">{n.direction}</span>
      </div>
    </Card>
  );
}

// Edit a saved number: nickname, direction, and which agent answers it. Changing
// the agent re-routes inbound on Vapi via bindNumberToAgent.
function EditNumberModal({ n, agents, onClose, onSaved }: { n: VoiceNumber; agents: AiAgent[]; onClose: () => void; onSaved: () => void }) {
  const [nickname, setNickname] = useState(n.nickname);
  const [direction, setDirection] = useState<VoiceNumber["direction"]>(n.direction);
  const [agentId, setAgentId] = useState(n.agentId ?? "");
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    await updateVoiceNumber(n.id, { nickname, direction });
    let msg = "Number updated.";
    if (agentId !== (n.agentId ?? "")) {
      const res = await bindNumberToAgent({ ...n, nickname, direction }, agents.find((a) => a.id === agentId));
      msg = res.message;
    }
    setSaving(false);
    toast(msg, "success");
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title={`Edit ${n.number}`} subtitle="Change the label, direction or assigned agent." z="z-[60]">
      <div className="space-y-4">
        <Field label="Label / nickname"><input className={inputCls} value={nickname} onChange={(e) => setNickname(e.target.value)} /></Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Assigned voice agent">
            <select className={inputCls} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">Unassigned</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name} — {a.role}</option>)}
            </select>
          </Field>
          <Field label="Direction">
            <select className={inputCls} value={direction} onChange={(e) => setDirection(e.target.value as VoiceNumber["direction"])}>
              <option value="inbound">Inbound</option><option value="outbound">Outbound</option><option value="both">Both</option>
            </select>
          </Field>
        </div>
      </div>
      <ModalFooter onClose={onClose} submitLabel={saving ? "Saving…" : "Save changes"} onSubmit={submit} />
    </Modal>
  );
}

function AddNumberModal({ agents, onClose, onAdded }: { agents: AiAgent[]; onClose: () => void; onAdded: () => void }) {
  const [provider, setProvider] = useState<ProviderKey | null>(null);

  if (!provider) {
    return (
      <Modal open onClose={onClose} title="Add New Phone Number" subtitle="Select the type of phone number you want to add." wide>
        <div className="grid gap-3 md:grid-cols-2">
          {PROVIDERS.map((p) => (
            <button
              key={p.key}
              onClick={() => setProvider(p.key)}
              className="flex items-start gap-3 rounded-xl border border-ink-200 p-4 text-left hover:border-brand-400 hover:bg-brand-50/40"
            >
              <div className={`rounded-lg p-2 ${p.color}`}><p.icon className="h-5 w-5" /></div>
              <div><p className="text-sm font-semibold text-ink-900">{p.name}</p><p className="text-xs text-ink-500">{p.desc}</p></div>
            </button>
          ))}
        </div>
      </Modal>
    );
  }
  if (provider === "landline") return <LandlineForm agents={agents} onBack={() => setProvider(null)} onClose={onClose} onAdded={onAdded} />;
  if (provider === "sip") return <SipForm agents={agents} onBack={() => setProvider(null)} onClose={onClose} onAdded={onAdded} />;
  if (provider === "twilio") return <TwilioForm agents={agents} onBack={() => setProvider(null)} onClose={onClose} onAdded={onAdded} />;
  return <ProviderForm provider={provider} agents={agents} onBack={() => setProvider(null)} onClose={onClose} onAdded={onAdded} />;
}

// Country dial codes for the Twilio number picker (mirrors the contacts picker).
const DIAL_CODES: { flag: string; dial: string; name: string }[] = [
  { flag: "🇺🇸", dial: "+1", name: "United States" },
  { flag: "🇦🇪", dial: "+971", name: "UAE" },
  { flag: "🇬🇧", dial: "+44", name: "United Kingdom" },
  { flag: "🇸🇦", dial: "+966", name: "Saudi Arabia" },
  { flag: "🇶🇦", dial: "+974", name: "Qatar" },
  { flag: "🇰🇼", dial: "+965", name: "Kuwait" },
  { flag: "🇧🇭", dial: "+973", name: "Bahrain" },
  { flag: "🇴🇲", dial: "+968", name: "Oman" },
  { flag: "🇮🇳", dial: "+91", name: "India" },
  { flag: "🇨🇦", dial: "+1", name: "Canada" },
  { flag: "🇦🇺", dial: "+61", name: "Australia" },
  { flag: "🇩🇪", dial: "+49", name: "Germany" },
];

// Dedicated "Import Twilio number" form — mirrors Vapi's importer: phone (with a
// country-flag picker), Account SID, Auth Token, Label, SMS toggle, agent. On
// submit it stores the number and registers it on Vapi with the agent attached,
// so inbound calls are answered and the number is usable for outbound.
function TwilioForm({ agents, onBack, onClose, onAdded }: { agents: AiAgent[]; onBack: () => void; onClose: () => void; onAdded: () => void }) {
  const [dial, setDial] = useState("+1");
  const [local, setLocal] = useState("");
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [label, setLabel] = useState("");
  const [smsEnabled, setSmsEnabled] = useState(true);
  const [agentId, setAgentId] = useState("");
  const [direction, setDirection] = useState("inbound");
  const [saving, setSaving] = useState(false);

  const number = local.trim() ? `${dial}${local.replace(/[^\d]/g, "").replace(/^0+/, "")}` : "";

  async function submit() {
    if (!number) { toast("Enter the Twilio phone number.", "info"); return; }
    if (!accountSid.trim() || !authToken.trim()) { toast("Twilio Account SID and Auth Token are required.", "info"); return; }
    setSaving(true);
    const cfg = { twilioAccountSid: accountSid.trim(), twilioAuthToken: authToken.trim(), smsEnabled, numberType: "national", scope: "Global", status: "active" };
    const res = await createVoiceNumber({ number, nickname: label, agentId: agentId || null, direction: direction as VoiceNumber["direction"], provider: "twilio", concurrency: 1, config: cfg });
    if (!res.ok) { setSaving(false); toast(res.message, "info"); return; }
    const vapi = await connectNumberToVapi({ provider: "twilio", number, nickname: label, agent: agents.find((a) => a.id === agentId), config: cfg });
    if (res.id && vapi.vapiPhoneNumberId) await updateVoiceNumber(res.id, { vapiPhoneNumberId: vapi.vapiPhoneNumberId });
    setSaving(false);
    toast(vapi.message, vapi.ok ? "success" : "info");
    onAdded();
  }

  return (
    <Modal open onClose={onClose} title="Import Twilio number" subtitle="Bring your own Twilio number — we register it on Vapi and route it to your agent." wide>
      <BackBar onBack={onBack} />
      <div className="space-y-4">
        <Field label="Twilio Phone Number">
          <div className="flex gap-2">
            <select value={dial} onChange={(e) => setDial(e.target.value)} className="w-28 shrink-0 rounded-xl border border-ink-200 bg-surface px-2 py-2.5 text-sm text-ink-800 outline-none focus:border-brand-400">
              {DIAL_CODES.map((c, i) => <option key={`${c.dial}-${i}`} value={c.dial}>{c.flag} {c.dial}</option>)}
            </select>
            <input className={inputCls} placeholder="4156021922" value={local} onChange={(e) => setLocal(e.target.value)} />
          </div>
          {number && <p className="mt-1 text-xs text-ink-400">Will import <span className="font-mono">{number}</span></p>}
        </Field>
        <Field label="Twilio Account SID"><input className={inputCls} placeholder="ACxxxxxxxxxxxxxxxx" value={accountSid} onChange={(e) => setAccountSid(e.target.value)} /></Field>
        <Field label="Twilio Auth Token"><input className={inputCls} type="password" placeholder="Your Twilio Auth Token" value={authToken} onChange={(e) => setAuthToken(e.target.value)} /></Field>
        <Field label="Label"><input className={inputCls} placeholder="Reception line" value={label} onChange={(e) => setLabel(e.target.value)} /></Field>

        <label className="flex items-center justify-between rounded-xl border border-ink-200 px-4 py-3">
          <span><span className="text-sm font-medium text-ink-800">SMS Enabled</span><span className="block text-xs text-ink-400">Enable SMS messaging for this phone number</span></span>
          <button type="button" onClick={() => setSmsEnabled((v) => !v)} className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${smsEnabled ? "bg-emerald-500" : "bg-ink-300"}`}>
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${smsEnabled ? "left-[22px]" : "left-0.5"}`} />
          </button>
        </label>

        <AgentDir agentId={agentId} setAgentId={setAgentId} direction={direction} setDirection={setDirection} agents={agents} />
        <div className="flex items-start gap-2 rounded-xl border border-ink-100 bg-ink-50/60 p-3 text-xs text-ink-500">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> We register this number on Vapi using your Twilio SID + token and attach the selected agent, so inbound calls are answered and the number is the caller ID for outbound. (Assign the agent and Save it once so it&apos;s synced to Vapi.)
        </div>
      </div>
      <ModalFooter onClose={onClose} submitLabel={saving ? "Importing…" : "Import from Twilio"} onSubmit={submit} />
    </Modal>
  );
}

function BackBar({ onBack }: { onBack: () => void }) {
  return <button onClick={onBack} className="mb-3 flex items-center gap-1.5 text-sm font-medium text-ink-500 hover:text-ink-800"><ArrowLeft className="h-4 w-4" /> Back</button>;
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

// Generic provider credential form (Ziwo / Go Auto Dial / Maqsam / Vocalcom / BYOT Twilio).
function ProviderForm({ provider, agents, onBack, onClose, onAdded }: { provider: ProviderKey; agents: AiAgent[]; onBack: () => void; onClose: () => void; onAdded: () => void }) {
  const meta = PROVIDERS.find((p) => p.key === provider)!;
  const fields = PROVIDER_FIELDS[provider] ?? [];
  const [number, setNumber] = useState("");
  const [nickname, setNickname] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [numberType, setNumberType] = useState("national");
  const [status, setStatus] = useState("active");
  const [agentId, setAgentId] = useState("");
  const [direction, setDirection] = useState("inbound");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!number.trim()) { toast("Enter the phone number.", "info"); return; }
    setSaving(true);
    const cfg = { ...creds, numberType, scope: "Global", status };
    const res = await createVoiceNumber({
      number: number.trim(), nickname, agentId: agentId || null, direction: direction as VoiceNumber["direction"], provider, concurrency: 1,
      config: cfg,
    });
    if (!res.ok) { setSaving(false); toast(res.message, "info"); return; }
    const vapi = await connectNumberToVapi({ provider, number: number.trim(), nickname, agent: agents.find((a) => a.id === agentId), config: cfg });
    if (res.id && vapi.vapiPhoneNumberId) await updateVoiceNumber(res.id, { vapiPhoneNumberId: vapi.vapiPhoneNumberId });
    setSaving(false);
    toast(vapi.message, vapi.ok ? "success" : "info");
    onAdded();
  }

  return (
    <Modal open onClose={onClose} title={`Add ${meta.name} number`} subtitle={meta.desc}>
      <BackBar onBack={onBack} />
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Phone number"><input className={inputCls} placeholder="+9714…" value={number} onChange={(e) => setNumber(e.target.value)} /></Field>
          <Field label="Label / nickname"><input className={inputCls} placeholder="Reception line" value={nickname} onChange={(e) => setNickname(e.target.value)} /></Field>
        </div>
        {fields.length > 0 && (
          <div className="grid gap-4 md:grid-cols-2">
            {fields.map((f) => (
              <Field key={f.key} label={f.label}>
                <input className={inputCls} type={f.password ? "password" : "text"} placeholder={f.placeholder} value={creds[f.key] ?? ""} onChange={(e) => setCreds((c) => ({ ...c, [f.key]: e.target.value }))} />
              </Field>
            ))}
          </div>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Number type">
            <select className={inputCls} value={numberType} onChange={(e) => setNumberType(e.target.value)}>
              <option value="national">National</option>
              <option value="international">International</option>
              <option value="toll-free">Toll-free</option>
            </select>
          </Field>
          <Field label="Status">
            <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </Field>
        </div>
        <AgentDir agentId={agentId} setAgentId={setAgentId} direction={direction} setDirection={setDirection} agents={agents} />
        <div className="flex items-start gap-2 rounded-xl border border-ink-100 bg-ink-50/60 p-3 text-xs text-ink-500">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Pydent stores this provider config and assigns the agent. The live phone connection is completed in {meta.name} / Vapi using these same values.
        </div>
      </div>
      <ModalFooter onClose={onClose} submitLabel={saving ? "Adding…" : "Add number"} onSubmit={submit} />
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

// One line in the ARI connection status readout (green dot = OK, red = failing).
function StatusRow({ ok, label, hint }: { ok: boolean; label: string; hint?: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`h-2 w-2 rounded-full ${ok ? "bg-emerald-500" : "bg-rose-400"}`} />
      <span className={ok ? "text-emerald-600" : "text-rose-500"}>{label}</span>
      {hint && <span className="text-ink-400">— {hint}</span>}
    </div>
  );
}

// Clinic Landline (on-prem): the INBOUND path where a patient dials the clinic's
// existing landline and the AI agent answers. The physical line is already
// handled by the clinic's PBX (e.g. D-Link DVX-2005F), which trunks the call over
// SIP into Asterisk on a small on-prem box. Pydent does NOT act as a SIP phone —
// it controls the call through Asterisk's ARI (REST + WebSocket events) with a
// Stasis app, and streams audio to/from the AI over a media WebSocket. So this
// form is a CONNECTION PROFILE for that Asterisk box, not a hardware setup form.
function LandlineForm({ agents, onBack, onClose, onAdded }: { agents: AiAgent[]; onBack: () => void; onClose: () => void; onAdded: () => void }) {
  const [dial, setDial] = useState("+971");
  const [local, setLocal] = useState("");
  const [nickname, setNickname] = useState("");
  const [pbxType, setPbxType] = useState("D-Link DVX-2005F");
  const [boxHost, setBoxHost] = useState("");
  const [connMode, setConnMode] = useState<"ari_ws" | "ari_rtp" | "sip">("ari_ws");
  const [ariUrl, setAriUrl] = useState("");
  const [ariUser, setAriUser] = useState("");
  const [ariSecret, setAriSecret] = useState("");
  const [stasisApp, setStasisApp] = useState("pydent-agent");
  const [agentId, setAgentId] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ reachable: boolean; ariConnected: boolean; appRegistered: boolean; version?: string; error?: string } | null>(null);

  const number = local.trim() ? `${dial}${local.replace(/[^\d]/g, "").replace(/^0+/, "")}` : "";
  const usesAri = connMode !== "sip";

  async function test() {
    if (!ariUrl.trim()) { toast("Enter the ARI URL / host first.", "info"); return; }
    setTesting(true);
    setStatus(null);
    try {
      const res = await fetch("/api/telephony/ari-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ariUrl: ariUrl.trim(), username: ariUser.trim(), secret: ariSecret, stasisApp: stasisApp.trim() }),
      });
      const data = await res.json();
      setStatus(data);
    } catch (e) {
      setStatus({ reachable: false, ariConnected: false, appRegistered: false, error: e instanceof Error ? e.message : "test failed" });
    } finally {
      setTesting(false);
    }
  }

  async function submit() {
    if (!number) { toast("Enter the clinic landline number.", "info"); return; }
    if (usesAri && !ariUrl.trim()) { toast("Enter the ARI URL / host (or switch to SIP mode).", "info"); return; }
    setSaving(true);
    const cfg = {
      kind: "landline_onprem",
      pbxType: pbxType.trim(),
      boxHost: boxHost.trim(),
      connectionMode: connMode,
      ariUrl: usesAri ? ariUrl.trim() : "",
      ariUsername: usesAri ? ariUser.trim() : "",
      // NOTE: write-only in the UI (never rendered back). Stored in the
      // workspace-scoped config; the ARI connector reads it server-side.
      ariSecret: usesAri ? ariSecret : "",
      ariSecretSet: usesAri && !!ariSecret,
      stasisApp: usesAri ? stasisApp.trim() : "",
      mediaMode: connMode === "ari_ws" ? "websocket" : connMode === "ari_rtp" ? "rtp" : "",
      numberType: "national", scope: "Local", status: "active",
    };
    const res = await createVoiceNumber({ number, nickname: nickname || "Clinic landline", agentId: agentId || null, direction: "inbound", provider: "landline", concurrency: 1, config: cfg });
    setSaving(false);
    if (!res.ok) { toast(res.message, "info"); return; }
    toast(agentId ? "Landline profile saved. Point the Asterisk dialplan at Stasis(" + (stasisApp.trim() || "pydent-agent") + ") to go live." : "Saved — assign a voice agent so calls route to it.", "success");
    onAdded();
  }

  return (
    <Modal open onClose={onClose} title="Clinic Landline (on-prem)" subtitle="Connection profile for the clinic's Asterisk box — your landline number stays the same and the AI agent answers." wide>
      <BackBar onBack={onBack} />
      <div className="max-h-[64vh] space-y-4 overflow-y-auto pr-1">
        <div className="flex items-start gap-2 rounded-xl border border-brand-200 bg-brand-50/50 p-3 text-xs text-ink-600">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500" /> Path: landline → your PBX (D-Link) → SIP → Asterisk on the on-prem box → Pydent controls the call via ARI/Stasis → audio streams to the AI agent. Pydent talks to Asterisk over ARI (REST + WebSocket), it does not register as a SIP phone.
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Clinic landline number (the business number patients dial)">
            <div className="flex gap-2">
              <select value={dial} onChange={(e) => setDial(e.target.value)} className="w-24 shrink-0 rounded-xl border border-ink-200 bg-surface px-2 py-2.5 text-sm text-ink-800 outline-none focus:border-brand-400">
                {DIAL_CODES.map((c, i) => <option key={`${c.dial}-${i}`} value={c.dial}>{c.flag} {c.dial}</option>)}
              </select>
              <input className={inputCls} placeholder="4 398 5241" value={local} onChange={(e) => setLocal(e.target.value)} />
            </div>
            {number && <p className="mt-1 text-xs text-ink-400">Landline <span className="font-mono">{number}</span></p>}
          </Field>
          <Field label="Clinic / label"><input className={inputCls} placeholder="LH Clinic Reception" value={nickname} onChange={(e) => setNickname(e.target.value)} /></Field>
          <Field label="PBX type"><input className={inputCls} placeholder="D-Link DVX-2005F" value={pbxType} onChange={(e) => setPbxType(e.target.value)} /></Field>
          <Field label="Voice agent that answers this landline">
            <select className={inputCls} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">Choose agent…</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name} — {a.role}</option>)}
            </select>
          </Field>
        </div>

        <Field label="Asterisk box address (Tailscale / WireGuard hostname or private address the Pydent backend can reach)">
          <input className={inputCls} placeholder="clinic-lh.tailnet.ts.net" value={boxHost} onChange={(e) => setBoxHost(e.target.value)} />
        </Field>

        <Field label="Connection mode">
          <select className={inputCls} value={connMode} onChange={(e) => setConnMode(e.target.value as typeof connMode)}>
            <option value="ari_ws">ARI + Media WebSocket (recommended)</option>
            <option value="ari_rtp">ARI + External Media (RTP / AudioSocket)</option>
            <option value="sip">Legacy SIP trunk (Pydent as SIP endpoint)</option>
          </select>
        </Field>

        {usesAri && (
          <div className="rounded-xl border border-ink-100 bg-ink-50/50 p-3.5 space-y-4">
            <p className="text-xs font-semibold text-ink-700">Asterisk ARI (REST Interface)</p>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="ARI URL / host"><input className={inputCls} placeholder="http://clinic-lh.tailnet.ts.net:8088" value={ariUrl} onChange={(e) => setAriUrl(e.target.value)} /></Field>
              <Field label="Stasis application name"><input className={inputCls} placeholder="pydent-agent" value={stasisApp} onChange={(e) => setStasisApp(e.target.value)} /></Field>
              <Field label="ARI username"><input className={inputCls} placeholder="pydent" value={ariUser} onChange={(e) => setAriUser(e.target.value)} /></Field>
              <Field label="ARI secret (write-only — not shown again after saving)">
                <input type="password" className={inputCls} placeholder="••••••••" value={ariSecret} onChange={(e) => setAriSecret(e.target.value)} />
              </Field>
            </div>
            <div className="flex items-center gap-3">
              <button type="button" onClick={test} disabled={testing} className="rounded-lg border border-brand-300 px-3 py-1.5 text-xs font-semibold text-brand-600 hover:bg-brand-50 disabled:opacity-50">
                {testing ? "Testing…" : "Test connection"}
              </button>
              <span className="text-[11px] text-ink-400">Checks reachability, ARI auth and whether the Stasis app is registered.</span>
            </div>
            {status && (
              <div className="space-y-1.5 rounded-lg border border-ink-100 bg-surface p-3">
                <StatusRow ok={status.reachable} label="Asterisk reachable" hint={status.reachable ? status.version : "backend can't reach the box — check the box address / Tailscale ACL"} />
                <StatusRow ok={status.ariConnected} label="ARI connected" hint={status.ariConnected ? "credentials OK" : "check ARI username / secret and that ari.conf has enabled=yes"} />
                <StatusRow ok={status.appRegistered} label={`Stasis app "${stasisApp.trim() || "pydent-agent"}" registered`} hint={status.appRegistered ? "ready" : "starts once the Pydent ARI connector is running on the box"} />
                {status.error && <p className="text-[11px] text-rose-500">{status.error}</p>}
              </div>
            )}
          </div>
        )}

        <div className="rounded-xl border border-ink-100 bg-ink-50/60 p-3.5">
          <p className="mb-2 text-xs font-semibold text-ink-700">Dialplan handoff (on the box) — send the inbound call into Pydent:</p>
          <pre className="overflow-x-auto rounded-lg bg-ink-900 p-3 text-[11px] leading-relaxed text-ink-100"><code>{`[from-dlink]
exten => ${local.replace(/[^\d]/g, "") || "123"},1,Answer()
 same => n,Stasis(${stasisApp.trim() || "pydent-agent"})
 same => n,Hangup()`}</code></pre>
          <p className="mt-2 text-[11px] text-ink-400">The Pydent ARI connector (running on the box) receives the call from this Stasis app and streams audio to <span className="font-medium">{agents.find((a) => a.id === agentId)?.name ?? "the assigned agent"}</span>. Full steps in VOICE_SETUP.md.</p>
        </div>
      </div>
      <ModalFooter onClose={onClose} submitLabel={saving ? "Saving…" : "Save connection profile"} onSubmit={submit} />
    </Modal>
  );
}

function SipForm({ agents, onBack, onClose, onAdded }: { agents: AiAgent[]; onBack: () => void; onClose: () => void; onAdded: () => void }) {
  const [number, setNumber] = useState(""); const [nickname, setNickname] = useState(""); const [concurrency, setConcurrency] = useState(1);
  const [agentId, setAgentId] = useState(""); const [direction, setDirection] = useState("inbound");
  const [terminationUri, setTerminationUri] = useState("");
  const [numberType, setNumberType] = useState("national"); const [status, setStatus] = useState("active");
  const [e164, setE164] = useState(true); const [requiresReg, setRequiresReg] = useState(false); const [publicIp, setPublicIp] = useState(false);
  const [username, setUsername] = useState(""); const [password, setPassword] = useState("");
  const [categories, setCategories] = useState<SipCategory[]>([]);
  const [saving, setSaving] = useState(false);

  function addCategory() { setCategories((c) => [...c, { ipOrDomain: "", port: "5060", protocol: "UDP", direction: "inbound", active: true, ping: false }]); }
  function setCat(i: number, patch: Partial<SipCategory>) { setCategories((c) => c.map((x, idx) => (idx === i ? { ...x, ...patch } : x))); }

  async function submit() {
    if (!number.trim()) { toast("Enter the phone number.", "info"); return; }
    setSaving(true);
    const cfg = { terminationUri: terminationUri.trim(), e164LeadingPlus: e164, requiresRegistration: requiresReg, registeredPublicIp: publicIp, username: requiresReg ? username : "", password: requiresReg ? password : "", categories, numberType, scope: "Global", status };
    const res = await createVoiceNumber({
      number: number.trim(), nickname, agentId: agentId || null, direction: direction as VoiceNumber["direction"], provider: "sip", concurrency,
      config: cfg,
    });
    if (!res.ok) { setSaving(false); toast(res.message, "info"); return; }
    const vapi = await connectNumberToVapi({ provider: "sip", number: number.trim(), nickname, agent: agents.find((a) => a.id === agentId), config: cfg });
    if (res.id && vapi.vapiPhoneNumberId) await updateVoiceNumber(res.id, { vapiPhoneNumberId: vapi.vapiPhoneNumberId });
    setSaving(false);
    toast(vapi.message, vapi.ok ? "success" : "info");
    onAdded();
  }

  return (
    <Modal open onClose={onClose} title="Custom SIP Trunk" subtitle="Connect a carrier / UAE +971 number over SIP." wide>
      <BackBar onBack={onBack} />
      <div className="max-h-[62vh] space-y-4 overflow-y-auto pr-1">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Phone number"><input className={inputCls} placeholder="+9714…" value={number} onChange={(e) => setNumber(e.target.value)} /></Field>
          <Field label="Nickname"><input className={inputCls} placeholder="Clinic SIP" value={nickname} onChange={(e) => setNickname(e.target.value)} /></Field>
          <Field label="Concurrency limit (max simultaneous calls)"><input type="number" min={1} className={inputCls} value={concurrency} onChange={(e) => setConcurrency(Math.max(1, Number(e.target.value) || 1))} /></Field>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Number type">
            <select className={inputCls} value={numberType} onChange={(e) => setNumberType(e.target.value)}>
              <option value="national">National</option><option value="international">International</option><option value="toll-free">Toll-free</option>
            </select>
          </Field>
          <Field label="Status">
            <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="active">Active</option><option value="inactive">Inactive</option>
            </select>
          </Field>
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
