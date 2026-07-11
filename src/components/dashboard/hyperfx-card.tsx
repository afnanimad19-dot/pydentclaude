"use client";

import { useEffect, useState } from "react";
import { Zap, ExternalLink, RefreshCw, CheckCircle2 } from "lucide-react";
import { Card, StatusBadge } from "@/components/ui";
import { Field, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import { fetchHyperfxConfig, saveHyperfxConfig, emptyHyperfxConfig, getWorkspaceId, type HyperfxConfig } from "@/lib/db";

// Connections card for the Hyperfx.ai backend. Hyperfx is the tool engine
// behind Pydent for ads (Meta/Google/TikTok/…), Google Calendar, SEO/AI-search
// and social scraping: connect a platform ONCE on hyperfx.ai and it is
// immediately usable from Pydent (e.g. the Meta Ads tab) — one connection,
// both places.
//
// MULTI-CLINIC: each clinic can save its OWN Hyperfx account/sub-account
// credentials here, so its connected platforms are isolated from other
// clinics'. Left blank, the app-level env credentials are used.

interface HfxStatus {
  configured: boolean;
  ok: boolean;
  toolCount?: number;
  platforms?: string[];
  error?: string;
}

export function HyperfxCard() {
  const [s, setS] = useState<HfxStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [cfg, setCfg] = useState<HyperfxConfig>(emptyHyperfxConfig);
  const [saving, setSaving] = useState(false);

  function check() {
    getWorkspaceId()
      .then((ws) => fetch(`/api/hyperfx/status?ws=${ws ?? ""}`))
      .then((r) => r.json())
      .then(setS)
      .catch(() => setS({ configured: false, ok: false, error: "Status check failed" }))
      .finally(() => setLoading(false));
  }
  // loading starts true, so the initial effect only fires the fetches (no sync setState).
  function load() {
    setLoading(true);
    check();
  }
  useEffect(() => {
    check();
    fetchHyperfxConfig().then(setCfg);
  }, []);

  async function save() {
    setSaving(true);
    const res = await saveHyperfxConfig(cfg);
    setSaving(false);
    toast(res.message, res.ok ? "success" : "info");
    if (res.ok) load();
  }

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold text-ink-900">
          <Zap className="h-5 w-5 text-brand-500" /> Hyperfx backend (ads · SEO · connectors)
        </h2>
        {loading ? (
          <StatusBadge status="Checking…" tone="gray" />
        ) : s?.ok ? (
          <StatusBadge status="Connected" tone="green" />
        ) : s?.configured ? (
          <StatusBadge status="Unreachable" tone="red" />
        ) : (
          <StatusBadge status="Not configured" tone="gray" />
        )}
      </div>
      <p className="mt-1 max-w-2xl text-sm text-ink-500">
        Hyperfx powers Pydent&apos;s marketing intelligence: Meta &amp; Google Ads, Google Calendar, TikTok, SEO and
        AI-search visibility, social scraping. Connect a platform once on hyperfx.ai and it works here instantly —
        the <strong>Meta Ads</strong> tab reads through it.
      </p>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Field label="This clinic's Hyperfx MCP URL (optional)">
          <input className={inputCls} placeholder="https://mcp.hyperfx.ai/…  (blank = app default)" value={cfg.mcpUrl} onChange={(e) => setCfg((c) => ({ ...c, mcpUrl: e.target.value }))} />
        </Field>
        <Field label="This clinic's Hyperfx API key">
          <input className={inputCls} type="password" autoComplete="new-password" placeholder="hfx_…  (blank = app default)" value={cfg.apiKey} onChange={(e) => setCfg((c) => ({ ...c, apiKey: e.target.value }))} />
        </Field>
      </div>
      <p className="mt-1.5 text-xs text-ink-400">
        With a Hyperfx enterprise plan, each clinic gets its own sub-account — paste that clinic&apos;s MCP URL + key here
        so its connected ad accounts stay separate from every other clinic&apos;s. Leave blank to use the app-level default.
      </p>

      {!loading && s && (
        <div className="mt-4 space-y-3">
          {s.configured && !s.ok && (
            <p className="rounded-xl border border-rose-400/40 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-600">{s.error}</p>
          )}
          {s.ok && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">Live platforms:</span>
              {(s.platforms?.length ?? 0) === 0 ? (
                <span className="text-sm text-ink-500">none enabled yet — connect them on hyperfx.ai</span>
              ) : (
                s.platforms!.map((p) => (
                  <span key={p} className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-600">
                    <CheckCircle2 className="h-3 w-3" /> {p}
                  </span>
                ))
              )}
              <span className="ml-auto text-xs text-ink-400">{s.toolCount ?? 0} tools available</span>
            </div>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-ink-100 pt-4">
        <button onClick={save} disabled={saving} className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
          {saving ? "Saving…" : "Save"}
        </button>
        <button onClick={load} className="flex items-center gap-1.5 rounded-xl border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Re-check
        </button>
        <a href="https://hyperfx.ai" target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1.5 text-sm font-medium text-brand-600 dark:text-brand-300">
          Manage connections on hyperfx.ai <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
    </Card>
  );
}
