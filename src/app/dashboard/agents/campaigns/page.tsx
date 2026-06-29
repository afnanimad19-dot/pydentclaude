"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Megaphone, Plus, Trash2, PhoneOutgoing, PhoneIncoming, Users, Bot, PhoneCall, Pencil } from "lucide-react";
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
  type Campaign,
  type AiAgent,
  type VoiceNumber,
  type PatientFolder,
  type VoiceCallRecord,
} from "@/lib/db";
import type { Patient } from "@/lib/mock-data";

const statusTone = { active: "green", paused: "amber", draft: "gray" } as const;

export default function CampaignsPage() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [numbers, setNumbers] = useState<VoiceNumber[]>([]);
  const [folders, setFolders] = useState<PatientFolder[]>([]);
  const [calls, setCalls] = useState<VoiceCallRecord[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [folderMap, setFolderMap] = useState<Record<string, string>>({});
  const [calling, setCalling] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Campaign | null>(null);

  function refresh() { fetchCampaigns().then(setCampaigns); }
  useEffect(() => {
    refresh();
    fetchAgents().then((r) => setAgents(r.agents.filter((a) => a.kind === "voice")));
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
        title="Campaigns"
        subtitle="Group your calls into campaigns — pair a voice agent with a phone number and a contact list, then track every call under it."
        actions={
          <button onClick={() => setOpen(true)} className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
            <Plus className="h-4 w-4" /> New campaign
          </button>
        }
      />

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
