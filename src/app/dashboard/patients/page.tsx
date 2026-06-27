"use client";

import { useCallback, useEffect, useState } from "react";
import { Users, CalendarClock, BellRing, Database, Plus, CalendarPlus, FolderPlus, Folder } from "lucide-react";
import { Card, PageHeader, DemoBanner, StatCard, StatusBadge, Avatar } from "@/components/ui";
import { NewPatientModal, NewAppointmentModal } from "@/components/dashboard/create-modals";
import { ContactDetailModal } from "@/components/dashboard/contact-detail";
import { toast } from "@/components/toast";
import {
  fetchPatients,
  fetchAppointments,
  fetchFolders,
  createFolder,
  movePatientToFolder,
  fetchPatientFolderMap,
  type DataSource,
  type PatientFolder,
} from "@/lib/db";
import { type Patient, type Appointment } from "@/lib/mock-data";

const aptTone = { Confirmed: "green", Scheduled: "blue", Unconfirmed: "amber", Completed: "gray", Broken: "red" } as const;

function LiveBanner() {
  return (
    <div className="mb-6 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-600">
      <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500" />
      <span>
        <strong className="font-semibold">Live database</strong> — patients and appointments are
        reading and writing to your Supabase project in real time.
      </span>
    </div>
  );
}

export default function PatientsPage() {
  const [patientModal, setPatientModal] = useState(false);
  const [aptModal, setAptModal] = useState(false);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [source, setSource] = useState<DataSource>("demo");
  const [folders, setFolders] = useState<PatientFolder[]>([]);
  const [folderMap, setFolderMap] = useState<Record<string, string>>({});
  const [activeFolder, setActiveFolder] = useState<string | "all">("all");
  const [newFolderName, setNewFolderName] = useState("");
  const [addingFolder, setAddingFolder] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkFolder, setBulkFolder] = useState("");
  const [detail, setDetail] = useState<Patient | null>(null);

  const refresh = useCallback(() => {
    fetchPatients().then((r) => {
      setPatients(r.patients);
      setSource(r.source);
    });
    fetchAppointments().then((r) => setAppointments(r.appointments));
    fetchFolders().then(setFolders);
    fetchPatientFolderMap().then(setFolderMap);
  }, []);

  async function addFolder() {
    if (!newFolderName.trim()) return;
    await createFolder(newFolderName.trim());
    setNewFolderName("");
    setAddingFolder(false);
    fetchFolders().then(setFolders);
  }

  async function moveTo(patientId: string, folderId: string) {
    setFolderMap((prev) => {
      const next = { ...prev };
      if (folderId) next[patientId] = folderId;
      else delete next[patientId];
      return next;
    });
    await movePatientToFolder(patientId, folderId || null);
  }

  function toggleSelect(patientId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(patientId)) next.delete(patientId);
      else next.add(patientId);
      return next;
    });
  }

  async function bulkMove() {
    if (!bulkFolder || selected.size === 0) return;
    const ids = [...selected];
    setFolderMap((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = bulkFolder;
      return next;
    });
    await Promise.all(ids.map((id) => movePatientToFolder(id, bulkFolder)));
    const folderName = folders.find((f) => f.id === bulkFolder)?.name ?? "folder";
    toast(`Moved ${ids.length} patient${ids.length > 1 ? "s" : ""} to “${folderName}”.`);
    setSelected(new Set());
    setBulkFolder("");
  }

  useEffect(() => {
    refresh();
  }, [refresh]);

  const recallDue = patients.filter((p) => p.recallDue);
  const visible = patients.filter((p) => activeFolder === "all" || folderMap[p.id] === activeFolder);
  const allVisibleSelected = visible.length > 0 && visible.every((p) => selected.has(p.id));

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visible.forEach((p) => next.delete(p.id));
      else visible.forEach((p) => next.add(p.id));
      return next;
    });
  }

  return (
    <>
      {detail && <ContactDetailModal contact={detail} onClose={() => setDetail(null)} />}
      <NewPatientModal open={patientModal} onClose={() => setPatientModal(false)} onCreated={refresh} />
      <NewAppointmentModal
        open={aptModal}
        onClose={() => setAptModal(false)}
        patientOptions={patients.map((p) => ({ id: p.id, name: p.name }))}
        onCreated={refresh}
      />
      {source === "live" ? (
        <LiveBanner />
      ) : (
        <DemoBanner context="Database not reachable — showing the bundled sample roster." />
      )}
      <PageHeader
        title="Contacts"
        subtitle="Everyone who reached the clinic — click a contact for their details, or open the full chart."
        actions={
          <>
            <span className="hidden items-center gap-2 rounded-xl border border-ink-200 bg-surface px-3.5 py-2 text-xs font-medium text-ink-500 md:flex">
              <Database className="h-4 w-4 text-brand-500" />
              {source === "live" ? "Supabase · live" : "Demo data"}
            </span>
            <button
              onClick={() => setAptModal(true)}
              className="flex items-center gap-2 rounded-xl border border-ink-200 bg-surface px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"
            >
              <CalendarPlus className="h-4 w-4" /> New appointment
            </button>
            <button
              onClick={() => setPatientModal(true)}
              className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" /> New patient
            </button>
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          icon={Users}
          label="Contacts on file"
          value={String(patients.length)}
          hint={`${patients.filter((p) => p.status === "New").length} new`}
          accent="brand"
        />
        <StatCard
          icon={BellRing}
          label="Recall due"
          value={String(recallDue.length)}
          hint="auto-enrolled in recall flow"
          accent="amber"
        />
        <StatCard
          icon={CalendarClock}
          label="Upcoming appointments"
          value={String(appointments.length)}
          hint={`${appointments.filter((a) => a.status === "Unconfirmed").length} unconfirmed`}
          accent="violet"
        />
      </div>

      {/* Folders — organize patients and use folders as broadcast audiences */}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setActiveFolder("all")}
          className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
            activeFolder === "all" ? "bg-brand-600 text-white" : "border border-ink-200 bg-surface text-ink-600 hover:bg-ink-50"
          }`}
        >
          All contacts
        </button>
        {folders.map((f) => (
          <button
            key={f.id}
            onClick={() => setActiveFolder(f.id)}
            className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
              activeFolder === f.id ? "bg-brand-600 text-white" : "border border-ink-200 bg-surface text-ink-600 hover:bg-ink-50"
            }`}
          >
            <Folder className="h-3.5 w-3.5" /> {f.name}
            <span className="opacity-70">({Object.values(folderMap).filter((v) => v === f.id).length})</span>
          </button>
        ))}
        {addingFolder ? (
          <span className="flex items-center gap-1.5">
            <input
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addFolder()}
              placeholder="Folder name…"
              className="rounded-full border border-brand-400 bg-surface px-3.5 py-1.5 text-sm text-ink-900 outline-none"
            />
            <button onClick={addFolder} className="rounded-full bg-brand-600 px-3 py-1.5 text-sm font-medium text-white">Add</button>
          </span>
        ) : (
          <button
            onClick={() => setAddingFolder(true)}
            className="flex items-center gap-1.5 rounded-full border border-dashed border-ink-300 px-3.5 py-1.5 text-sm font-medium text-ink-500 hover:border-brand-400 hover:text-brand-600 dark:hover:text-brand-300"
          >
            <FolderPlus className="h-3.5 w-3.5" /> New folder
          </button>
        )}
      </div>

      <Card className="mt-4 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200 px-5 py-4">
          <h2 className="font-semibold text-ink-900">
            {activeFolder === "all" ? "All contacts" : `Folder: ${folders.find((f) => f.id === activeFolder)?.name}`}
          </h2>
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-3 py-2">
              <span className="text-sm font-medium text-brand-800 dark:text-brand-300">
                {selected.size} selected
              </span>
              <select
                value={bulkFolder}
                onChange={(e) => setBulkFolder(e.target.value)}
                className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs text-ink-700 outline-none"
              >
                <option value="">Move to folder…</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
              <button
                onClick={bulkMove}
                disabled={!bulkFolder}
                className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
              >
                Move
              </button>
              <button
                onClick={() => setSelected(new Set())}
                className="rounded-lg px-2 py-1.5 text-xs font-medium text-ink-500 hover:text-ink-800"
              >
                Clear
              </button>
            </div>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink-200 bg-ink-50 text-xs font-semibold uppercase tracking-wide text-ink-500">
              <tr>
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAll}
                    className="h-4 w-4 cursor-pointer accent-brand-600"
                    title="Select all"
                  />
                </th>
                <th className="px-5 py-3">Contact</th>
                <th className="px-4 py-3">Phone / Email</th>
                <th className="px-4 py-3">Last visit</th>
                <th className="px-4 py-3">Next appt</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Folder</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <tr
                  key={p.id}
                  className={`border-b border-ink-100 last:border-0 hover:bg-ink-50/60 ${selected.has(p.id) ? "bg-brand-50/50" : ""}`}
                >
                  <td className="px-4 py-3.5">
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={() => toggleSelect(p.id)}
                      className="h-4 w-4 cursor-pointer accent-brand-600"
                    />
                  </td>
                  <td className="px-5 py-3.5">
                    <button onClick={() => setDetail(p)} className="flex items-center gap-3 text-left">
                      <Avatar name={p.name} size="sm" />
                      <div>
                        <p className="font-medium text-ink-900 hover:text-brand-600">{p.name}</p>
                        <p className="text-xs text-ink-400">{p.sourceChannel ? `via ${p.sourceChannel}` : `PatNum ${p.patNum}`}</p>
                      </div>
                    </button>
                  </td>
                  <td className="px-4 py-3.5">
                    <p className="text-ink-700">{p.phone}</p>
                    <p className="text-xs text-ink-400">{p.email}</p>
                  </td>
                  <td className="px-4 py-3.5 text-ink-700">{p.lastVisit}</td>
                  <td className="px-4 py-3.5">
                    {p.nextAppointment ? (
                      <span className="text-ink-700">{p.nextAppointment}</span>
                    ) : p.recallDue ? (
                      <StatusBadge status="Recall due" tone="amber" />
                    ) : (
                      <span className="text-ink-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3.5">
                    <StatusBadge status={p.status} tone={p.status === "Active" ? "green" : p.status === "New" ? "blue" : "gray"} />
                  </td>
                  <td className="px-4 py-3.5">
                    <select
                      value={folderMap[p.id] ?? ""}
                      onChange={(e) => moveTo(p.id, e.target.value)}
                      className="rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-xs text-ink-600 outline-none"
                    >
                      <option value="">No folder</option>
                      {folders.map((f) => (
                        <option key={f.id} value={f.id}>{f.name}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-6">
        <Card className="scroll-mt-20 p-5" id="appointments">
          <h2 className="mb-4 font-semibold text-ink-900">Upcoming appointments</h2>
          <ul className="space-y-2.5">
            {appointments.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 rounded-xl border border-ink-100 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink-900">
                    {a.patientName} <span className="font-normal text-ink-400">· AptNum {a.aptNum}</span>
                  </p>
                  <p className="text-xs text-ink-500">
                    {a.procedure} · {a.date} {a.time} · {a.provider} · {a.operatory}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {a.confirmedVia && (
                    <span className="text-[11px] text-ink-400">confirmed via {a.confirmedVia}</span>
                  )}
                  <StatusBadge status={a.status} tone={aptTone[a.status]} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
