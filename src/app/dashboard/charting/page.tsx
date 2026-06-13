"use client";

import { useEffect, useMemo, useState } from "react";
import { Stethoscope, Printer, RotateCcw } from "lucide-react";
import { Card, PageHeader, DemoBanner, Avatar } from "@/components/ui";
import { toast } from "@/components/toast";
import {
  patients,
  toothConditions as seedConditions,
  toothConditionMeta,
  type ToothCondition,
} from "@/lib/mock-data";

// Universal numbering: 1–16 maxillary (top), 17–32 mandibular (bottom).
const UPPER = Array.from({ length: 16 }, (_, i) => i + 1); // 1..16 left→right
const LOWER = Array.from({ length: 16 }, (_, i) => 32 - i); // 32..17 so it lines up under the upper arch

const CONDITIONS = Object.keys(toothConditionMeta) as ToothCondition[];

export default function ChartingPage() {
  const [patientId, setPatientId] = useState(patients[0]?.id ?? "");
  const [brush, setBrush] = useState<ToothCondition>("caries");
  const [chart, setChart] = useState<Record<string, Record<number, ToothCondition>>>(seedConditions);

  // Load seed + any locally-saved edits after mount (localStorage is client-only).
  useEffect(() => {
    Promise.resolve().then(() => {
      let saved: Record<string, Record<number, ToothCondition>> = {};
      try {
        saved = JSON.parse(localStorage.getItem("pydental-tooth-chart") ?? "{}");
      } catch {}
      setChart({ ...seedConditions, ...saved });
    });
  }, []);

  const patient = patients.find((p) => p.id === patientId);
  const teeth = useMemo(() => chart[patientId] ?? {}, [chart, patientId]);

  function persist(next: Record<string, Record<number, ToothCondition>>) {
    setChart(next);
    try {
      localStorage.setItem("pydental-tooth-chart", JSON.stringify(next));
    } catch {}
  }

  function paintTooth(n: number) {
    const current = teeth[n] ?? "healthy";
    const nextCond = current === brush ? "healthy" : brush;
    const nextForPatient = { ...teeth, [n]: nextCond };
    if (nextCond === "healthy") delete nextForPatient[n];
    persist({ ...chart, [patientId]: nextForPatient });
  }

  function resetPatient() {
    const next = { ...chart, [patientId]: {} };
    persist(next);
    toast(`Chart cleared for ${patient?.name ?? "patient"}.`);
  }

  const summary = useMemo(() => {
    const counts: Partial<Record<ToothCondition, number>> = {};
    Object.values(teeth).forEach((c) => (counts[c] = (counts[c] ?? 0) + 1));
    return counts;
  }, [teeth]);

  return (
    <>
      <DemoBanner context="Interactive odontogram — pick a condition, then click teeth to mark them. Edits save locally; connect OpenDental to sync to the live chart." />
      <PageHeader
        title="Charting"
        subtitle="Mark existing and planned dental conditions on a per-patient tooth chart."
        actions={
          <>
            <button
              onClick={() => toast("Chart sent to printer queue (demo).")}
              className="flex items-center gap-2 rounded-xl border border-ink-200 bg-surface px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"
            >
              <Printer className="h-4 w-4" /> Print chart
            </button>
            <button
              onClick={resetPatient}
              className="flex items-center gap-2 rounded-xl border border-ink-200 bg-surface px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"
            >
              <RotateCcw className="h-4 w-4" /> Reset
            </button>
          </>
        }
      />

      {/* Patient + condition palette */}
      <div className="mb-5 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2.5 rounded-xl border border-ink-200 bg-surface px-3 py-2">
          {patient && <Avatar name={patient.name} size="sm" />}
          <select
            value={patientId}
            onChange={(e) => setPatientId(e.target.value)}
            className="bg-transparent text-sm font-medium text-ink-900 outline-none"
          >
            {patients.map((p) => (
              <option key={p.id} value={p.id}>{p.name} · PatNum {p.patNum}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {CONDITIONS.map((c) => (
            <button
              key={c}
              onClick={() => setBrush(c)}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all ${
                brush === c ? "ring-2 ring-offset-1 ring-offset-background" : "opacity-80 hover:opacity-100"
              }`}
              style={{
                backgroundColor: `${toothConditionMeta[c].color}22`,
                color: toothConditionMeta[c].color,
                boxShadow: brush === c ? `0 0 0 2px ${toothConditionMeta[c].color}` : undefined,
              }}
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: toothConditionMeta[c].color }} />
              {toothConditionMeta[c].label}
            </button>
          ))}
        </div>
      </div>

      <Card className="overflow-x-auto p-6">
        <p className="mb-2 text-center text-xs font-semibold uppercase tracking-wide text-ink-400">Maxillary (upper)</p>
        <ToothRow teeth={UPPER} conditions={teeth} onClick={paintTooth} />
        <div className="my-4 border-t border-dashed border-ink-200" />
        <ToothRow teeth={LOWER} conditions={teeth} onClick={paintTooth} bottom />
        <p className="mt-2 text-center text-xs font-semibold uppercase tracking-wide text-ink-400">Mandibular (lower)</p>
      </Card>

      <div className="mt-5 grid gap-4 md:grid-cols-3">
        <Card className="p-5 md:col-span-2">
          <h2 className="mb-3 flex items-center gap-2 font-semibold text-ink-900">
            <Stethoscope className="h-5 w-5 text-brand-500" /> Charted findings
          </h2>
          {Object.keys(teeth).length === 0 ? (
            <p className="text-sm text-ink-500">No conditions charted yet — pick a condition above and click a tooth.</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {Object.entries(teeth)
                .sort((a, b) => Number(a[0]) - Number(b[0]))
                .map(([tooth, cond]) => (
                  <li key={tooth} className="flex items-center justify-between rounded-xl border border-ink-100 px-3.5 py-2.5 text-sm">
                    <span className="font-medium text-ink-900">Tooth #{tooth}</span>
                    <span className="flex items-center gap-1.5" style={{ color: toothConditionMeta[cond].color }}>
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: toothConditionMeta[cond].color }} />
                      {toothConditionMeta[cond].label}
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 font-semibold text-ink-900">Summary</h2>
          <ul className="space-y-2 text-sm">
            {CONDITIONS.filter((c) => c !== "healthy" && summary[c]).map((c) => (
              <li key={c} className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-ink-600">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: toothConditionMeta[c].color }} />
                  {toothConditionMeta[c].label}
                </span>
                <span className="font-semibold text-ink-900">{summary[c]}</span>
              </li>
            ))}
            {Object.keys(summary).length === 0 && <li className="text-ink-400">All teeth healthy.</li>}
          </ul>
        </Card>
      </div>
    </>
  );
}

function ToothRow({
  teeth,
  conditions,
  onClick,
  bottom = false,
}: {
  teeth: number[];
  conditions: Record<number, ToothCondition>;
  onClick: (n: number) => void;
  bottom?: boolean;
}) {
  return (
    <div className="flex min-w-max justify-center gap-1.5">
      {teeth.map((n) => {
        const cond = conditions[n] ?? "healthy";
        const meta = toothConditionMeta[cond];
        const missing = cond === "missing";
        return (
          <button
            key={n}
            onClick={() => onClick(n)}
            title={`Tooth #${n} — ${meta.label}`}
            className={`flex w-9 shrink-0 flex-col items-center gap-1 ${bottom ? "flex-col-reverse" : ""}`}
          >
            <span className={`text-[10px] font-medium ${cond === "healthy" ? "text-ink-400" : "text-ink-700"}`}>{n}</span>
            <span
              className={`flex h-11 w-7 items-center justify-center rounded-md border-2 text-[9px] font-bold transition-transform hover:scale-110 ${
                missing ? "border-dashed" : ""
              }`}
              style={{
                borderColor: meta.color,
                backgroundColor: cond === "healthy" ? "var(--surface)" : `${meta.color}26`,
                color: meta.color,
              }}
            >
              {missing ? "—" : cond !== "healthy" ? meta.label[0].toUpperCase() : ""}
            </span>
          </button>
        );
      })}
    </div>
  );
}
