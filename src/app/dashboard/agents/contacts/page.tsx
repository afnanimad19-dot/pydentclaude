"use client";

import { useEffect, useMemo, useState } from "react";
import { Users, Plus, Search, Download, RefreshCw } from "lucide-react";
import { Card, PageHeader, StatusBadge, Avatar } from "@/components/ui";
import { Modal, Field, ModalFooter, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import { fetchPatients, createPatient } from "@/lib/db";
import { type Patient } from "@/lib/mock-data";

const statusTone: Record<Patient["status"], "green" | "blue" | "gray"> = { Active: "green", New: "blue", Inactive: "gray" };

function downloadCsv(rows: (string | number)[][]) {
  const esc = (v: string | number) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = rows.map((r) => r.map(esc).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a");
  a.href = url; a.download = `contacts-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Patient[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [open, setOpen] = useState(false);

  function refresh() { fetchPatients().then((r) => setContacts(r.patients)); }
  useEffect(() => { refresh(); }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return contacts.filter((c) => {
      if (statusFilter && c.status !== statusFilter) return false;
      if (!q) return true;
      return [c.name, c.phone, c.email].some((v) => String(v).toLowerCase().includes(q));
    });
  }, [contacts, query, statusFilter]);

  function exportCsv() {
    const rows: (string | number)[][] = [["Name", "Phone", "Email", "Status", "Last visit"]];
    filtered.forEach((c) => rows.push([c.name, c.phone, c.email, c.status, c.lastVisit ?? ""]));
    downloadCsv(rows);
  }

  return (
    <>
      {open && <AddContactModal onClose={() => setOpen(false)} onAdded={() => { setOpen(false); refresh(); }} />}
      <PageHeader
        title="Contacts"
        subtitle="Everyone who contacted the clinic — callers, leads and patients in one place."
        actions={
          <div className="flex items-center gap-2">
            <button onClick={exportCsv} className="flex items-center gap-2 rounded-xl border border-ink-200 px-3.5 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"><Download className="h-4 w-4" /> Export CSV</button>
            <button onClick={() => setOpen(true)} className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"><Plus className="h-4 w-4" /> Add contact</button>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, phone or email…" className="w-full rounded-xl border border-ink-200 bg-surface py-2.5 pl-9 pr-3 text-sm text-ink-800 outline-none placeholder:text-ink-400 focus:border-brand-400" />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-700 outline-none">
          <option value="">All statuses</option>
          <option value="New">New</option>
          <option value="Active">Active</option>
          <option value="Inactive">Inactive</option>
        </select>
        <button onClick={refresh} title="Refresh" className="rounded-xl border border-ink-200 p-2.5 text-ink-500 hover:bg-ink-50"><RefreshCw className="h-4 w-4" /></button>
      </div>

      {filtered.length === 0 ? (
        <Card className="p-10 text-center text-sm text-ink-500"><Users className="mx-auto mb-2 h-6 w-6 text-ink-300" /> No contacts match.</Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-sm">
            <thead>
              <tr className="border-b border-ink-200 bg-ink-50/50 text-left text-xs uppercase tracking-wide text-ink-400">
                <th className="px-5 py-3 font-semibold">Name</th>
                <th className="px-5 py-3 font-semibold">Phone</th>
                <th className="px-5 py-3 font-semibold">Email</th>
                <th className="px-5 py-3 font-semibold">Status</th>
                <th className="px-5 py-3 font-semibold">Last visit</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/50">
                  <td className="px-5 py-3"><a href={`/dashboard/patients/${c.id}`} className="flex items-center gap-2.5 font-medium text-ink-900 hover:text-brand-600"><Avatar name={c.name} size="sm" /> {c.name}</a></td>
                  <td className="px-5 py-3 text-ink-600">{c.phone || "—"}</td>
                  <td className="px-5 py-3 text-ink-600">{c.email || "—"}</td>
                  <td className="px-5 py-3"><StatusBadge status={c.status} tone={statusTone[c.status]} /></td>
                  <td className="px-5 py-3 text-ink-600">{c.lastVisit || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

function AddContactModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!firstName.trim() && !lastName.trim()) { toast("Enter a name.", "info"); return; }
    setSaving(true);
    const res = await createPatient({ name: `${firstName} ${lastName}`.trim(), phone, email, birthdate: "", insurance: "", status: "New" });
    setSaving(false);
    if (!res.ok) { toast(res.message, "info"); return; }
    toast("Contact added.", "success");
    onAdded();
  }

  return (
    <Modal open onClose={onClose} title="Add contact">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="First name"><input className={inputCls} value={firstName} onChange={(e) => setFirstName(e.target.value)} /></Field>
        <Field label="Last name"><input className={inputCls} value={lastName} onChange={(e) => setLastName(e.target.value)} /></Field>
        <Field label="Phone"><input className={inputCls} placeholder="+9714…" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        <Field label="Email"><input className={inputCls} placeholder="patient@email.com" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      </div>
      <ModalFooter onClose={onClose} submitLabel={saving ? "Saving…" : "Save contact"} onSubmit={submit} />
    </Modal>
  );
}
