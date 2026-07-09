"use client";

import { useEffect, useState } from "react";
import { ShieldCheck, ExternalLink } from "lucide-react";
import { Card, StatusBadge } from "@/components/ui";
import { Field, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import { fetchOpenDentalConfig, saveOpenDentalConfig, odTestConnection, emptyOpenDentalConfig, type OpenDentalConfig } from "@/lib/db";

export function OpenDentalConfigCard() {
  const [cfg, setCfg] = useState<OpenDentalConfig>(emptyOpenDentalConfig);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    fetchOpenDentalConfig().then((c) => {
      setCfg(c);
      setLoading(false);
    });
  }, []);

  function set<K extends keyof OpenDentalConfig>(k: K, v: OpenDentalConfig[K]) {
    setCfg((c) => ({ ...c, [k]: v }));
  }

  async function save() {
    setSaving(true);
    const res = await saveOpenDentalConfig(cfg);
    setSaving(false);
    toast(res.message, res.ok ? "success" : "info");
  }

  async function test() {
    setTesting(true);
    const res = await odTestConnection();
    setTesting(false);
    toast(
      res.ok
        ? `Connected in ${res.mode ?? "live"} mode — ${res.doctors ?? 0} doctor(s) found.${res.mode === "mock" ? " (Mock = safe testing; no real Open Dental data is touched.)" : ""}`
        : `Connection failed: ${res.error}`,
      res.ok ? "success" : "info"
    );
  }

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold text-ink-900">
          <ShieldCheck className="h-5 w-5 text-brand-500" /> Open Dental (local, DHA/MOH-safe)
        </h2>
        {cfg.enabled && cfg.clinicApiUrl ? <StatusBadge status="Connected" tone="green" /> : <StatusBadge status="Not connected" tone="gray" />}
      </div>
      <p className="mt-1 max-w-2xl text-sm text-ink-500">
        Patient/clinical data stays on your clinic server. Pydent only talks to your local middleware (over a Cloudflare
        Tunnel) for live doctor slots and bookings — no medical records ever reach the cloud.
      </p>

      {loading ? (
        <p className="py-8 text-center text-sm text-ink-500">Loading…</p>
      ) : (
        <div className="mt-5 grid gap-4">
          <Field label="Clinic middleware URL (Cloudflare Tunnel)">
            <input className={inputCls} placeholder="https://clinic-api.yourdomain.com" value={cfg.clinicApiUrl} onChange={(e) => set("clinicApiUrl", e.target.value)} />
          </Field>
          <Field label="Middleware API key (shared secret)">
            <input className={inputCls} type="password" placeholder="your private clinic API key" value={cfg.clinicApiKey} onChange={(e) => set("clinicApiKey", e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input type="checkbox" checked={cfg.enabled} onChange={(e) => set("enabled", e.target.checked)} className="h-4 w-4 accent-brand-600" />
            Enable Open Dental booking for this clinic
          </label>
          <div className="flex flex-wrap items-center gap-3 border-t border-ink-100 pt-4">
            <button onClick={save} disabled={saving} className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
              {saving ? "Saving…" : "Save"}
            </button>
            <button onClick={test} disabled={testing || !cfg.clinicApiUrl} className="rounded-xl border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-50">
              {testing ? "Testing…" : "Test connection"}
            </button>
            <a href="https://github.com/afnanimad19-dot/pydentclaude/blob/claude/vigilant-heisenberg-o5g281/OPEN_DENTAL.md" target="_blank" rel="noopener noreferrer" className="ml-auto flex items-center gap-1.5 text-sm font-medium text-brand-600 dark:text-brand-300">
              Setup guide <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
          <p className="text-xs text-ink-400">
            You install the small <strong>Pydent Connector</strong> (Node.js) on your clinic server next to Open Dental; it
            exposes only doctor slots + booking. The connector is in <code>opendental-connector/</code>.
          </p>
        </div>
      )}
    </Card>
  );
}
