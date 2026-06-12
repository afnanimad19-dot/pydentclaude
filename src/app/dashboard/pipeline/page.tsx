"use client";

import { useEffect, useState } from "react";
import { Plus, TrendingUp, CircleDollarSign, Hourglass, Bot, Pencil, Check, X, Trash2 } from "lucide-react";
import { PageHeader, DemoBanner, ChannelBadge, StatCard } from "@/components/ui";
import { Modal, Field, ModalFooter, inputCls } from "@/components/modal";
import { fetchAgents, fetchFollowUps, enrollFollowUp, type AiAgent } from "@/lib/db";
import { pipeline as initialPipeline, formatMoney, type PipelineStage, type Deal } from "@/lib/mock-data";

export default function PipelinePage() {
  const [stages, setStages] = useState<PipelineStage[]>(initialPipeline);
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [followUps, setFollowUps] = useState<Record<string, string>>({});
  const [dealModal, setDealModal] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");

  useEffect(() => {
    fetchAgents().then((r) => setAgents(r.agents));
    fetchFollowUps().then(setFollowUps);
  }, []);

  const allDeals = stages.flatMap((s) => s.deals);
  const totalValue = allDeals.reduce((sum, d) => sum + d.value, 0);

  const followUpAgent =
    agents.find((a) => a.role === "Follow-up" && a.status === "Live") ??
    agents.find((a) => a.role === "Follow-up") ??
    agents.find((a) => a.kind === "chat");

  async function toggleFollowUp(dealId: string, patientName: string) {
    if (!followUpAgent) return;
    setFollowUps((prev) => ({ ...prev, [dealId]: followUpAgent.id }));
    await enrollFollowUp(dealId, followUpAgent.id, patientName);
  }

  function addDeal(deal: Omit<Deal, "id" | "daysInStage">, stageId: string) {
    setStages((prev) =>
      prev.map((s) =>
        s.id === stageId
          ? { ...s, deals: [{ ...deal, id: `local-${Date.now()}`, daysInStage: 0 }, ...s.deals] }
          : s
      )
    );
  }

  function moveDeal(dealId: string, toStageId: string) {
    setStages((prev) => {
      let moved: Deal | undefined;
      const without = prev.map((s) => {
        const found = s.deals.find((d) => d.id === dealId);
        if (found) moved = found;
        return { ...s, deals: s.deals.filter((d) => d.id !== dealId) };
      });
      if (!moved) return prev;
      return without.map((s) => (s.id === toStageId ? { ...s, deals: [{ ...moved!, daysInStage: 0 }, ...s.deals] } : s));
    });
  }

  function renameStage(id: string) {
    setStages((prev) => prev.map((s) => (s.id === id ? { ...s, name: renameText || s.name } : s)));
    setRenaming(null);
  }

  function addStage() {
    setStages((prev) => [...prev, { id: `stage-${Date.now()}`, name: "New stage", deals: [] }]);
  }

  function removeStage(id: string) {
    setStages((prev) => prev.filter((s) => s.id !== id || s.deals.length > 0));
  }

  return (
    <>
      {dealModal && (
        <AddDealModal stages={stages} onClose={() => setDealModal(false)} onAdd={addDeal} />
      )}
      <DemoBanner context="Lifecycle stages are editable — rename, add or remove them to match how your clinic works." />
      <PageHeader
        title="Pipeline"
        subtitle="Every lead's lifecycle, from first message to paying patient. Move deals between stages with the stage menu on each card."
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
        <StatCard icon={CircleDollarSign} label="Pipeline value" value={formatMoney(totalValue)} hint={`${allDeals.length} open opportunities`} accent="brand" />
        <StatCard icon={TrendingUp} label="Accepted this month" value="$23,400" hint="61% case acceptance" accent="green" />
        <StatCard icon={Hourglass} label="Avg time to schedule" value="4.2 days" hint="from first contact" accent="amber" />
      </div>

      <div className="flex gap-4 overflow-x-auto pb-4">
        {stages.map((stage) => {
          const stageValue = stage.deals.reduce((sum, d) => sum + d.value, 0);
          return (
            <div key={stage.id} className="w-72 shrink-0">
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
                        {stage.deals.length}
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
                      {stage.deals.length === 0 && (
                        <button onClick={() => removeStage(stage.id)} className="rounded p-0.5 text-ink-300 hover:text-rose-500" title="Remove empty stage">
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </h2>
                    <span className="text-xs font-medium text-ink-400">{formatMoney(stageValue)}</span>
                  </>
                )}
              </div>
              <div className="min-h-24 space-y-3 rounded-2xl bg-ink-100/60 p-3">
                {stage.deals.map((deal) => (
                  <div key={deal.id} className="rounded-xl border border-ink-200 bg-surface p-4 shadow-sm transition-shadow hover:shadow-md">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-semibold text-ink-900">{deal.patientName}</p>
                      <span className="text-sm font-semibold text-brand-600 dark:text-brand-300">{formatMoney(deal.value)}</span>
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
  const [value, setValue] = useState("");
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
        value: Number(value) || 0,
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
        <div className="grid grid-cols-2 gap-4">
          <Field label="Value ($)">
            <input className={inputCls} type="number" placeholder="4800" value={value} onChange={(e) => setValue(e.target.value)} />
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
        </div>
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
