"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Megaphone, Plus, Trash2, PhoneOutgoing, PhoneIncoming, Users, Bot, PhoneCall, Pencil, UploadCloud, MessageCircle, Send, Loader2, RefreshCw } from "lucide-react";
import { Card, PageHeader, StatusBadge } from "@/components/ui";
import { Modal, Field, ModalFooter, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import {
  fetchCampaigns,
  createCampaign,
  updateCampaign,
  updateCampaignStatus,
  deleteCampaign,
  fetchAgents,
  fetchVoiceNumbers,
  fetchFolders,
  fetchVoiceCalls,
  fetchPatients,
  fetchPatientFolderMap,
  setAgentVapiId,
  getWorkspaceId,
  fetchWaTemplates,
  ensureNovaAgents,
  type Campaign,
  type AiAgent,
  type VoiceNumber,
  type PatientFolder,
  type VoiceCallRecord,
  type WaTemplate,
} from "@/lib/db";
import type { Patient } from "@/lib/mock-data";

// Pull phone-number-looking tokens out of any pasted text or uploaded sheet.
function extractNumbers(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\+?\d[\d\s().-]{6,}\d/g)) {
    const d = m[0].replace(/[^\d+]/g, "").replace(/^\+/, "");
    if (d.length >= 7 && d.length <= 15) out.add(d);
  }
  return [...out];
}

const statusTone = { active: "green", paused: "amber", draft: "gray" } as const;

export default function CampaignsPage() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [allAgents, setAllAgents] = useState<AiAgent[]>([]);
  const [numbers, setNumbers] = useState<VoiceNumber[]>([]);
  const [folders, setFolders] = useState<PatientFolder[]>([]);
  const [calls, setCalls] = useState<VoiceCallRecord[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [folderMap, setFolderMap] = useState<Record<string, string>>({});
  const [calling, setCalling] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Campaign | null>(null);

  function refresh() { fetchCampaigns().then(setCampaigns); }
  function refreshAgents() { fetchAgents().then((r) => { setAgents(r.agents.filter((a) => a.kind === "voice")); setAllAgents(r.agents); }); }
  useEffect(() => {
    refresh();
    // Seed / upgrade the Nova sales agent automatically (renames a legacy Phoenix).
    ensureNovaAgents().then(() => refreshAgents()).catch(() => {});
    fetchAgents().then((r) => { setAgents(r.agents.filter((a) => a.kind === "voice")); setAllAgents(r.agents); });
    fetchVoiceNumbers().then(setNumbers);
    fetchFolders().then(setFolders);
    fetchVoiceCalls().then(setCalls);
    fetchPatients().then((r) => setPatients(r.patients));
    fetchPatientFolderMap().then(setFolderMap);
  }, []);

  const callsByCampaign = useMemo(() => {
    const m: Record<string, number> = {};
    calls.forEach((c) => { if (c.campaignId) m[c.campaignId] = (m[c.campaignId] ?? 0) + 1; });
    return m;
  }, [calls]);

  async function toggle(c: Campaign) {
    const next = c.status === "active" ? "paused" : "active";
    setCampaigns((prev) => prev.map((x) => (x.id === c.id ? { ...x, status: next } : x)));
    await updateCampaignStatus(c.id, next);
  }
  async function del(c: Campaign) {
    if (!confirm(`Delete campaign “${c.name}”?`)) return;
    setCampaigns((prev) => prev.filter((x) => x.id !== c.id));
    await deleteCampaign(c.id);
    toast("Campaign deleted.", "success");
  }

  function contactsFor(c: Campaign): Patient[] {
    if (!c.folderId) return [];
    return patients.filter((p) => folderMap[p.id] === c.folderId && p.phone.trim());
  }

  async function startCalling(c: Campaign) {
    const agent = agents.find((a) => a.id === c.agentId);
    const number = numbers.find((n) => n.id === c.numberId);
    if (!agent) { toast("Assign a voice agent to this campaign first.", "info"); return; }
    if (!agent.vapiAssistantId) { toast(`Open “${agent.name}” and Save once to sync it to Vapi first.`, "info"); return; }
    if (!number) { toast("Assign a phone number to this campaign first.", "info"); return; }
    const contacts = contactsFor(c);
    if (contacts.length === 0) { toast("This campaign's contact list has no numbers to call.", "info"); return; }
    if (!confirm(`Start calling ${contacts.length} contact${contacts.length === 1 ? "" : "s"} with “${agent.name}” from ${number.number}?`)) return;

    setCalling(c.id);
    try {
      const res = await fetch("/api/vapi/outbound", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assistantId: agent.vapiAssistantId,
          fromNumber: number.number,
          vapiPhoneNumberId: number.vapiPhoneNumberId,
          numbers: contacts.map((p) => p.phone.trim()),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) { toast(data.error || data.message || "Couldn't start the calls.", "info"); return; }
      toast(data.message || "Calls started.", "success");
      if (c.status !== "active") {
        setCampaigns((prev) => prev.map((x) => (x.id === c.id ? { ...x, status: "active" } : x)));
        await updateCampaignStatus(c.id, "active");
      }
    } catch {
      toast("Network error starting the calls.", "info");
    } finally {
      setCalling(null);
    }
  }

  return (
    <>
      {(open || editing) && (
        <CampaignModal
          agents={agents}
          numbers={numbers}
          folders={folders}
          editing={editing}
          onClose={() => { setOpen(false); setEditing(null); }}
          onSaved={() => { setOpen(false); setEditing(null); refresh(); }}
        />
      )}
      <PageHeader
        title="Outbound Campaigns"
        subtitle="Reach a list of people automatically — paste or upload numbers, pick the agent to talk to them, and it calls (voice) or messages (chat) each one."
        actions={
          <button onClick={() => setOpen(true)} className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
            <Plus className="h-4 w-4" /> New saved campaign
          </button>
        }
      />

      <QuickOutreach agents={allAgents} numbers={numbers} onSynced={refreshAgents} />

      <h2 className="mb-3 mt-8 font-semibold text-ink-900">Saved campaigns</h2>
      {campaigns.length === 0 ? (
        <Card className="p-10 text-center text-sm text-ink-500">
          <Megaphone className="mx-auto mb-2 h-6 w-6 text-ink-300" /> No campaigns yet — create one to organise your calling.
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {campaigns.map((c) => {
            const agent = agents.find((a) => a.id === c.agentId);
            const number = numbers.find((n) => n.id === c.numberId);
            const folder = folders.find((f) => f.id === c.folderId);
            const contactCount = contactsFor(c).length;
            return (
              <Card key={c.id} className="flex flex-col p-5">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="rounded-xl bg-brand-500/15 p-2 text-brand-600">
                      {c.direction === "inbound" ? <PhoneIncoming className="h-5 w-5" /> : <PhoneOutgoing className="h-5 w-5" />}
                    </div>
                    <div>
                      <p className="font-semibold text-ink-900">{c.name || "Untitled campaign"}</p>
                      <p className="text-xs capitalize text-ink-400">{c.direction} · {callsByCampaign[c.id] ?? 0} calls</p>
                    </div>
                  </div>
                  <button onClick={() => toggle(c)} title="Toggle active/paused">
                    <StatusBadge status={c.status} tone={statusTone[c.status]} />
                  </button>
                </div>

                <div className="mt-4 space-y-1.5 text-sm">
                  <p className="flex items-center gap-2 text-ink-600"><Bot className="h-4 w-4 text-ink-400" /> {agent?.name ?? "No agent"}</p>
                  <p className="flex items-center gap-2 text-ink-600"><PhoneOutgoing className="h-4 w-4 text-ink-400" /> {number?.number ?? "No number"}</p>
                  <p className="flex items-center gap-2 text-ink-600">
                    <Users className="h-4 w-4 text-ink-400" /> {folder?.name ?? "No contact list"}
                    {c.direction === "outbound" && folder ? <span className="text-xs text-ink-400">· {contactCount} to call</span> : null}
                  </p>
                </div>

                {c.direction === "outbound" && (
                  <button
                    onClick={() => startCalling(c)}
                    disabled={calling === c.id}
                    className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-emerald-600 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                  >
                    <PhoneCall className="h-4 w-4" /> {calling === c.id ? "Starting calls…" : "Start calling"}
                  </button>
                )}

                <div className="mt-4 flex gap-2 border-t border-ink-100 pt-4">
                  <button
                    onClick={() => router.push(`/dashboard/voice?campaign=${c.id}`)}
                    className="flex-1 rounded-xl bg-brand-600 py-2 text-sm font-semibold text-white hover:bg-brand-700"
                  >
                    View calls
                  </button>
                  <button onClick={() => setEditing(c)} className="rounded-xl border border-ink-200 px-3 py-2 text-ink-400 hover:bg-ink-50 hover:text-ink-700" title="Edit"><Pencil className="h-4 w-4" /></button>
                  <button onClick={() => del(c)} className="rounded-xl border border-ink-200 px-3 py-2 text-ink-400 hover:bg-rose-500/10 hover:text-rose-500" title="Delete"><Trash2 className="h-4 w-4" /></button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

function CampaignModal({
  agents,
  numbers,
  folders,
  editing,
  onClose,
  onSaved,
}: {
  agents: AiAgent[];
  numbers: VoiceNumber[];
  folders: PatientFolder[];
  editing: Campaign | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [agentId, setAgentId] = useState(editing?.agentId ?? "");
  const [numberId, setNumberId] = useState(editing?.numberId ?? "");
  const [folderId, setFolderId] = useState(editing?.folderId ?? "");
  const [direction, setDirection] = useState<"inbound" | "outbound">(editing?.direction ?? "outbound");
  const [status, setStatus] = useState<"active" | "paused" | "draft">(editing?.status ?? "active");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!name.trim()) { toast("Name your campaign.", "info"); return; }
    setSaving(true);
    const input = { name: name.trim(), agentId: agentId || null, numberId: numberId || null, folderId: folderId || null, direction, status };
    const res = editing ? await updateCampaign(editing.id, input) : await createCampaign(input);
    setSaving(false);
    if (!res.ok) { toast(res.message, "info"); return; }
    toast(editing ? "Campaign updated." : "Campaign created.", "success");
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title={editing ? "Edit campaign" : "New campaign"} subtitle="Pair an agent, a number and a contact list.">
      <div className="space-y-4">
        <Field label="Campaign name"><input className={inputCls} placeholder="Leila Hariri inbound" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Voice agent">
            <select className={inputCls} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">Choose agent…</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name} — {a.role}</option>)}
            </select>
          </Field>
          <Field label="Phone number">
            <select className={inputCls} value={numberId} onChange={(e) => setNumberId(e.target.value)}>
              <option value="">Choose number…</option>
              {numbers.map((n) => <option key={n.id} value={n.id}>{n.number}{n.nickname ? ` — ${n.nickname}` : ""}</option>)}
            </select>
          </Field>
          <Field label="Contact list (optional)">
            <select className={inputCls} value={folderId} onChange={(e) => setFolderId(e.target.value)}>
              <option value="">No list</option>
              {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </Field>
          <Field label="Direction">
            <select className={inputCls} value={direction} onChange={(e) => setDirection(e.target.value as "inbound" | "outbound")}>
              <option value="outbound">Outbound</option>
              <option value="inbound">Inbound</option>
            </select>
          </Field>
        </div>
        <Field label="Status">
          <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as "active" | "paused" | "draft")}>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="draft">Draft</option>
          </select>
        </Field>
      </div>
      <ModalFooter onClose={onClose} submitLabel={saving ? "Creating…" : "Create campaign"} onSubmit={submit} />
    </Modal>
  );
}

// Ad-hoc outreach: paste/upload a number list, pick ANY agent, and launch —
// voice agents call the list (Vapi), chat agents message it (WhatsApp) and then
// handle the replies automatically.
function QuickOutreach({ agents, numbers, onSynced }: { agents: AiAgent[]; numbers: VoiceNumber[]; onSynced: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [agentId, setAgentId] = useState("");
  const [numberId, setNumberId] = useState("");
  const [opener, setOpener] = useState("");
  const [channel, setChannel] = useState<"whatsapp" | "whatsapp_template" | "sms">("whatsapp");
  const [templates, setTemplates] = useState<WaTemplate[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => { fetchWaTemplates().then((r) => setTemplates(r.templates.filter((t) => t.status === "Approved"))); }, []);

  const list = useMemo(() => extractNumbers(text), [text]);
  const agent = agents.find((a) => a.id === agentId) ?? null;
  const isVoice = agent?.kind === "voice";

  function pickAgent(id: string) {
    setAgentId(id);
    const a = agents.find((x) => x.id === id);
    if (a?.kind === "chat" && !opener.trim()) setOpener(a.firstMessage || `Hi! This is ${a.name} from the clinic — is now a good time?`);
  }

  async function onFile(f: File | undefined) {
    if (!f) return;
    if (/\.(csv|txt|tsv)$/i.test(f.name)) { const c = await f.text(); setText((t) => `${t}\n${c}`.trim()); return; }
    // xlsx / other → extract text on the server, then scan for numbers.
    const fd = new FormData(); fd.append("file", f, f.name);
    const res = await fetch("/api/kb/extract", { method: "POST", body: fd });
    const d = await res.json().catch(() => ({}));
    if (d.text) setText((t) => `${t}\n${d.text}`.trim());
    else toast("Couldn't read that file — paste the numbers or upload a CSV.", "info");
  }

  async function syncVoice() {
    if (!agent) return;
    setSyncing(true);
    const res = await fetch("/api/vapi/assistants", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(agent) });
    const d = await res.json().catch(() => ({}));
    if (res.ok && d.id) { await setAgentVapiId(agent.id, d.id); onSynced(); toast(`${agent.name} synced to Vapi.`, "success"); }
    else toast(d.error ?? d.message ?? "Vapi sync failed (check VAPI_API_KEY).", "info");
    setSyncing(false);
  }

  async function launch() {
    if (!agent) { toast("Choose an agent.", "info"); return; }
    if (list.length === 0) { toast("Paste or upload some phone numbers first.", "info"); return; }
    setBusy(true);
    try {
      if (isVoice) {
        if (!agent.vapiAssistantId) { toast("Sync this voice agent to Vapi first.", "info"); return; }
        const number = numbers.find((n) => n.id === numberId);
        if (!number) { toast("Choose the number to call from.", "info"); return; }
        const res = await fetch("/api/vapi/outbound", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assistantId: agent.vapiAssistantId, fromNumber: number.number, vapiPhoneNumberId: number.vapiPhoneNumberId, numbers: list }) });
        const d = await res.json().catch(() => ({}));
        toast(d.message ?? d.error ?? "Done.", d.ok ? "success" : "info");
      } else {
        if (channel === "whatsapp_template" && !templateName) { toast("Pick an approved template for cold outreach.", "info"); return; }
        if (channel !== "whatsapp_template" && !opener.trim()) { toast("Write the opening message.", "info"); return; }
        const ws = await getWorkspaceId();
        const tpl = templates.find((t) => t.name === templateName);
        const res = await fetch("/api/agents/outbound-message", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ws, agentId: agent.id, numbers: list, channel, message: opener.trim(), templateName, templateLanguage: tpl?.language ?? "en" }) });
        const d = await res.json().catch(() => ({}));
        toast(d.message ?? d.error ?? "Done.", d.ok ? "success" : "info");
        if (d.hint) setTimeout(() => toast(d.hint, "info"), 400);
      }
    } finally { setBusy(false); }
  }

  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 font-semibold text-ink-900"><PhoneOutgoing className="h-4 w-4 text-brand-500" /> Quick outreach — give it a list, pick an agent</h2>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-600">Phone numbers</label>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} className={`${inputCls} font-mono text-sm`} placeholder={"Paste numbers (or an Excel/CSV column)…\n+971581234567\n+971509876543"} />
          <div className="mt-1.5 flex items-center justify-between">
            <button onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-600 hover:text-brand-700"><UploadCloud className="h-3.5 w-3.5" /> Upload CSV / Excel</button>
            <input ref={fileRef} type="file" accept=".csv,.txt,.tsv,.xlsx,.xls" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            <span className="text-xs text-ink-400">{list.length} number{list.length === 1 ? "" : "s"} found · up to 50/run</span>
          </div>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-600">Talk to them with</label>
            <select value={agentId} onChange={(e) => pickAgent(e.target.value)} className={inputCls}>
              <option value="">Choose an agent…</option>
              <optgroup label="Voice (calls)">{agents.filter((a) => a.kind === "voice").map((a) => <option key={a.id} value={a.id}>{a.name} — {a.role}</option>)}</optgroup>
              <optgroup label="Chat (messages)">{agents.filter((a) => a.kind === "chat").map((a) => <option key={a.id} value={a.id}>{a.name} — {a.role}</option>)}</optgroup>
            </select>
          </div>
          {isVoice && (
            <>
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-600">Call from</label>
                <select value={numberId} onChange={(e) => setNumberId(e.target.value)} className={inputCls}>
                  <option value="">Choose number…</option>
                  {numbers.map((n) => <option key={n.id} value={n.id}>{n.number}{n.nickname ? ` — ${n.nickname}` : ""}</option>)}
                </select>
              </div>
              {agent && !agent.vapiAssistantId && (
                <button onClick={syncVoice} disabled={syncing} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-500/20 disabled:opacity-50">
                  {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Sync {agent.name} to Vapi first
                </button>
              )}
            </>
          )}
          {agent && !isVoice && (
            <>
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-600">How to reach them</label>
                <div className="flex flex-wrap gap-1.5">
                  {([["whatsapp", "WhatsApp"], ["whatsapp_template", "WhatsApp template"], ["sms", "SMS"]] as const).map(([c, label]) => (
                    <button key={c} onClick={() => setChannel(c)} className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${channel === c ? "border-brand-500 bg-brand-500/10 text-brand-600" : "border-ink-200 text-ink-500 hover:bg-ink-50"}`}>{label}</button>
                  ))}
                </div>
                <p className="mt-1 text-[11px] text-ink-400">
                  {channel === "whatsapp" ? "Free-form — only reaches people who messaged you in the last 24h." : channel === "whatsapp_template" ? "Approved template — works for cold, first contact." : "SMS via Twilio — works for cold contacts, no window."}
                </p>
              </div>
              {channel === "whatsapp_template" ? (
                <div>
                  <label className="mb-1 block text-xs font-medium text-ink-600">Approved template</label>
                  <select value={templateName} onChange={(e) => setTemplateName(e.target.value)} className={inputCls}>
                    <option value="">Choose a template…</option>
                    {templates.map((t) => <option key={t.id} value={t.name}>{t.name} ({t.language})</option>)}
                  </select>
                  {templates.length === 0 && <p className="mt-1 text-[11px] text-amber-600">No approved templates yet — create one in WhatsApp → Templates and get it approved by Meta.</p>}
                </div>
              ) : (
                <div>
                  <label className="mb-1 block text-xs font-medium text-ink-600">Opening message</label>
                  <textarea value={opener} onChange={(e) => setOpener(e.target.value)} rows={3} className={inputCls} placeholder="Hi! This is…" />
                </div>
              )}
            </>
          )}
          <button onClick={launch} disabled={busy || !agent} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : isVoice ? <PhoneCall className="h-4 w-4" /> : <Send className="h-4 w-4" />}
            {isVoice ? "Start calls" : agent ? "Send messages" : "Choose an agent"}
          </button>
          {agent && !isVoice && <p className="flex items-center gap-1 text-xs text-ink-400"><MessageCircle className="h-3 w-3" /> Replies are handled automatically by the agent.</p>}
        </div>
      </div>
    </Card>
  );
}
