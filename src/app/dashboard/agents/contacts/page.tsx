"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Users, Plus, Search, Download, Upload, RefreshCw, Trash2, PhoneCall } from "lucide-react";
import { Card, PageHeader, StatusBadge, Avatar } from "@/components/ui";
import { Modal, Field, ModalFooter, inputCls } from "@/components/modal";
import { ContactDetailModal } from "@/components/dashboard/contact-detail";
import { toast } from "@/components/toast";
import { fetchPatients, createPatient, deletePatients } from "@/lib/db";
import { type Patient } from "@/lib/mock-data";

const statusTone: Record<Patient["status"], "green" | "blue" | "gray"> = { Active: "green", New: "blue", Inactive: "gray" };

// Country dial codes with flags for the phone picker.
const COUNTRIES: { flag: string; name: string; dial: string }[] = [
  { flag: "🇦🇪", name: "UAE", dial: "+971" },
  { flag: "🇸🇦", name: "Saudi Arabia", dial: "+966" },
  { flag: "🇶🇦", name: "Qatar", dial: "+974" },
  { flag: "🇰🇼", name: "Kuwait", dial: "+965" },
  { flag: "🇧🇭", name: "Bahrain", dial: "+973" },
  { flag: "🇴🇲", name: "Oman", dial: "+968" },
  { flag: "🇺🇸", name: "United States", dial: "+1" },
  { flag: "🇬🇧", name: "United Kingdom", dial: "+44" },
  { flag: "🇮🇳", name: "India", dial: "+91" },
  { flag: "🇵🇰", name: "Pakistan", dial: "+92" },
  { flag: "🇪🇬", name: "Egypt", dial: "+20" },
  { flag: "🇨🇦", name: "Canada", dial: "+1" },
  { flag: "🇦🇺", name: "Australia", dial: "+61" },
  { flag: "🇩🇪", name: "Germany", dial: "+49" },
  { flag: "🇫🇷", name: "France", dial: "+33" },
  { flag: "🇪🇸", name: "Spain", dial: "+34" },
  { flag: "🇮🇹", name: "Italy", dial: "+39" },
  { flag: "🇧🇷", name: "Brazil", dial: "+55" },
  { flag: "🇿🇦", name: "South Africa", dial: "+27" },
  { flag: "🇳🇬", name: "Nigeria", dial: "+234" },
];

function downloadCsv(rows: (string | number)[][]) {
  const esc = (v: string | number) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = rows.map((r) => r.map(esc).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a");
  a.href = url; a.download = `voice-contacts-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Patient[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"voice" | "all">("voice");
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<Patient | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function refresh() { fetchPatients().then((r) => setContacts(r.patients)); }
  useEffect(() => { refresh(); }, []);

  // Parse a CSV row respecting simple quotes.
  function parseRow(line: string): string[] {
    const out: string[] = []; let cur = ""; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }

  async function onImport(file: File | null) {
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (!lines.length) { toast("That file looks empty.", "info"); return; }
      const header = parseRow(lines[0]).map((h) => h.toLowerCase());
      const looksHeader = header.some((h) => /name|phone|email|mobile/.test(h));
      const idx = (names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));
      const ni = idx(["name"]), fi = idx(["first"]), li = idx(["last"]), pi = idx(["phone", "mobile", "number"]), ei = idx(["email", "mail"]);
      const rows = looksHeader ? lines.slice(1) : lines;
      let added = 0;
      for (const line of rows) {
        const c = parseRow(line);
        const name = (ni >= 0 ? c[ni] : `${fi >= 0 ? c[fi] : ""} ${li >= 0 ? c[li] : ""}`.trim()) || c[0] || "";
        const phone = pi >= 0 ? c[pi] : "";
        const email = ei >= 0 ? c[ei] : "";
        if (!name && !phone && !email) continue;
        const res = await createPatient({ name: name || phone || email, phone, email, birthdate: "", insurance: "", status: "New", sourceChannel: "voice", sourceAgent: "Imported (voice contacts)" });
        if (res.ok) added++;
      }
      toast(`Imported ${added} contact${added === 1 ? "" : "s"}.`, "success");
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Import failed.", "info");
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return contacts.filter((c) => {
      if (sourceFilter === "voice" && c.sourceChannel !== "voice") return false;
      if (statusFilter && c.status !== statusFilter) return false;
      if (!q) return true;
      return [c.name, c.phone, c.email].some((v) => String(v).toLowerCase().includes(q));
    });
  }, [contacts, query, statusFilter, sourceFilter]);

  const allSelected = filtered.length > 0 && filtered.every((c) => selected.has(c.id));
  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) filtered.forEach((c) => next.delete(c.id));
      else filtered.forEach((c) => next.add(c.id));
      return next;
    });
  }
  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function exportCsv(onlySelected: boolean) {
    const list = onlySelected ? filtered.filter((c) => selected.has(c.id)) : filtered;
    const rows: (string | number)[][] = [["Name", "Phone", "Email", "Status", "Source", "Last visit"]];
    list.forEach((c) => rows.push([c.name, c.phone, c.email, c.status, c.sourceChannel ?? "", c.lastVisit ?? ""]));
    downloadCsv(rows);
  }

  async function bulkDelete() {
    const ids = [...selected].filter((id) => filtered.some((c) => c.id === id));
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} contact${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
    setContacts((prev) => prev.filter((c) => !ids.includes(c.id)));
    setSelected(new Set());
    const res = await deletePatients(ids);
    toast(res.message, res.ok ? "success" : "info");
    if (!res.ok) refresh();
  }

  return (
    <>
      {open && <AddContactModal onClose={() => setOpen(false)} onAdded={() => { setOpen(false); refresh(); }} />}
      {detail && <ContactDetailModal contact={detail} onClose={() => setDetail(null)} />}
      <PageHeader
        title="Voice Contacts"
        subtitle="People who called or were added for the voice agents — import a calling list, export, or manage in bulk."
        actions={
          <div className="flex items-center gap-2">
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => onImport(e.target.files?.[0] ?? null)} />
            <button onClick={() => fileRef.current?.click()} disabled={importing} className="flex items-center gap-2 rounded-xl border border-ink-200 px-3.5 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50 disabled:opacity-50"><Upload className="h-4 w-4" /> {importing ? "Importing…" : "Import CSV"}</button>
            <button onClick={() => exportCsv(false)} className="flex items-center gap-2 rounded-xl border border-ink-200 px-3.5 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"><Download className="h-4 w-4" /> Export CSV</button>
            <button onClick={() => setOpen(true)} className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"><Plus className="h-4 w-4" /> Add contact</button>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, phone or email…" className="w-full rounded-xl border border-ink-200 bg-surface py-2.5 pl-9 pr-3 text-sm text-ink-800 outline-none placeholder:text-ink-400 focus:border-brand-400" />
        </div>
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value as "voice" | "all")} className="rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-700 outline-none">
          <option value="voice">Voice contacts only</option>
          <option value="all">All contacts</option>
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-700 outline-none">
          <option value="">All statuses</option>
          <option value="New">New</option>
          <option value="Active">Active</option>
          <option value="Inactive">Inactive</option>
        </select>
        <button onClick={refresh} title="Refresh" className="rounded-xl border border-ink-200 p-2.5 text-ink-500 hover:bg-ink-50"><RefreshCw className="h-4 w-4" /></button>
      </div>

      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-3 py-2">
          <span className="text-sm font-medium text-brand-800 dark:text-brand-300">{selected.size} selected</span>
          <button onClick={() => exportCsv(true)} className="flex items-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-xs font-semibold text-ink-700 hover:bg-ink-50"><Download className="h-3.5 w-3.5" /> Export selected</button>
          <button onClick={bulkDelete} className="flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700"><Trash2 className="h-3.5 w-3.5" /> Delete selected</button>
          <button onClick={() => setSelected(new Set())} className="rounded-lg px-2 py-1.5 text-xs font-medium text-ink-500 hover:text-ink-800">Clear</button>
        </div>
      )}

      {filtered.length === 0 ? (
        <Card className="p-10 text-center text-sm text-ink-500"><Users className="mx-auto mb-2 h-6 w-6 text-ink-300" /> {sourceFilter === "voice" ? "No voice contacts yet — import a calling list or add one." : "No contacts match."}</Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-ink-200 bg-ink-50/50 text-left text-xs uppercase tracking-wide text-ink-400">
                <th className="w-10 px-4 py-3"><input type="checkbox" checked={allSelected} onChange={toggleSelectAll} className="h-4 w-4 cursor-pointer accent-brand-600" title="Select all" /></th>
                <th className="px-5 py-3 font-semibold">Name</th>
                <th className="px-5 py-3 font-semibold">Phone</th>
                <th className="px-5 py-3 font-semibold">Email</th>
                <th className="px-5 py-3 font-semibold">Source</th>
                <th className="px-5 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className={`border-b border-ink-100 last:border-0 hover:bg-ink-50/50 ${selected.has(c.id) ? "bg-brand-50/50" : ""}`}>
                  <td className="px-4 py-3"><input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleSelect(c.id)} className="h-4 w-4 cursor-pointer accent-brand-600" /></td>
                  <td className="px-5 py-3"><button onClick={() => setDetail(c)} className="flex items-center gap-2.5 text-left font-medium text-ink-900 hover:text-brand-600"><Avatar name={c.name} size="sm" /> {c.name}</button></td>
                  <td className="px-5 py-3 text-ink-600">{c.phone || "—"}</td>
                  <td className="px-5 py-3 text-ink-600">{c.email || "—"}</td>
                  <td className="px-5 py-3">
                    {c.sourceChannel === "voice" ? (
                      <span className="inline-flex items-center gap-1 text-xs text-orange-500"><PhoneCall className="h-3 w-3" /> Voice</span>
                    ) : (
                      <span className="text-xs text-ink-400 capitalize">{c.sourceChannel || "—"}</span>
                    )}
                  </td>
                  <td className="px-5 py-3"><StatusBadge status={c.status} tone={statusTone[c.status]} /></td>
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
  const [dial, setDial] = useState(COUNTRIES[0].dial);
  const [localNumber, setLocalNumber] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!firstName.trim() && !lastName.trim()) { toast("Enter a name.", "info"); return; }
    setSaving(true);
    const phone = localNumber.trim() ? `${dial} ${localNumber.replace(/^0+/, "").trim()}` : "";
    const res = await createPatient({ name: `${firstName} ${lastName}`.trim(), phone, email, birthdate: "", insurance: "", status: "New", sourceChannel: "voice", sourceAgent: "Added (voice contacts)" });
    setSaving(false);
    if (!res.ok) { toast(res.message, "info"); return; }
    toast("Contact added.", "success");
    onAdded();
  }

  return (
    <Modal open onClose={onClose} title="Add voice contact">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="First name"><input className={inputCls} value={firstName} onChange={(e) => setFirstName(e.target.value)} /></Field>
        <Field label="Last name"><input className={inputCls} value={lastName} onChange={(e) => setLastName(e.target.value)} /></Field>
        <div className="md:col-span-2">
          <Field label="Phone">
            <div className="flex gap-2">
              <select value={dial} onChange={(e) => setDial(e.target.value)} className="w-32 shrink-0 rounded-xl border border-ink-200 bg-surface px-2 py-2.5 text-sm text-ink-800 outline-none focus:border-brand-400">
                {COUNTRIES.map((c, i) => (
                  <option key={`${c.dial}-${i}`} value={c.dial}>{c.flag} {c.dial}</option>
                ))}
              </select>
              <input className={inputCls} placeholder="50 123 4567" value={localNumber} onChange={(e) => setLocalNumber(e.target.value)} />
            </div>
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Email"><input className={inputCls} placeholder="patient@email.com" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        </div>
      </div>
      <ModalFooter onClose={onClose} submitLabel={saving ? "Saving…" : "Save contact"} onSubmit={submit} />
    </Modal>
  );
}
