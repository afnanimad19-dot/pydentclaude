"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Phone, Plus, Trash2, Info, Server, ArrowLeft, Search, RefreshCw, MoreVertical, Radio, PhoneForwarded, LayoutGrid, Smartphone, Network, Pencil, Home, Copy, Check as CheckIcon } from "lucide-react";
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
  const [pairing, setPairing] = useState(false);
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
  // For an on-prem landline box: is the connector checking in? "Online" if a
  // heartbeat landed in the last ~60s. Recomputed on a timer (Date.now() can't
  // run during render), so the badge flips to offline if the box goes quiet.
  const boxHb = n.provider === "landline";
  const lastHb = boxHb ? (n.config?.lastHeartbeat as string | null) : null;
  const [boxOnline, setBoxOnline] = useState(false);
  useEffect(() => {
    if (!boxHb) return;
    const check = () => setBoxOnline(!!lastHb && Date.now() - new Date(lastHb).getTime() < 60000);
    check();
    const t = setInterval(check, 15000);
    return () => clearInterval(t);
  }, [boxHb, lastHb]);

  async function del() {
    if (!confirm(`Delete ${n.number}? This cannot be undone.`)) return;
    await deleteVoiceNumber(n.id);
    toast("Phone number deleted.", "success");
    onChanged();
  }

  return (
    <Card className="flex flex-col p-5">
      {edit && <EditNumberModal n={n} agents={agents} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); onChanged(); }} />}
      {pairing && <PairingModal n={n} onClose={() => setPairing(false)} />}
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-ink-500">{PROVIDER_LABEL[n.provider] ?? n.provider}</p>
        <div className="relative" ref={ref}>
          <button onClick={() => setMenu((m) => !m)} className="rounded-lg p-1 text-ink-400 hover:bg-ink-100"><MoreVertical className="h-4 w-4" /></button>
          {menu && (
            <div className="absolute right-0 z-10 mt-1 w-44 rounded-xl border border-ink-200 bg-surface py-1 shadow-lg">
              <button onClick={() => { setMenu(false); setEdit(true); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-700 hover:bg-ink-50"><Pencil className="h-4 w-4" /> Edit</button>
              {n.provider === "landline" && (
                <button onClick={() => { setMenu(false); setPairing(true); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-700 hover:bg-ink-50"><Server className="h-4 w-4" /> Pairing / .env</button>
              )}
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
        {boxHb && (
          <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${boxOnline ? "bg-emerald-500/15 text-emerald-600" : "bg-amber-500/15 text-amber-600"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${boxOnline ? "bg-emerald-500" : "bg-amber-500"}`} /> {boxOnline ? "Box online" : "Box offline"}
          </span>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-ink-100 pt-3 text-[11px] text-ink-400">
        <span>Created {fmtDate(n.createdAt)}</span>
        <span className="capitalize">{n.direction}</span>
      </div>
    </Card>
  );
}

// Show the pairing details for an on-prem landline box any time (the device
// token was shown once on save; this recovers it from the saved config so the
// user can always copy the .env block onto the Pi).
function PairingModal({ n, onClose }: { n: VoiceNumber; onClose: () => void }) {
  const cfg = n.config ?? {};
  const deviceId = (cfg.deviceId as string) || "—";
  const deviceToken = (cfg.deviceToken as string) || "";
  const stasisApp = (cfg.stasisApp as string) || "pydent-agent";
  const base = typeof window !== "undefined" ? window.location.origin : "https://pydent.ai";
  const envBlock = `ARI_URL=http://127.0.0.1:8088\nARI_USER=pydent\nARI_SECRET=your-ari-password\nSTASIS_APP=${stasisApp}\nPYDENT_BASE=${base}\nPYDENT_DEVICE_TOKEN=${deviceToken}`;

  return (
    <Modal open onClose={onClose} title="Pairing details" subtitle={`For the box that answers ${n.number}`} z="z-[60]" wide>
      <div className="max-h-[64vh] space-y-4 overflow-y-auto pr-1">
        {!deviceToken ? (
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-700">
            <Info className="mt-0.5 h-4 w-4 shrink-0" /> This landline has no device token — it was saved before pairing existed. Delete it and add it again with <span className="font-semibold">Add Phone Number → Clinic Landline (on-prem)</span> to generate one.
          </div>
        ) : (
          <>
            <div>
              <p className="mb-1 text-xs font-semibold text-ink-700">Device ID</p>
              <CopyChip text={deviceId} block />
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold text-ink-700">Full <span className="font-mono">.env</span> for the connector on the Pi</p>
              <pre className="overflow-x-auto rounded-lg bg-ink-900 p-3 text-[11px] leading-relaxed text-ink-100"><code>{envBlock}</code></pre>
              <div className="mt-1.5"><CopyChip text={envBlock} block /></div>
              <p className="mt-1 text-[11px] text-ink-400">Replace <span className="font-mono">your-ari-password</span> with the ARI secret from the Pi&apos;s <span className="font-mono">ari.conf</span>. Everything else is filled in.</p>
            </div>
          </>
        )}
      </div>
      <div className="mt-4 flex justify-end">
        <button onClick={onClose} className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">Done</button>
      </div>
    </Modal>
  );
}

// Edit a saved number: reopens the SAME full form the number was created with,
// pre-filled with everything already saved, so any setting can be changed (not
// just the name). Routes by provider, exactly like Add does.
function EditNumberModal({ n, agents, onClose, onSaved }: { n: VoiceNumber; agents: AiAgent[]; onClose: () => void; onSaved: () => void }) {
  const common = { agents, onClose, onAdded: onSaved, existing: n };
  if (n.provider === "landline") return <LandlineForm {...common} />;
  if (n.provider === "sip") return <SipForm {...common} />;
  if (n.provider === "twilio") return <TwilioForm {...common} />;
  return <ProviderForm provider={n.provider as ProviderKey} {...common} />;
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
function TwilioForm({ agents, onBack, onClose, onAdded, existing }: { agents: AiAgent[]; onBack?: () => void; onClose: () => void; onAdded: () => void; existing?: VoiceNumber }) {
  const init = existing ? splitNumber(existing.number) : { dial: "+1", local: "" };
  const ex = existing?.config ?? {};
  const [dial, setDial] = useState(init.dial);
  const [local, setLocal] = useState(init.local);
  const [accountSid, setAccountSid] = useState((ex.twilioAccountSid as string) ?? "");
  const [authToken, setAuthToken] = useState((ex.twilioAuthToken as string) ?? "");
  const [label, setLabel] = useState(existing?.nickname ?? "");
  const [smsEnabled, setSmsEnabled] = useState(ex.smsEnabled !== undefined ? !!ex.smsEnabled : true);
  const [agentId, setAgentId] = useState(existing?.agentId ?? "");
  const [direction, setDirection] = useState<string>(existing?.direction ?? "inbound");
  const [saving, setSaving] = useState(false);

  const number = local.trim() ? `${dial}${local.replace(/[^\d]/g, "").replace(/^0+/, "")}` : "";

  async function submit() {
    if (!number) { toast("Enter the Twilio phone number.", "info"); return; }
    if (!accountSid.trim() || !authToken.trim()) { toast("Twilio Account SID and Auth Token are required.", "info"); return; }
    setSaving(true);
    const cfg = { ...ex, twilioAccountSid: accountSid.trim(), twilioAuthToken: authToken.trim(), smsEnabled, numberType: "national", scope: "Global", status: "active" };
    if (existing) {
      const res = await updateVoiceNumber(existing.id, { number, nickname: label, agentId: agentId || null, direction: direction as VoiceNumber["direction"], config: cfg });
      if (agentId !== (existing.agentId ?? "")) await bindNumberToAgent({ ...existing, number, nickname: label, direction: direction as VoiceNumber["direction"] }, agents.find((a) => a.id === agentId));
      setSaving(false);
      toast(res.ok ? "Number updated." : res.message, res.ok ? "success" : "info");
      onAdded(); onClose();
      return;
    }
    const res = await createVoiceNumber({ number, nickname: label, agentId: agentId || null, direction: direction as VoiceNumber["direction"], provider: "twilio", concurrency: 1, config: cfg });
    if (!res.ok) { setSaving(false); toast(res.message, "info"); return; }
    const vapi = await connectNumberToVapi({ provider: "twilio", number, nickname: label, agent: agents.find((a) => a.id === agentId), config: cfg });
    if (res.id && vapi.vapiPhoneNumberId) await updateVoiceNumber(res.id, { vapiPhoneNumberId: vapi.vapiPhoneNumberId });
    setSaving(false);
    toast(vapi.message, vapi.ok ? "success" : "info");
    onAdded();
  }

  return (
    <Modal open onClose={onClose} title={existing ? "Edit Twilio number" : "Import Twilio number"} subtitle={existing ? "Change this number's details." : "Bring your own Twilio number — we register it on Vapi and route it to your agent."} wide z={existing ? "z-[60]" : undefined}>
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
      <ModalFooter onClose={onClose} submitLabel={saving ? "Saving…" : existing ? "Save changes" : "Import from Twilio"} onSubmit={submit} />
    </Modal>
  );
}

function BackBar({ onBack }: { onBack?: () => void }) {
  if (!onBack) return null;
  return <button onClick={onBack} className="mb-3 flex items-center gap-1.5 text-sm font-medium text-ink-500 hover:text-ink-800"><ArrowLeft className="h-4 w-4" /> Back</button>;
}

// Split a stored E.164 number back into a dial-code + local part for the pickers.
function splitNumber(full: string): { dial: string; local: string } {
  const s = (full ?? "").trim();
  const match = DIAL_CODES.find((c) => s.startsWith(c.dial));
  if (match) return { dial: match.dial, local: s.slice(match.dial.length) };
  return { dial: "+971", local: s.replace(/^\+/, "") };
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
function ProviderForm({ provider, agents, onBack, onClose, onAdded, existing }: { provider: ProviderKey; agents: AiAgent[]; onBack?: () => void; onClose: () => void; onAdded: () => void; existing?: VoiceNumber }) {
  const meta = PROVIDERS.find((p) => p.key === provider)!;
  const fields = PROVIDER_FIELDS[provider] ?? [];
  const ex = existing?.config ?? {};
  const [number, setNumber] = useState(existing?.number ?? "");
  const [nickname, setNickname] = useState(existing?.nickname ?? "");
  const [creds, setCreds] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {};
    for (const f of PROVIDER_FIELDS[provider] ?? []) o[f.key] = (ex[f.key] as string) ?? "";
    return o;
  });
  const [numberType, setNumberType] = useState((ex.numberType as string) ?? "national");
  const [status, setStatus] = useState((ex.status as string) ?? "active");
  const [agentId, setAgentId] = useState(existing?.agentId ?? "");
  const [direction, setDirection] = useState<string>(existing?.direction ?? "inbound");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!number.trim()) { toast("Enter the phone number.", "info"); return; }
    setSaving(true);
    const cfg = { ...ex, ...creds, numberType, scope: "Global", status };
    if (existing) {
      const res = await updateVoiceNumber(existing.id, { number: number.trim(), nickname, agentId: agentId || null, direction: direction as VoiceNumber["direction"], config: cfg });
      if (agentId !== (existing.agentId ?? "")) await bindNumberToAgent({ ...existing, number: number.trim(), nickname, direction: direction as VoiceNumber["direction"] }, agents.find((a) => a.id === agentId));
      setSaving(false);
      toast(res.ok ? "Number updated." : res.message, res.ok ? "success" : "info");
      onAdded(); onClose();
      return;
    }
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
    <Modal open onClose={onClose} title={existing ? `Edit ${meta.name} number` : `Add ${meta.name} number`} subtitle={meta.desc} z={existing ? "z-[60]" : undefined}>
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
      <ModalFooter onClose={onClose} submitLabel={saving ? "Saving…" : existing ? "Save changes" : "Add number"} onSubmit={submit} />
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

// A copy-to-clipboard chip for the pairing details.
function CopyChip({ text, block }: { text: string; block?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ } }}
      className={`inline-flex items-center gap-1.5 rounded-md border border-ink-200 bg-ink-50 px-2 py-1 font-mono text-[11px] text-ink-700 hover:border-brand-400 ${block ? "w-full justify-between" : ""}`}
    >
      <span className="truncate">{text}</span>
      {copied ? <CheckIcon className="h-3 w-3 shrink-0 text-emerald-500" /> : <Copy className="h-3 w-3 shrink-0 text-ink-400" />}
    </button>
  );
}

// Clinic Landline (on-prem): a patient dials the clinic's existing landline and
// the AI agent answers. The clinic's PBX (D-Link) trunks the line over SIP into
// Asterisk on a small on-prem box (Raspberry Pi). The Pydent connector runs ON
// that box: it talks to Asterisk over LOCAL ARI and makes only OUTBOUND secure
// connections to Pydent. So Pydent never reaches into the clinic network, no
// inbound ports are opened, and ARI credentials stay on the Pi. This form is
// therefore a PAIRING form — it stores the clinic-facing details and mints a
// device token that pairs the box to this clinic account. ARI host/user/secret
// are local provisioning on the Pi, not asked here.
function LandlineForm({ agents, onBack, onClose, onAdded, existing }: { agents: AiAgent[]; onBack?: () => void; onClose: () => void; onAdded: () => void; existing?: VoiceNumber }) {
  const init = existing ? splitNumber(existing.number) : { dial: "+971", local: "" };
  const ex = existing?.config ?? {};
  const [dial, setDial] = useState(init.dial);
  const [local, setLocal] = useState(init.local);
  const [nickname, setNickname] = useState(existing?.nickname ?? "");
  const [pbxType, setPbxType] = useState((ex.pbxType as string) ?? "D-Link DVX-2005F");
  const [boxHost, setBoxHost] = useState((ex.boxHost as string) ?? "");
  const [stasisApp, setStasisApp] = useState((ex.stasisApp as string) ?? "pydent-agent");
  const [agentId, setAgentId] = useState(existing?.agentId ?? "");
  const [saving, setSaving] = useState(false);
  const [paired, setPaired] = useState<{ deviceId: string; deviceToken: string; stasisApp: string } | null>(null);

  const number = local.trim() ? `${dial}${local.replace(/[^\d]/g, "").replace(/^0+/, "")}` : "";

  async function submit() {
    if (!number) { toast("Enter the clinic landline number.", "info"); return; }
    setSaving(true);
    const app = stasisApp.trim() || "pydent-agent";

    if (existing) {
      // EDIT: keep the paired device identity + last heartbeat; change the rest.
      const cfg = {
        ...ex,
        kind: "landline_onprem",
        pbxType: pbxType.trim(),
        boxHost: boxHost.trim(),
        stasisApp: app,
        connectionMode: "ari_local_outbound",
      };
      const res = await updateVoiceNumber(existing.id, { number, nickname: nickname || "Clinic landline", agentId: agentId || null, config: cfg });
      setSaving(false);
      if (!res.ok) { toast(res.message, "info"); return; }
      toast("Landline updated.", "success");
      onAdded();
      onClose();
      return;
    }

    // CREATE: generate the device identity that pairs this Pi to the clinic.
    const rand = new Uint8Array(24);
    crypto.getRandomValues(rand);
    const deviceToken = Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("");
    const deviceId = "box-" + deviceToken.slice(0, 8);
    const cfg = {
      kind: "landline_onprem",
      pbxType: pbxType.trim(),
      boxHost: boxHost.trim(),
      stasisApp: app,
      deviceId,
      deviceToken,
      connectionMode: "ari_local_outbound",
      numberType: "national", scope: "Local", status: "active",
      lastHeartbeat: null,
    };
    const res = await createVoiceNumber({ number, nickname: nickname || "Clinic landline", agentId: agentId || null, direction: "inbound", provider: "landline", concurrency: 1, config: cfg });
    setSaving(false);
    if (!res.ok) { toast(res.message, "info"); return; }
    onAdded(); // refresh the list behind the modal
    setPaired({ deviceId, deviceToken, stasisApp: app });
  }

  // After saving: show the one-time pairing details for the Pi's .env.
  if (paired) {
    const base = typeof window !== "undefined" ? window.location.origin : "https://pydent.ai";
    const envBlock = `PYDENT_BASE=${base}\nPYDENT_DEVICE_TOKEN=${paired.deviceToken}\nSTASIS_APP=${paired.stasisApp}`;
    return (
      <Modal open onClose={onClose} title="Pair the clinic box" subtitle="Put these on the Raspberry Pi to connect it to this clinic — shown once." wide>
        <div className="max-h-[64vh] space-y-4 overflow-y-auto pr-1">
          <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 text-xs text-emerald-700">
            <CheckIcon className="mt-0.5 h-4 w-4 shrink-0" /> Landline saved and paired. Copy the device token now — for security it is not shown again.
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold text-ink-700">Device ID</p>
            <CopyChip text={paired.deviceId} block />
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold text-ink-700">Add to the connector&apos;s <span className="font-mono">.env</span> on the Pi</p>
            <pre className="overflow-x-auto rounded-lg bg-ink-900 p-3 text-[11px] leading-relaxed text-ink-100"><code>{envBlock}</code></pre>
            <div className="mt-1.5"><CopyChip text={envBlock} block /></div>
            <p className="mt-1 text-[11px] text-ink-400">The Pi&apos;s ARI host / user / secret stay in the same .env locally (see the connector README) — they never leave the box.</p>
          </div>
          <div className="rounded-xl border border-ink-100 bg-ink-50/60 p-3.5 text-xs text-ink-600">
            <p className="mb-2 font-semibold text-ink-700">Then, on the Pi:</p>
            <ol className="space-y-1">
              <li><span className="font-semibold text-ink-800">1.</span> Install the connector: <span className="font-mono">cp -r ari-connector /opt/… &amp;&amp; npm install</span></li>
              <li><span className="font-semibold text-ink-800">2.</span> Fill the local ARI values + the block above in <span className="font-mono">.env</span>, then <span className="font-mono">systemctl enable --now pydent-ari-connector</span></li>
              <li><span className="font-semibold text-ink-800">3.</span> This landline flips to <span className="font-medium text-emerald-600">Box online</span> here once the connector checks in (a few seconds).</li>
              <li><span className="font-semibold text-ink-800">4.</span> Only then, point the dialplan at <span className="font-mono">Stasis({paired.stasisApp})</span> and call the landline.</li>
            </ol>
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">Done</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title={existing ? "Edit clinic landline" : "Clinic Landline (on-prem)"} subtitle={existing ? "Change this landline's details — the box stays paired." : "Pair the clinic's Asterisk box — your landline number stays the same and the AI agent answers."} wide z={existing ? "z-[60]" : undefined}>
      <BackBar onBack={onBack} />
      <div className="max-h-[64vh] space-y-4 overflow-y-auto pr-1">
        <div className="flex items-start gap-2 rounded-xl border border-brand-200 bg-brand-50/50 p-3 text-xs text-ink-600">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500" /> Path: landline → your PBX (D-Link) → SIP → Asterisk on the Pi → the Pydent connector on the Pi (local ARI) → outbound to Pydent → the AI agent. The Pi connects OUT to Pydent, so no inbound ports are opened and ARI stays on the box.
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
          <Field label="Stasis application name (must match the connector on the Pi)"><input className={inputCls} placeholder="pydent-agent" value={stasisApp} onChange={(e) => setStasisApp(e.target.value)} /></Field>
          <Field label="Asterisk box address (Tailscale hostname — for your records only)"><input className={inputCls} placeholder="clinic-lh.tailnet.ts.net" value={boxHost} onChange={(e) => setBoxHost(e.target.value)} /></Field>
        </div>

        <div className="flex items-start gap-2 rounded-xl border border-ink-100 bg-ink-50/60 p-3 text-[11px] text-ink-500">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> ARI host, username and secret are NOT entered here — they are local settings on the Pi&apos;s connector (localhost). Saving generates a device token that pairs the box to this clinic; the box then connects outbound to Pydent on its own.
        </div>
      </div>
      <ModalFooter onClose={onClose} submitLabel={saving ? "Saving…" : existing ? "Save changes" : "Save & pair box"} onSubmit={submit} />
    </Modal>
  );
}

function SipForm({ agents, onBack, onClose, onAdded, existing }: { agents: AiAgent[]; onBack?: () => void; onClose: () => void; onAdded: () => void; existing?: VoiceNumber }) {
  const ex = existing?.config ?? {};
  const [number, setNumber] = useState(existing?.number ?? ""); const [nickname, setNickname] = useState(existing?.nickname ?? ""); const [concurrency, setConcurrency] = useState(existing?.concurrency ?? 1);
  const [agentId, setAgentId] = useState(existing?.agentId ?? ""); const [direction, setDirection] = useState<string>(existing?.direction ?? "inbound");
  const [terminationUri, setTerminationUri] = useState((ex.terminationUri as string) ?? "");
  const [numberType, setNumberType] = useState((ex.numberType as string) ?? "national"); const [status, setStatus] = useState((ex.status as string) ?? "active");
  const [e164, setE164] = useState(ex.e164LeadingPlus !== undefined ? !!ex.e164LeadingPlus : true); const [requiresReg, setRequiresReg] = useState(!!ex.requiresRegistration); const [publicIp, setPublicIp] = useState(!!ex.registeredPublicIp);
  const [username, setUsername] = useState((ex.username as string) ?? ""); const [password, setPassword] = useState((ex.password as string) ?? "");
  const [categories, setCategories] = useState<SipCategory[]>(Array.isArray(ex.categories) ? (ex.categories as SipCategory[]) : []);
  const [saving, setSaving] = useState(false);

  function addCategory() { setCategories((c) => [...c, { ipOrDomain: "", port: "5060", protocol: "UDP", direction: "inbound", active: true, ping: false }]); }
  function setCat(i: number, patch: Partial<SipCategory>) { setCategories((c) => c.map((x, idx) => (idx === i ? { ...x, ...patch } : x))); }

  async function submit() {
    if (!number.trim()) { toast("Enter the phone number.", "info"); return; }
    setSaving(true);
    const cfg = { ...ex, terminationUri: terminationUri.trim(), e164LeadingPlus: e164, requiresRegistration: requiresReg, registeredPublicIp: publicIp, username: requiresReg ? username : "", password: requiresReg ? password : "", categories, numberType, scope: "Global", status };
    if (existing) {
      const res = await updateVoiceNumber(existing.id, { number: number.trim(), nickname, agentId: agentId || null, direction: direction as VoiceNumber["direction"], config: cfg });
      if (agentId !== (existing.agentId ?? "")) await bindNumberToAgent({ ...existing, number: number.trim(), nickname, direction: direction as VoiceNumber["direction"] }, agents.find((a) => a.id === agentId));
      setSaving(false);
      toast(res.ok ? "SIP trunk updated." : res.message, res.ok ? "success" : "info");
      onAdded(); onClose();
      return;
    }
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
    <Modal open onClose={onClose} title={existing ? "Edit SIP Trunk" : "Custom SIP Trunk"} subtitle="Connect a carrier / UAE +971 number over SIP." wide z={existing ? "z-[60]" : undefined}>
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
      <ModalFooter onClose={onClose} submitLabel={saving ? "Saving…" : existing ? "Save changes" : "Create number"} onSubmit={submit} />
    </Modal>
  );
}
