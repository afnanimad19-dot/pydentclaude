"use client";

import { use, useCallback, useEffect, useState } from "react";
import { Megaphone, RefreshCw, ExternalLink, Plug, DollarSign, Eye, MousePointerClick, Percent } from "lucide-react";
import { Card, StatusBadge } from "@/components/ui";
import { getWorkspaceId } from "@/lib/db";

// Google Ads / TikTok Ads — live view of the clinic's real ad accounts and
// campaigns via the marketing engine. Connect the platform once in Settings →
// Connections → Apps and the page fills itself. (Meta has its own tab.)

const PROVIDERS: Record<string, { label: string; blurb: string }> = {
  google: { label: "Google Ads", blurb: "Your live Google Ads campaigns and last-30-days performance." },
  tiktok: { label: "TikTok Ads", blurb: "Your live TikTok advertising campaigns." },
};

interface AdsCampaign { id: string; name: string; status: string; objective: string; dailyBudget: number | null; startTime: string | null }
interface AdsInsights { spend: number; impressions: number; clicks: number; ctr: number; cpc: number }
interface AdsData {
  configured: boolean;
  connected?: boolean;
  error?: string;
  accounts?: { id: string; name: string; currency: string }[];
  campaigns?: AdsCampaign[];
  insights?: AdsInsights | null;
}

const money = (n: number, cur = "USD") => `${cur === "USD" ? "$" : `${cur} `}${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const statusTone = (s: string): "green" | "amber" | "gray" | "red" =>
  /ACTIVE|ENABLED/i.test(s) ? "green" : /PAUSED/i.test(s) ? "amber" : /REMOV|DELET|DISABLE|ARCHIV/i.test(s) ? "red" : "gray";

export default function AdsProviderPage({ params }: { params: Promise<{ provider: string }> }) {
  const { provider } = use(params);
  const meta = PROVIDERS[provider] ?? PROVIDERS.google;
  const [data, setData] = useState<AdsData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(() => {
    getWorkspaceId()
      .then((ws) => fetch(`/api/hyperfx/ads?provider=${provider}&ws=${ws ?? ""}`))
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setData({ configured: true, connected: false, error: e instanceof Error ? e.message : "Request failed" }))
      .finally(() => setLoading(false));
  }, [provider]);
  const load = useCallback(() => { setLoading(true); fetchData(); }, [fetchData]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const cur = data?.accounts?.[0]?.currency ?? "USD";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-xl font-bold text-ink-900">
            <Megaphone className="h-5 w-5 text-brand-500" /> {meta.label}
          </h1>
          <p className="text-sm text-ink-500">{meta.blurb}</p>
        </div>
        <button onClick={load} className="flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {loading && !data && <Card className="p-10 text-center text-sm text-ink-400">Loading {meta.label}…</Card>}

      {data && (!data.configured || data.connected === false) && (
        <Card className="p-8">
          <p className="flex items-center gap-2 font-semibold text-ink-900"><Plug className="h-5 w-5 text-amber-500" /> {meta.label} isn&apos;t connected yet</p>
          <p className="mt-2 max-w-2xl text-sm text-ink-600">
            Connect {meta.label} in <strong>Settings → Connections → Apps</strong> — once it&apos;s connected, this page fills
            itself with the clinic&apos;s live accounts and campaigns.
          </p>
          {data.error && <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">{data.error}</p>}
          <a href="/dashboard/settings?tab=connections" className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
            Open Connections <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </Card>
      )}

      {data && data.configured && data.connected && (
        <>
          {data.insights && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[
                [DollarSign, "Spend (30d)", money(data.insights.spend, cur)],
                [Eye, "Impressions (30d)", data.insights.impressions.toLocaleString()],
                [MousePointerClick, "Clicks (30d)", data.insights.clicks.toLocaleString()],
                [Percent, "CTR / CPC", `${data.insights.ctr.toFixed(2)}% · ${money(data.insights.cpc, cur)}`],
              ].map(([Icon, label, value], i) => {
                const I = Icon as typeof DollarSign;
                return (
                  <Card key={i} className="p-4">
                    <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400"><I className="h-3.5 w-3.5" /> {label as string}</p>
                    <p className="mt-1.5 text-xl font-bold text-ink-900">{value as string}</p>
                  </Card>
                );
              })}
            </div>
          )}

          <Card className="overflow-hidden">
            <div className="border-b border-ink-200 px-5 py-4">
              <h2 className="font-semibold text-ink-900">Campaigns</h2>
              <p className="text-sm text-ink-500">Everything running (or paused) on this account.</p>
            </div>
            {(data.campaigns?.length ?? 0) === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-ink-400">No campaigns on this account yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="border-b border-ink-200 bg-ink-50 text-xs font-semibold uppercase tracking-wide text-ink-500">
                    <tr>
                      <th className="px-5 py-2.5">Campaign</th>
                      <th className="px-4 py-2.5">Status</th>
                      <th className="px-4 py-2.5">Type</th>
                      <th className="px-4 py-2.5 text-right">Daily budget</th>
                      <th className="px-4 py-2.5">Started</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.campaigns!.map((c) => (
                      <tr key={c.id} className="border-b border-ink-100 last:border-0">
                        <td className="px-5 py-3 font-medium text-ink-900">{c.name}</td>
                        <td className="px-4 py-3"><StatusBadge status={c.status} tone={statusTone(c.status)} /></td>
                        <td className="px-4 py-3 text-ink-600">{c.objective}</td>
                        <td className="px-4 py-3 text-right text-ink-700">{c.dailyBudget != null ? money(c.dailyBudget, cur) : "—"}</td>
                        <td className="px-4 py-3 text-ink-600">{c.startTime ? String(c.startTime).slice(0, 10) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
