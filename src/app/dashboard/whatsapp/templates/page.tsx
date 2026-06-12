"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Image as ImageIcon, Video, FileText, Phone, Link2, MessageSquare, Trash2 } from "lucide-react";
import { Card, PageHeader, DemoBanner, StatusBadge } from "@/components/ui";
import { Modal, Field, inputCls } from "@/components/modal";
import { fetchWaTemplates, createWaTemplate, type WaTemplate, type WaTemplateButton, type DataSource } from "@/lib/db";

const statusTone = { Draft: "gray", "Pending approval": "amber", Approved: "green", Rejected: "red" } as const;

export default function WaTemplatesPage() {
  const [templates, setTemplates] = useState<WaTemplate[]>([]);
  const [source, setSource] = useState<DataSource>("demo");
  const [modalOpen, setModalOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | WaTemplate["status"]>("all");

  const refresh = useCallback(() => {
    fetchWaTemplates().then((r) => {
      setTemplates(r.templates);
      setSource(r.source);
    });
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const visible = filter === "all" ? templates : templates.filter((t) => t.status === filter);

  return (
    <>
      {modalOpen && <TemplateBuilderModal onClose={() => setModalOpen(false)} onCreated={refresh} />}
      {source === "live" ? (
        <div className="mb-6 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-600">
          <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500" />
          <span>
            <strong className="font-semibold">Live</strong> — templates are stored in your database.
            Once WhatsApp Business is connected, submissions go to Meta for approval (~24h).
          </span>
        </div>
      ) : (
        <DemoBanner context="Templates table not found — run supabase/migrations/0004 in the SQL Editor." />
      )}
      <PageHeader
        title="WhatsApp Templates"
        subtitle="Message templates must be approved by Meta before they can be broadcast. Build, submit, track approval — then use them in broadcasts."
        actions={
          <button
            onClick={() => setModalOpen(true)}
            className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" /> New template
          </button>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {(["all", "Approved", "Pending approval", "Draft", "Rejected"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-3.5 py-1.5 text-sm font-medium capitalize transition-colors ${
              filter === f ? "bg-brand-600 text-white" : "border border-ink-200 bg-surface text-ink-600 hover:bg-ink-50"
            }`}
          >
            {f === "all" ? "All templates" : f}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <Card className="p-10 text-center text-sm text-ink-500">
          No templates here yet — build your first one. Approved templates become selectable in broadcasts.
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {visible.map((t) => (
            <Card key={t.id} className="flex flex-col p-5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-mono text-sm font-semibold text-ink-900">{t.name}</p>
                  <p className="text-xs text-ink-400">{t.category} · {t.language}</p>
                </div>
                <StatusBadge status={t.status} tone={statusTone[t.status]} />
              </div>
              <div className="mt-3 flex-1 rounded-xl bg-[#e7f8d4] p-3 text-sm text-gray-800 shadow-inner dark:bg-[#1f2c1a] dark:text-gray-100">
                {t.headerType === "text" && t.headerText && <p className="mb-1 font-semibold">{t.headerText}</p>}
                {t.headerType === "image" && (
                  <div className="mb-2 flex h-16 items-center justify-center rounded-lg bg-black/10 text-xs text-gray-500 dark:bg-white/10">
                    <ImageIcon className="mr-1 h-4 w-4" /> image header
                  </div>
                )}
                {t.headerType === "video" && (
                  <div className="mb-2 flex h-16 items-center justify-center rounded-lg bg-black/10 text-xs text-gray-500 dark:bg-white/10">
                    <Video className="mr-1 h-4 w-4" /> video header
                  </div>
                )}
                <p className="whitespace-pre-wrap leading-relaxed">{t.body}</p>
                {t.footer && <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">{t.footer}</p>}
                {t.buttons.length > 0 && (
                  <div className="mt-2 space-y-1 border-t border-black/10 pt-2 dark:border-white/10">
                    {t.buttons.map((b, i) => (
                      <p key={i} className="flex items-center justify-center gap-1 text-center text-sm font-medium text-sky-600 dark:text-sky-400">
                        {b.type === "url" ? <Link2 className="h-3.5 w-3.5" /> : b.type === "phone" ? <Phone className="h-3.5 w-3.5" /> : <MessageSquare className="h-3.5 w-3.5" />}
                        {b.text}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

// ----------------------------------------------------------- builder modal

function TemplateBuilderModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<WaTemplate["category"]>("MARKETING");
  const [language, setLanguage] = useState("English");
  const [headerType, setHeaderType] = useState<WaTemplate["headerType"]>("none");
  const [headerText, setHeaderText] = useState("");
  const [body, setBody] = useState("");
  const [footer, setFooter] = useState("Send STOP to opt out");
  const [buttons, setButtons] = useState<WaTemplateButton[]>([]);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  function addButton(type: WaTemplateButton["type"]) {
    if (buttons.length >= 2) return;
    setButtons((b) => [...b, { type, text: "", value: "" }]);
  }
  function setButton(i: number, patch: Partial<WaTemplateButton>) {
    setButtons((b) => b.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  }

  async function submit(asDraft: boolean) {
    if (!name.trim() || !body.trim()) {
      setResult({ ok: false, message: "Template name and body are required." });
      return;
    }
    setSaving(true);
    const res = await createWaTemplate({
      name: name.trim().toLowerCase().replace(/\s+/g, "_"),
      category,
      language,
      headerType,
      headerText,
      body,
      footer,
      buttons: buttons.filter((b) => b.text.trim()),
      status: asDraft ? "Draft" : "Pending approval",
    });
    setSaving(false);
    setResult(
      res.ok
        ? { ok: true, message: asDraft ? "Saved as draft." : "Submitted! Once WhatsApp Business is connected, this goes to Meta for approval (~24 hours)." }
        : res
    );
    if (res.ok) onCreated();
  }

  return (
    <Modal open onClose={onClose} title="New WhatsApp template" subtitle="Built like Meta requires: body with {{1}} variables, optional header, footer and up to 2 buttons." wide>
      {result?.ok ? (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600">{result.message}</div>
      ) : (
        <>
          {result && (
            <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-600">{result.message}</div>
          )}
          <div className="grid gap-6 lg:grid-cols-[1fr_260px]">
            {/* Form */}
            <div className="space-y-4">
              <div className="grid gap-4 md:grid-cols-3">
                <Field label="Template name">
                  <input className={inputCls} placeholder="recall_reminder" value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label="Category">
                  <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value as WaTemplate["category"])}>
                    <option>MARKETING</option>
                    <option>UTILITY</option>
                    <option>AUTHENTICATION</option>
                  </select>
                </Field>
                <Field label="Language">
                  <select className={inputCls} value={language} onChange={(e) => setLanguage(e.target.value)}>
                    {["English", "Spanish", "Arabic", "French", "Portuguese"].map((l) => (
                      <option key={l}>{l}</option>
                    ))}
                  </select>
                </Field>
              </div>

              <div>
                <p className="mb-1.5 text-sm font-medium text-ink-700">Header (optional)</p>
                <div className="flex gap-1.5">
                  {(["none", "text", "image", "video", "document"] as const).map((h) => (
                    <button
                      key={h}
                      onClick={() => setHeaderType(h)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize ${
                        headerType === h ? "bg-brand-600 text-white" : "border border-ink-200 text-ink-600 hover:bg-ink-50"
                      }`}
                    >
                      {h}
                    </button>
                  ))}
                </div>
                {headerType === "text" && (
                  <input
                    className={`${inputCls} mt-2`}
                    placeholder="Time for your cleaning! 🦷"
                    value={headerText}
                    onChange={(e) => setHeaderText(e.target.value)}
                  />
                )}
                {(headerType === "image" || headerType === "video" || headerType === "document") && (
                  <p className="mt-2 rounded-lg border border-dashed border-ink-300 px-3 py-2.5 text-xs text-ink-400">
                    The {headerType} file is attached when sending the broadcast.
                  </p>
                )}
              </div>

              <Field label="Body — use {{1}}, {{2}} for variables (patient name, months overdue…)">
                <textarea
                  rows={4}
                  className={inputCls}
                  placeholder={"Hi {{1}}, it's been {{2}} months since your last visit at Bright Smile Dental. We have openings this week — want me to book you in?"}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              </Field>

              <Field label="Footer">
                <input className={inputCls} value={footer} onChange={(e) => setFooter(e.target.value)} />
              </Field>

              <div>
                <p className="mb-1.5 text-sm font-medium text-ink-700">Buttons (max 2)</p>
                <div className="mb-2 flex gap-1.5">
                  <button onClick={() => addButton("url")} disabled={buttons.length >= 2} className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40">+ URL</button>
                  <button onClick={() => addButton("phone")} disabled={buttons.length >= 2} className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40">+ Phone</button>
                  <button onClick={() => addButton("quick_reply")} disabled={buttons.length >= 2} className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40">+ Quick reply</button>
                </div>
                {buttons.map((b, i) => (
                  <div key={i} className="mb-2 flex gap-2">
                    <span className="flex w-24 items-center justify-center rounded-lg bg-ink-100 text-xs font-medium capitalize text-ink-600">
                      {b.type.replace("_", " ")}
                    </span>
                    <input
                      className={inputCls}
                      placeholder="Button text"
                      value={b.text}
                      onChange={(e) => setButton(i, { text: e.target.value })}
                    />
                    {b.type !== "quick_reply" && (
                      <input
                        className={inputCls}
                        placeholder={b.type === "url" ? "https://…" : "+1 305 555 0100"}
                        value={b.value}
                        onChange={(e) => setButton(i, { value: e.target.value })}
                      />
                    )}
                    <button onClick={() => setButtons((x) => x.filter((_, j) => j !== i))} className="rounded-lg p-2 text-ink-400 hover:text-rose-500">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Live phone preview */}
            <div className="hidden lg:block">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Preview</p>
              <div className="rounded-3xl border-4 border-ink-300 bg-[#ece5dd] p-3 dark:bg-[#0b141a]">
                <div className="rounded-xl bg-white p-2.5 text-[13px] leading-relaxed text-gray-800 shadow dark:bg-[#202c33] dark:text-gray-100">
                  {headerType === "text" && headerText && <p className="mb-1 font-semibold">{headerText}</p>}
                  {(headerType === "image" || headerType === "video") && (
                    <div className="mb-2 flex h-20 items-center justify-center rounded-lg bg-gray-200 text-xs text-gray-500 dark:bg-white/10">
                      {headerType === "image" ? <ImageIcon className="h-5 w-5" /> : <Video className="h-5 w-5" />}
                    </div>
                  )}
                  {headerType === "document" && (
                    <div className="mb-2 flex h-12 items-center justify-center rounded-lg bg-gray-200 text-xs text-gray-500 dark:bg-white/10">
                      <FileText className="h-5 w-5" />
                    </div>
                  )}
                  <p className="whitespace-pre-wrap">{body || "Your message body appears here…"}</p>
                  {footer && <p className="mt-1.5 text-[11px] text-gray-500 dark:text-gray-400">{footer}</p>}
                </div>
                {buttons.filter((b) => b.text).map((b, i) => (
                  <div key={i} className="mt-1 rounded-xl bg-white py-2 text-center text-[13px] font-medium text-sky-600 shadow dark:bg-[#202c33] dark:text-sky-400">
                    {b.text}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <button onClick={onClose} className="rounded-xl border border-ink-200 px-4 py-2.5 text-sm font-semibold text-ink-700 hover:bg-ink-50">
              Cancel
            </button>
            <button onClick={() => submit(true)} disabled={saving} className="rounded-xl border border-ink-200 px-4 py-2.5 text-sm font-semibold text-ink-700 hover:bg-ink-50 disabled:opacity-50">
              Save as draft
            </button>
            <button onClick={() => submit(false)} disabled={saving} className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
              {saving ? "Submitting…" : "Submit for approval"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
