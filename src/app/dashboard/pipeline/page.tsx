"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, TrendingUp, Layers, Hourglass, Bot, Pencil, Check, X, Trash2 } from "lucide-react";
import { PageHeader, LiveBanner, ChannelBadge, StatCard } from "@/components/ui";
import { Modal, Field, ModalFooter, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import {
  fetchAgents,
  fetchFollowUps,
  enrollFollowUp,
  fetchStageAgents,
  setStageAgentDb,
  fetchWaConversations,
  setWaLifecycle,
  assignWaAgent,
  setWaStatus,
  fetchPipelineDeals,
  createPipelineDeal,
  updatePipelineDeal,
  deletePipelineDeal,
  fetchPipelineStages,
  savePipelineStages,
  type AiAgent,
  type WaConversation,
  type PipelineDealRecord,
} from "@/lib/db";
import { pipeline as initialPipeline, type PipelineStage, type Deal } from "@/lib/mock-data";

export default function PipelinePage() {
  // Start from the lifecycle stage definitions with no demo deals — live WhatsApp
  // leads (and anything you add) fill them.
  const [stages, setStages] = useState<PipelineStage[]>(() => initialPipeline.map((s) => ({ ...s, deals: [] })));
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [followUps, setFollowUps] = useState<Record<string, string>>({});
  const [dealModal, setDealModal] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [dragOverStage, setDragOverStage] = useState<string | null>(null);
  // Which AI agent owns each stage — a deal entering the stage is handed to it.
  const [stageAgents, setStageAgents] = useState<Record<string, string>>({});
  // Live WhatsApp leads, placed by their lifecycle stage.
  const [liveLeads, setLiveLeads] = useState<WaConversation[]>([]);
  // Manually-added deals, now PERSISTED (were session-only before).
  const [dbDeals, setDbDeals] = useState<PipelineDealRecord[]>([]);

  const loadLeads = useCallback(() => { fetchWaConversations().then(setLiveLeads); }, []);
  useEffect(() => {
    loadLeads();
    fetchPipelineDeals().then(setDbDeals);
    // Custom stage list (added/renamed/removed stages) persists per clinic.
    fetchPipelineStages().then((saved) => {
      if (saved && saved.length) setStages(saved.map((s) => ({ ...s, deals: [] })));
    });
    const t = setInterval(loadLeads, 10000);
    return () => clearInterval(t);
  }, [loadLeads]);

  useEffect(() => {
    fetchAgents().then((r) => {
      setAgents(r.agents);
      // Pre-select a sensible default agent for the first ("New lead") stage so
      // brand-new contacts are picked up automatically.
      const first = initialPipeline[0];
      const defaultAgent =
        r.agents.find((a) => a.kind === "chat" && a.status === "Live" && (a.role === "Receptionist" || a.role === "Appointment setter")) ??
        r.agents.find((a) => a.kind === "chat" && a.status === "Live") ??
        r.agents.find((a) => a.kind === "chat");
      if (first && defaultAgent) setStageAgents((prev) => (prev[first.id] ? prev : { ...prev, [first.id]: defaultAgent.id }));
    });
    fetchFollowUps().then(setFollowUps);
    // Saved stage→agent assignments win over the auto-selected default.
    fetchStageAgents().then((saved) => {
      if (Object.keys(saved).length) setStageAgents((prev) => ({ ...prev, ...saved }));
    });
  }, []);

  function agentLabel(agentId: string | undefined): string | null {
    if (!agentId) return null;
    const a = agents.find((x) => x.id === agentId);
    return a ? `${a.name} (AI)` : null;
  }

  const liveIds = new Set(liveLeads.map((l) => l.id));
  function liveAsDeal(l: WaConversation): Deal {
    return {
      id: l.id,
      patientName: l.contactName,
      treatment: l.lastMessage ? (l.lastMessage.length > 40 ? `${l.lastMessage.slice(0, 40)}…` : l.lastMessage) : "WhatsApp lead",
      value: 0,
      source: "whatsapp",
      owner: agentLabel(l.assignedAgentId ?? undefined) ?? "WhatsApp",
      daysInStage: 0,
    };
  }
  function dbDealToDeal(d: PipelineDealRecord): Deal {
    return { id: d.id, patientName: d.patientName, treatment: d.treatment, value: d.value, source: d.source as Deal["source"], owner: d.owner, daysInStage: 0 };
  }
  // Persisted manual deals + live WhatsApp leads, matched to this stage by name.
  function dealsForStage(stage: PipelineStage): Deal[] {
    return [...liveLeads.filter((l) => l.lifecycle === stage.name).map(liveAsDeal), ...dbDeals.filter((d) => d.stageName === stage.name).map(dbDealToDeal)];
  }

  const allDeals = stages.flatMap((s) => dealsForStage(s));
  const customerCount = stages.filter((s) => s.name === "Customer").reduce((n, s) => n + dealsForStage(s).length, 0);
  const newLeadCount = stages.filter((s) => s.name === "New Lead").reduce((n, s) => n + dealsForStage(s).length, 0);

  const followUpAgent =
    agents.find((a) => a.role === "Follow-up" && a.status === "Live") ??
    agents.find((a) => a.role === "Follow-up") ??
    agents.find((a) => a.kind === "chat");

  async function toggleFollowUp(dealId: string, patientName: string) {
    if (!followUpAgent) return;
    setFollowUps((prev) => ({ ...prev, [dealId]: followUpAgent.id }));
    await enrollFollowUp(dealId, followUpAgent.id, patientName);
  }

  async function addDeal(deal: Omit<Deal, "id" | "daysInStage">, stageId: string) {
    const stage = stages.find((s) => s.id === stageId);
    if (!stage) return;
    const owner = agentLabel(stageAgents[stageId]) ?? deal.owner;
    const res = await createPipelineDeal({ patientName: deal.patientName, treatment: deal.treatment, value: deal.value ?? 0, source: deal.source, owner, stageName: stage.name });
    if (res.ok && res.id) setDbDeals((prev) => [{ id: res.id!, patientName: deal.patientName, treatment: deal.treatment, value: deal.value ?? 0, source: deal.source, owner, stageName: stage.name }, ...prev]);
    else toast(res.message, "info");
  }

  function deleteDeal(dealId: string) {
    setDbDeals((prev) => prev.filter((d) => d.id !== dealId));
    deletePipelineDeal(dealId);
  }

  function moveDeal(dealId: string, toStageId: string) {
    const toStage = stages.find((s) => s.id === toStageId);
    if (!toStage) return;

    // Live WhatsApp lead → persist the new lifecycle, and hand it to the stage's agent.
    if (liveIds.has(dealId)) {
      setLiveLeads((prev) => prev.map((l) => (l.id === dealId ? { ...l, lifecycle: toStage.name } : l)));
      setWaLifecycle(dealId, toStage.name);
      const agentId = stageAgents[toStageId];
      if (agentId) {
        setLiveLeads((prev) => prev.map((l) => (l.id === dealId ? { ...l, assignedAgentId: agentId, status: "open" } : l)));
        assignWaAgent(dealId, agentId);
        setWaStatus(dealId, "open");
      }
      return;
    }

    // Persisted manual deal → move it to the target stage (by name) + persist.
    if (dbDeals.some((d) => d.id === dealId)) {
      const owner = agentLabel(stageAgents[toStageId]) ?? dbDeals.find((d) => d.id === dealId)!.owner;
      setDbDeals((prev) => prev.map((d) => (d.id === dealId ? { ...d, stageName: toStage.name, owner } : d)));
      updatePipelineDeal(dealId, { stageName: toStage.name, owner });
    }
  }

  // Reassign every deal currently in a stage when its agent changes.
  function setStageAgent(stageId: string, agentId: string) {
    setStageAgents((prev) => ({ ...prev, [stageId]: agentId }));
    setStageAgentDb(stageId, agentId || null);
    const owner = agentLabel(agentId);
    const stageName = stages.find((s) => s.id === stageId)?.name;
    if (!owner || !stageName) return;
    setDbDeals((prev) => prev.map((d) => (d.stageName === stageName ? { ...d, owner } : d)));
    dbDeals.filter((d) => d.stageName === stageName).forEach((d) => updatePipelineDeal(d.id, { owner }));
  }

  function renameStage(id: string) {
    const stage = stages.find((s) => s.id === id);
    const newName = renameText || stage?.name || "";
    if (stage && newName && newName !== stage.name) {
      // Re-point this stage's persisted deals (keyed by stage name) to the new name.
      setDbDeals((prev) => prev.map((d) => (d.stageName === stage.name ? { ...d, stageName: newName } : d)));
      dbDeals.filter((d) => d.stageName === stage.name).forEach((d) => updatePipelineDeal(d.id, { stageName: newName }));
    }
    setStages((prev) => {
      const next = prev.map((s) => (s.id === id ? { ...s, name: newName || s.name } : s));
      void savePipelineStages(next);
      return next;
    });
    setRenaming(null);
  }

  function addStage() {
    setStages((prev) => {
      const next = [...prev, { id: `stage-${Date.now()}`, name: "New stage", deals: [] }];
      void savePipelineStages(next);
      return next;
    });
  }

  function removeStage(id: string) {
    // Only remove a stage that has NO cards at all — including live WhatsApp leads
    // (which live in liveLeads, not stage.deals), so we never orphan a lead.
    const stage = stages.find((s) => s.id === id);
    if (stage && dealsForStage(stage).length > 0) {
      toast("Move its leads to another stage first.", "info");
      return;
    }
    setStages((prev) => {
      const next = prev.filter((s) => s.id !== id);
      void savePipelineStages(next);
      return next;
    });
  }

  return (
    <>
      {dealModal && (
        <AddDealModal stages={stages} onClose={() => setDealModal(false)} onAdd={addDeal} />
      )}
      <LiveBanner context="WhatsApp leads appear here automatically by lifecycle stage. Move a lead and it updates everywhere (inbox + pipeline); each stage can own an AI agent that takes over when a lead moves in." />
      <PageHeader
        title="Pipeline"
        subtitle="Every lead's lifecycle, from first message to paying patient. Live WhatsApp leads flow in automatically. Drag cards between stages or use the menu on each card."
        actions={
          <>
            <button
              onClick={addStage}
              className="flex items-center gap-2 rounded-xl border border-ink-200 bg-surface px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"
            >
              <Plus className="h-4 w-4" /> Add stage
            </button>
            <button
              onClick={() => setDealModal(true)}
              className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" /> Add deal
            </button>
          </>
        }
      />

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <StatCard icon={Layers} label="Open opportunities" value={String(allDeals.length)} hint="leads in the pipeline" accent="brand" />
        <StatCard icon={TrendingUp} label="Customers" value={String(customerCount)} hint="converted leads" accent="green" />
        <StatCard icon={Hourglass} label="New leads" value={String(newLeadCount)} hint="awaiting first response" accent="amber" />
      </div>

      <div className="flex gap-5 overflow-x-auto pb-4">
        {stages.map((stage) => {
          const deals = dealsForStage(stage);
          return (
            <div key={stage.id} className="w-80 shrink-0">
              <div className="mb-3 flex items-center justify-between gap-2 px-1">
                {renaming === stage.id ? (
                  <div className="flex flex-1 items-center gap-1">
                    <input
                      autoFocus
                      value={renameText}
                      onChange={(e) => setRenameText(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && renameStage(stage.id)}
                      className="w-full rounded-lg border border-brand-400 bg-surface px-2 py-1 text-sm text-ink-900 outline-none"
                    />
                    <button onClick={() => renameStage(stage.id)} className="rounded p-1 text-emerald-600 hover:bg-emerald-500/10">
                      <Check className="h-4 w-4" />
                    </button>
                    <button onClick={() => setRenaming(null)} className="rounded p-1 text-ink-400 hover:bg-ink-100">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <>
                    <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink-900">
                      {stage.name}{" "}
                      <span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-500">
                        {deals.length}
                      </span>
                      <button
                        onClick={() => {
                          setRenaming(stage.id);
                          setRenameText(stage.name);
                        }}
                        className="rounded p-0.5 text-ink-300 hover:text-ink-600"
                        title="Rename stage"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      {deals.length === 0 && (
                        <button onClick={() => removeStage(stage.id)} className="rounded p-0.5 text-ink-300 hover:text-rose-500" title="Remove empty stage">
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </h2>
                  </>
                )}
              </div>
              {/* Agent assigned to this stage — deals entering it are handed over automatically */}
              <div className="mb-3 flex items-center gap-2 rounded-xl border border-ink-100 bg-surface px-2.5 py-2">
                <Bot className="h-3.5 w-3.5 shrink-0 text-brand-500" />
                <select
                  value={stageAgents[stage.id] ?? ""}
                  onChange={(e) => setStageAgent(stage.id, e.target.value)}
                  className="w-full bg-transparent text-xs font-medium text-ink-700 outline-none"
                  title="AI agent for this stage"
                >
                  <option value="">No agent — manual handling</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name} — {a.role}</option>
                  ))}
                </select>
              </div>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverStage(stage.id);
                }}
                onDragLeave={() => setDragOverStage(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  const dealId = e.dataTransfer.getData("text/deal-id");
                  if (dealId) moveDeal(dealId, stage.id);
                  setDragOverStage(null);
                }}
                className={`min-h-24 space-y-3 rounded-2xl p-3 transition-colors ${
                  dragOverStage === stage.id ? "bg-brand-500/15 ring-2 ring-brand-400" : "bg-ink-100/60"
                }`}
              >
                {deals.map((deal) => (
                  <div
                    key={deal.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/deal-id", deal.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    className="cursor-grab rounded-xl border border-ink-200 bg-surface p-4 shadow-sm transition-shadow hover:shadow-md active:cursor-grabbing"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-semibold text-ink-900">{deal.patientName}</p>
                      {dbDeals.some((d) => d.id === deal.id) && (
                        <button onClick={() => deleteDeal(deal.id)} className="rounded p-0.5 text-ink-300 hover:text-rose-500" title="Delete deal"><Trash2 className="h-3.5 w-3.5" /></button>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-ink-500">{deal.treatment}</p>
                    <div className="mt-3 flex items-center justify-between">
                      {deal.source === "walk-in" || deal.source === "referral" ? (
                        <span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-600 capitalize">{deal.source}</span>
                      ) : (
                        <ChannelBadge channel={deal.source} />
                      )}
                      <span className="text-[11px] text-ink-400">
                        {deal.owner} · {deal.daysInStage}d
                      </span>
                    </div>
                    <select
                      value={stage.id}
                      onChange={(e) => moveDeal(deal.id, e.target.value)}
                      className="mt-2.5 w-full rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-xs text-ink-600 outline-none"
                      title="Move to stage"
                    >
                      {stages.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                    {followUps[deal.id] ? (
                      <span className="mt-2 flex items-center gap-1.5 rounded-lg bg-brand-500/15 px-2.5 py-1.5 text-xs font-medium text-brand-600 dark:text-brand-300">
                        <Bot className="h-3.5 w-3.5" /> Daily follow-up by{" "}
                        {agents.find((a) => a.id === followUps[deal.id])?.name ?? "agent"}
                      </span>
                    ) : (
                      followUpAgent && (
                        <button
                          onClick={() => toggleFollowUp(deal.id, deal.patientName)}
                          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-ink-300 py-1.5 text-xs font-medium text-ink-500 hover:border-brand-400 hover:text-brand-600 dark:hover:text-brand-300"
                        >
                          <Bot className="h-3.5 w-3.5" /> Follow up daily ({followUpAgent.name})
                        </button>
                      )
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function AddDealModal({
  stages,
  onClose,
  onAdd,
}: {
  stages: PipelineStage[];
  onClose: () => void;
  onAdd: (deal: Omit<Deal, "id" | "daysInStage">, stageId: string) => void;
}) {
  const [name, setName] = useState("");
  const [treatment, setTreatment] = useState("");
  const [source, setSource] = useState<Deal["source"]>("whatsapp");
  const [stageId, setStageId] = useState(stages[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (!name.trim()) {
      setError("Enter the patient or lead name.");
      return;
    }
    onAdd(
      {
        patientName: name.trim(),
        treatment: treatment.trim() || "New inquiry",
        value: 0,
        source,
        owner: "Front Desk",
      },
      stageId
    );
    onClose();
  }

  return (
    <Modal open onClose={onClose} title="Add deal" subtitle="A lead or treatment opportunity to track through the lifecycle.">
      {error && <p className="mb-3 text-sm text-amber-600">{error}</p>}
      <div className="grid gap-4">
        <Field label="Patient / lead name">
          <input className={inputCls} placeholder="Karen Phillips" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Treatment / inquiry">
          <input className={inputCls} placeholder="Invisalign consult" value={treatment} onChange={(e) => setTreatment(e.target.value)} />
        </Field>
        <Field label="Source">
          <select className={inputCls} value={source} onChange={(e) => setSource(e.target.value as Deal["source"])}>
            <option value="whatsapp">WhatsApp</option>
            <option value="sms">SMS</option>
            <option value="email">Email</option>
            <option value="voice">Voice call</option>
            <option value="walk-in">Walk-in</option>
            <option value="referral">Referral</option>
          </select>
        </Field>
        <Field label="Stage">
          <select className={inputCls} value={stageId} onChange={(e) => setStageId(e.target.value)}>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>
      </div>
      <ModalFooter onClose={onClose} submitLabel="Add deal" onSubmit={submit} />
    </Modal>
  );
}
