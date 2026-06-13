"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Workflow as WorkflowIcon, Zap, Trash2, Pencil, Search } from "lucide-react";
import { Card, PageHeader, DemoBanner, StatusBadge } from "@/components/ui";
import { toast } from "@/components/toast";
import { fetchWorkflows, deleteWorkflow, type Workflow, type DataSource } from "@/lib/db";
import { WORKFLOW_TEMPLATES } from "@/lib/workflow-templates";

const CATEGORIES = ["All Templates", "Auto-responder", "Routing & Assignment", "Recall & Recovery", "Reviews & Feedback", "Ads & Leads"] as const;

export default function WorkflowsPage() {
  const router = useRouter();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [source, setSource] = useState<DataSource>("demo");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("All Templates");
  const [search, setSearch] = useState("");

  const refresh = useCallback(() => {
    fetchWorkflows().then((r) => {
      setWorkflows(r.workflows);
      setSource(r.source);
    });
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const templates = WORKFLOW_TEMPLATES.filter(
    (t) =>
      (category === "All Templates" || t.category === category) &&
      (search === "" || t.name.toLowerCase().includes(search.toLowerCase()) || t.description.toLowerCase().includes(search.toLowerCase()))
  );

  async function remove(id: string, name: string) {
    await deleteWorkflow(id);
    setWorkflows((prev) => prev.filter((w) => w.id !== id));
    toast(`Workflow “${name}” deleted.`);
  }

  return (
    <>
      {source === "demo" && (
        <DemoBanner context="Workflows table not found — run supabase/migrations/0005 in the SQL Editor." />
      )}
      <PageHeader
        title="Workflows"
        subtitle="Automations that run on their own — pick a template or build on the canvas from scratch."
        actions={
          <Link
            href="/dashboard/workflows/builder"
            className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" /> Start from scratch
          </Link>
        }
      />

      {/* My workflows */}
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-400">My workflows</h2>
      {workflows.length === 0 ? (
        <Card className="mb-8 p-8 text-center text-sm text-ink-500">
          No workflows yet — use a template below or start from scratch.
        </Card>
      ) : (
        <div className="mb-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {workflows.map((w) => (
            <Card key={w.id} className="flex flex-col p-5">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div className="rounded-lg bg-brand-500/15 p-2 text-brand-500">
                    <WorkflowIcon className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="font-semibold text-ink-900">{w.name}</p>
                    <p className="text-xs text-ink-400 capitalize">
                      {w.channel} · {w.nodes.length} steps · triggered {w.triggeredToday}× today
                    </p>
                  </div>
                </div>
                <StatusBadge status={w.status} tone={w.status === "Live" ? "green" : w.status === "Paused" ? "amber" : "gray"} />
              </div>
              <div className="mt-3 flex-1 space-y-1">
                {w.nodes.slice(0, 3).map((node) => (
                  <p key={node.id} className="truncate text-xs text-ink-500">
                    <Zap className="mr-1 inline h-3 w-3 text-ink-300" />
                    {node.title}
                  </p>
                ))}
                {w.nodes.length > 3 && <p className="text-xs text-ink-400">+ {w.nodes.length - 3} more steps</p>}
              </div>
              <div className="mt-4 flex gap-2 border-t border-ink-100 pt-3">
                <button
                  onClick={() => router.push(`/dashboard/workflows/builder?id=${w.id}`)}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-brand-600 py-2 text-sm font-semibold text-white hover:bg-brand-700"
                >
                  <Pencil className="h-3.5 w-3.5" /> Open in canvas
                </button>
                <button
                  onClick={() => remove(w.id, w.name)}
                  className="rounded-xl border border-ink-200 px-3 py-2 text-ink-400 hover:text-rose-500"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Template gallery */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-400">Browse workflow templates</h2>
        <div className="flex items-center gap-2 rounded-xl border border-ink-200 bg-surface px-3 py-1.5">
          <Search className="h-4 w-4 text-ink-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search templates"
            className="w-44 bg-transparent text-sm text-ink-800 outline-none placeholder:text-ink-400"
          />
        </div>
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
              category === c ? "bg-brand-600 text-white" : "border border-ink-200 bg-surface text-ink-600 hover:bg-ink-50"
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {templates.map((t) => (
          <Card key={t.key} className="flex flex-col p-5">
            <div className="mb-3 flex h-20 items-center justify-center rounded-xl bg-brand-500/10">
              <WorkflowIcon className="h-8 w-8 text-brand-400" />
            </div>
            <p className="font-semibold text-ink-900">{t.name}</p>
            <p className="mt-1 flex-1 text-sm leading-relaxed text-ink-500">{t.description}</p>
            <p className="mt-2 text-xs text-ink-400">{t.category} · {t.nodes.length} steps</p>
            <button
              onClick={() => router.push(`/dashboard/workflows/builder?template=${t.key}`)}
              className="mt-3 rounded-xl border border-ink-200 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"
            >
              Use Template
            </button>
          </Card>
        ))}
      </div>
    </>
  );
}
