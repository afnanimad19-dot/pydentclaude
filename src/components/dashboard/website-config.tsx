"use client";

import { useEffect, useState } from "react";
import { Globe } from "lucide-react";
import { Card } from "@/components/ui";
import { Field, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import { fetchClinicSettings, saveClinicSettings } from "@/lib/db";

// Stores the clinic's website URL so AI agents can pull knowledge from it
// (hours, services, pricing, FAQs) when you create or edit an agent.
export function WebsiteConfigCard() {
  const [website, setWebsite] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchClinicSettings().then((s) => {
      setWebsite(s.website);
      setLoading(false);
    });
  }, []);

  async function save() {
    setSaving(true);
    const res = await saveClinicSettings({ website });
    setSaving(false);
    toast(res.message, res.ok ? "success" : "info");
  }

  return (
    <Card className="p-6">
      <h2 className="flex items-center gap-2 font-semibold text-ink-900">
        <Globe className="h-5 w-5 text-brand-500" /> Clinic website
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-500">
        Add your website link. When you build an AI agent you can <strong>import knowledge straight from your site</strong> —
        hours, services, pricing and FAQs — with one click.
      </p>
      {loading ? (
        <p className="py-6 text-sm text-ink-500">Loading…</p>
      ) : (
        <div className="mt-5 flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1">
            <Field label="Website URL">
              <input className={inputCls} placeholder="https://www.brightsmiledental.com" value={website} onChange={(e) => setWebsite(e.target.value)} />
            </Field>
          </div>
          <button onClick={save} disabled={saving} className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </Card>
  );
}
