"use client";

import { useEffect, useState } from "react";
import { Palette, Plus, Trash2, UploadCloud, FileText, Save, Stethoscope, Building2 } from "lucide-react";
import { Card, PageHeader } from "@/components/ui";
import { Field, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import {
  fetchBrandKnowledge,
  saveBrandKnowledge,
  fetchBrandDocuments,
  addBrandDocument,
  deleteBrandDocument,
  fetchWorkspaceName,
  emptyBrandDetails,
  type BrandKnowledge,
  type BrandDetails,
  type BrandDoctor,
  type BrandDocument,
} from "@/lib/db";

// Brand Identity — the clinic's single source of truth for who they are, so
// every AI post, ad, email and reply sounds like the real clinic. Saved to the
// brand knowledge the agents already read.
export default function BrandIdentityPage() {
  const [brand, setBrand] = useState<BrandKnowledge>({ profile: "", logoUrl: "", colors: "", details: emptyBrandDetails });
  const [docs, setDocs] = useState<BrandDocument[]>([]);
  const [clinicName, setClinicName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    Promise.all([fetchBrandKnowledge(), fetchBrandDocuments(), fetchWorkspaceName()]).then(([b, d, name]) => {
      setBrand({ ...b, details: b.details ?? emptyBrandDetails });
      setDocs(d);
      setClinicName(name);
      setLoading(false);
    });
  }, []);

  const d = brand.details ?? emptyBrandDetails;
  const setD = (patch: Partial<BrandDetails>) => setBrand((b) => ({ ...b, details: { ...(b.details ?? emptyBrandDetails), ...patch } }));
  const setDoctor = (i: number, patch: Partial<BrandDoctor>) =>
    setD({ doctors: d.doctors.map((doc, j) => (j === i ? { ...doc, ...patch } : doc)) });

  async function save() {
    setSaving(true);
    const res = await saveBrandKnowledge(brand);
    setSaving(false);
    toast(res.message, res.ok ? "success" : "info");
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    for (const file of Array.from(files).slice(0, 10)) {
      try {
        let content = "";
        if (/\.(txt|md|csv|json|html)$/i.test(file.name)) {
          content = await file.text();
        } else {
          const fd = new FormData();
          fd.append("file", file);
          const res = await fetch("/api/kb/extract", { method: "POST", body: fd });
          const j = await res.json().catch(() => ({}));
          content = j.text ?? "";
        }
        if (content.trim()) await addBrandDocument(file.name, content);
      } catch { /* skip this file */ }
    }
    setDocs(await fetchBrandDocuments());
    setUploading(false);
    toast("Documents added to brand knowledge.", "success");
  }

  if (loading) return <p className="py-20 text-center text-sm text-ink-500">Loading brand identity…</p>;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Brand Identity"
        subtitle="Your clinic's identity, in one place — the AI agents use this to write on-brand posts, ads, emails and replies. Fill it in once; everything downstream gets better."
      />

      <div className="flex justify-end">
        <button onClick={save} disabled={saving} className="flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
          <Save className="h-4 w-4" /> {saving ? "Saving…" : "Save brand identity"}
        </button>
      </div>

      {/* Clinic basics */}
      <Card className="p-6">
        <h2 className="flex items-center gap-2 font-semibold text-ink-900"><Building2 className="h-5 w-5 text-brand-500" /> The clinic</h2>
        <p className="mt-1 text-sm text-ink-500">Clinic name is set in Settings and shown everywhere{clinicName ? `: currently “${clinicName}”.` : "."}</p>
        <div className="mt-5 grid gap-4">
          <Field label="About the clinic (what you do, who you serve, what makes you different)">
            <textarea className={`${inputCls} min-h-[90px]`} value={d.about} onChange={(e) => setD({ about: e.target.value })} placeholder="A modern family dental clinic in Dubai Marina focused on gentle, anxiety-free care…" />
          </Field>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Services / specialties (comma-separated)">
              <input className={inputCls} value={d.services} onChange={(e) => setD({ services: e.target.value })} placeholder="Implants, Invisalign, whitening, cleanings, veneers" />
            </Field>
            <Field label="Brand voice / tone">
              <input className={inputCls} value={d.tone} onChange={(e) => setD({ tone: e.target.value })} placeholder="Warm, reassuring, professional — never salesy" />
            </Field>
          </div>
        </div>
      </Card>

      {/* Doctors */}
      <Card className="p-6">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-semibold text-ink-900"><Stethoscope className="h-5 w-5 text-brand-500" /> Doctors & team</h2>
          <button onClick={() => setD({ doctors: [...d.doctors, { name: "", specialty: "", experience: "", email: "" }] })} className="flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50">
            <Plus className="h-4 w-4" /> Add doctor
          </button>
        </div>
        <p className="mt-1 text-sm text-ink-500">Names, specialties and experience — so posts and bios use real credentials.</p>
        {d.doctors.length === 0 ? (
          <p className="mt-4 rounded-xl border border-dashed border-ink-200 px-4 py-6 text-center text-sm text-ink-400">No doctors added yet.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {d.doctors.map((doc, i) => (
              <div key={i} className="grid gap-3 rounded-xl border border-ink-200 p-3 md:grid-cols-[1fr_1fr_1fr_1fr_auto]">
                <input className={inputCls} value={doc.name} onChange={(e) => setDoctor(i, { name: e.target.value })} placeholder="Dr. Leila Hariri" />
                <input className={inputCls} value={doc.specialty} onChange={(e) => setDoctor(i, { specialty: e.target.value })} placeholder="Orthodontist" />
                <input className={inputCls} value={doc.experience} onChange={(e) => setDoctor(i, { experience: e.target.value })} placeholder="12 years" />
                <input className={inputCls} value={doc.email} onChange={(e) => setDoctor(i, { email: e.target.value })} placeholder="dr.leila@clinic.com" />
                <button onClick={() => setD({ doctors: d.doctors.filter((_, j) => j !== i) })} className="rounded-lg p-2 text-ink-400 hover:bg-rose-500/10 hover:text-rose-500" title="Remove"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Contact + socials */}
      <Card className="p-6">
        <h2 className="font-semibold text-ink-900">Contact & social handles</h2>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <Field label="Contact email"><input className={inputCls} value={d.contactEmail} onChange={(e) => setD({ contactEmail: e.target.value })} placeholder="hello@clinic.com" /></Field>
          <Field label="Phone"><input className={inputCls} value={d.phone} onChange={(e) => setD({ phone: e.target.value })} placeholder="+971 …" /></Field>
          <Field label="Address"><input className={inputCls} value={d.address} onChange={(e) => setD({ address: e.target.value })} placeholder="Dubai Marina, Dubai, UAE" /></Field>
          <Field label="Website"><input className={inputCls} value={d.website} onChange={(e) => setD({ website: e.target.value })} placeholder="https://clinic.com" /></Field>
          <Field label="Instagram"><input className={inputCls} value={d.instagram} onChange={(e) => setD({ instagram: e.target.value })} placeholder="@clinic" /></Field>
          <Field label="Facebook"><input className={inputCls} value={d.facebook} onChange={(e) => setD({ facebook: e.target.value })} placeholder="facebook.com/clinic" /></Field>
          <Field label="TikTok"><input className={inputCls} value={d.tiktok} onChange={(e) => setD({ tiktok: e.target.value })} placeholder="@clinic" /></Field>
        </div>
      </Card>

      {/* Visual identity */}
      <Card className="p-6">
        <h2 className="flex items-center gap-2 font-semibold text-ink-900"><Palette className="h-5 w-5 text-brand-500" /> Visual identity</h2>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <Field label="Logo URL (paste a public link to your logo)">
            <input className={inputCls} value={brand.logoUrl} onChange={(e) => setBrand((b) => ({ ...b, logoUrl: e.target.value }))} placeholder="https://…/logo.png" />
          </Field>
          <Field label="Brand colours (hex, comma-separated)">
            <input className={inputCls} value={brand.colors} onChange={(e) => setBrand((b) => ({ ...b, colors: e.target.value }))} placeholder="#0F766E, #F59E0B" />
          </Field>
        </div>
        <div className="mt-3 flex items-center gap-4">
          {brand.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brand.logoUrl} alt="Logo preview" className="h-14 w-14 rounded-lg border border-ink-200 object-contain p-1" />
          ) : null}
          <div className="flex gap-2">
            {brand.colors.split(",").map((c) => c.trim()).filter(Boolean).slice(0, 8).map((c, i) => (
              <span key={i} className="h-7 w-7 rounded-full border border-ink-200" style={{ background: c }} title={c} />
            ))}
          </div>
        </div>
      </Card>

      {/* Brand documents */}
      <Card className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 font-semibold text-ink-900"><FileText className="h-5 w-5 text-brand-500" /> Brand documents</h2>
          <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50">
            <UploadCloud className="h-4 w-4" /> {uploading ? "Reading…" : "Upload files"}
            <input type="file" multiple accept=".pdf,.doc,.docx,.txt,.md,.csv,.json,.html" className="hidden" onChange={(e) => onFiles(e.target.files)} disabled={uploading} />
          </label>
        </div>
        <p className="mt-1 text-sm text-ink-500">Brand guidelines, price lists, service menus, treatment info — the agents read these when they write. PDFs and Word docs are converted to text automatically.</p>
        {docs.length === 0 ? (
          <p className="mt-4 rounded-xl border border-dashed border-ink-200 px-4 py-6 text-center text-sm text-ink-400">No documents yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-ink-100">
            {docs.map((doc) => (
              <li key={doc.id} className="flex items-center gap-3 py-2.5">
                <FileText className="h-4 w-4 shrink-0 text-ink-400" />
                <span className="min-w-0 flex-1 truncate text-sm text-ink-800">{doc.name}</span>
                <span className="shrink-0 text-xs text-ink-400">{doc.content.length.toLocaleString()} chars</span>
                <button onClick={async () => { await deleteBrandDocument(doc.id); setDocs(await fetchBrandDocuments()); }} className="rounded-lg p-1.5 text-ink-400 hover:bg-rose-500/10 hover:text-rose-500" title="Remove"><Trash2 className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="flex justify-end">
        <button onClick={save} disabled={saving} className="flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
          <Save className="h-4 w-4" /> {saving ? "Saving…" : "Save brand identity"}
        </button>
      </div>
    </div>
  );
}
