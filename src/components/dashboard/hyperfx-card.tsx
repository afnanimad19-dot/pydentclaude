"use client";

import { useEffect, useState } from "react";
import { Zap, ExternalLink, RefreshCw, CheckCircle2 } from "lucide-react";
import { Card, StatusBadge } from "@/components/ui";

// Connections card for the Hyperfx.ai backend. Hyperfx is the tool engine
// behind Pydent for ads (Meta/Google/TikTok/…), Google Calendar, SEO/AI-search
// and social scraping: connect a platform ONCE on hyperfx.ai and it is
// immediately usable from Pydent (e.g. the Meta Ads tab) — one connection,
// both places.

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

  function check() {
    fetch("/api/hyperfx/status")
      .then((r) => r.json())
      .then(setS)
      .catch(() => setS({ configured: false, ok: false, error: "Status check failed" }))
      .finally(() => setLoading(false));
  }
  // loading starts true, so the initial effect only fires the fetch (no sync setState).
  function load() {
    setLoading(true);
    check();
  }
  useEffect(check, []);

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

      {!loading && s && (
        <div className="mt-4 space-y-3">
          {!s.configured && (
            <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-sm text-amber-700">
              Add <code className="rounded bg-amber-500/10 px-1">HYPERFX_MCP_URL</code> and <code className="rounded bg-amber-500/10 px-1">HYPERFX_API_KEY</code> (from your hyperfx.ai account) to Netlify environment variables, then redeploy.
            </p>
          )}
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
          <div className="flex items-center gap-3 border-t border-ink-100 pt-3">
            <a href="https://hyperfx.ai" target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
              Manage connections on hyperfx.ai <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <button onClick={load} className="flex items-center gap-1.5 rounded-xl border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Re-check
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
