"use client";

import { useCallback, useEffect, useState } from "react";
import { Megaphone, RefreshCw, ExternalLink, Plug, DollarSign, Eye, MousePointerClick, Percent } from "lucide-react";
import { Card, StatusBadge } from "@/components/ui";

// Meta Ads — live view of the clinic's real Meta ad accounts and campaigns,
// served through the Hyperfx backend (meta_business toolkit). The Meta account
// is connected once on hyperfx.ai → Connections; this page then just works.

interface MetaAccount { id: string; name: string; status: string; currency: string; spentTotal: number }
interface MetaCampaign { id: string; name: string; status: string; objective: string; dailyBudget: number | null; lifetimeBudget: number | null; startTime: string | null }
interface MetaInsights { spend: number; impressions: number; clicks: number; ctr: number; cpc: number }

interface MetaData {
  configured: boolean;
  connected?: boolean;
  error?: string;
  accounts?: MetaAccount[];
  account?: string;
  campaigns?: MetaCampaign[];
  insights?: MetaInsights | null;
  campaignsError?: string | null;
  insightsError?: string | null;
}

const money = (n: number, cur = "USD") => `${cur === "USD" ? "$" : `${cur} `}${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const statusTone = (s: string): "green" | "amber" | "gray" | "red" =>
  s === "ACTIVE" || s === "Active" ? "green" : s === "PAUSED" ? "amber" : /DELET|DISABLE|ARCHIV/i.test(s) ? "red" : "gray";

export default function MetaAdsPage() {
  const [data, setData] = useState<MetaData | null>(null);
  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState<string>("");

  const fetchData = useCallback((acct?: string) => {
    fetch(`/api/hyperfx/meta${acct ? `?account=${encodeURIComponent(acct)}` : ""}`)
      .then((r) => r.json())
      .then((d) => { setData(d); if (d.account) setAccount(d.account); })
      .catch((e) => setData({ configured: true, connected: false, error: e instanceof Error ? e.message : "Request failed" }))
      .finally(() => setLoading(false));
  }, []);
  // loading starts true, so the initial effect only fires the fetch (no sync setState).
  const load = useCallback((acct?: string) => { setLoading(true); fetchData(acct); }, [fetchData]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const cur = data?.accounts?.find((a) => a.id === account)?.currency ?? "USD";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-xl font-bold text-ink-900">
            <Megaphone className="h-5 w-5 text-brand-500" /> Meta Ads
          </h1>
          <p className="text-sm text-ink-500">Your live Meta ad accounts and running campaigns — powered by the Hyperfx backend.</p>
        </div>
        <div className="flex items-center gap-2">
          {(data?.accounts?.length ?? 0) > 1 && (
            <select
              value={account}
              onChange={(e) => { setAccount(e.target.value); load(e.target.value); }}
              className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-sm text-ink-700 outline-none"
              title="Ad account"
            >
              {data!.accounts!.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
          <button onClick={() => load(account || undefined)} className="flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {loading && !data && <Card className="p-10 text-center text-sm text-ink-400">Loading Meta ads…</Card>}

      {data && !data.configured && (
        <Card className="p-8">
          <p className="flex items-center gap-2 font-semibold text-ink-900"><Plug className="h-5 w-5 text-brand-500" /> Connect the Hyperfx backend first</p>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-ink-600">
            <li>In Netlify → Environment variables, add <code className="rounded bg-ink-100 px-1">HYPERFX_MCP_URL</code> and <code className="rounded bg-ink-100 px-1">HYPERFX_API_KEY</code> (from your hyperfx.ai account).</li>
            <li>Redeploy the site.</li>
            <li>On <a className="text-brand-600 underline" href="https://hyperfx.ai" target="_blank" rel="noreferrer">hyperfx.ai</a> → Connections, connect your <strong>Meta Business</strong> account.</li>
          </ol>
        </Card>
      )}

      {data && data.configured && data.connected === false && (
        <Card className="p-8">
          <p className="flex items-center gap-2 font-semibold text-ink-900"><Plug className="h-5 w-5 text-amber-500" /> Meta isn&apos;t connected on Hyperfx yet</p>
          <p className="mt-2 max-w-2xl text-sm text-ink-600">
            The Hyperfx backend answered, but the <strong>Meta Business</strong> toolkit isn&apos;t connected/enabled for your Hyperfx account.
            Connect it once on hyperfx.ai and this page fills itself — same for Google Ads, Google Calendar, TikTok and every other platform Hyperfx supports.
          </p>
          {data.error && <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">{data.error}</p>}
          <a href="https://hyperfx.ai" target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
            Connect on hyperfx.ai <ExternalLink className="h-3.5 w-3.5" />
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
              <p className="text-sm text-ink-500">Everything running (or paused) on this ad account.</p>
            </div>
            {data.campaignsError ? (
              <p className="px-5 py-8 text-center text-sm text-amber-600">{data.campaignsError}</p>
            ) : (data.campaigns?.length ?? 0) === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-ink-400">No campaigns on this ad account yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="border-b border-ink-200 bg-ink-50 text-xs font-semibold uppercase tracking-wide text-ink-500">
                    <tr>
                      <th className="px-5 py-2.5">Campaign</th>
                      <th className="px-4 py-2.5">Status</th>
                      <th className="px-4 py-2.5">Objective</th>
                      <th className="px-4 py-2.5 text-right">Daily budget</th>
                      <th className="px-4 py-2.5">Started</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.campaigns!.map((c) => (
                      <tr key={c.id} className="border-b border-ink-100 last:border-0">
                        <td className="px-5 py-3 font-medium text-ink-900">{c.name}</td>
                        <td className="px-4 py-3"><StatusBadge status={c.status} tone={statusTone(c.status)} /></td>
                        <td className="px-4 py-3 text-ink-600">{c.objective.replaceAll("OUTCOME_", "").replaceAll("_", " ").toLowerCase()}</td>
                        <td className="px-4 py-3 text-right text-ink-700">{c.dailyBudget != null ? money(c.dailyBudget, cur) : c.lifetimeBudget != null ? `${money(c.lifetimeBudget, cur)} lifetime` : "—"}</td>
                        <td className="px-4 py-3 text-ink-600">{c.startTime ? c.startTime.slice(0, 10) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          {data.insightsError && <p className="text-xs text-ink-400">Performance metrics unavailable: {data.insightsError}</p>}
        </>
      )}
    </div>
  );
}
