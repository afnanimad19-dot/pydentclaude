"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Megaphone, RefreshCw, ExternalLink, Plug, DollarSign, Eye, MousePointerClick, Percent, Plus, MoreVertical, Pencil, Copy, Trash2, X, ChevronDown, ChevronRight, Pause, Play, CalendarDays, AlertTriangle, Lightbulb, Users, ShoppingBag, MessageCircle, Smartphone, ArrowLeft, ImageIcon } from "lucide-react";
import { Card, StatusBadge } from "@/components/ui";
import { Modal, Field, ModalFooter, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import { getWorkspaceId } from "@/lib/db";
import { AdsStatusRow } from "@/components/dashboard/ads-status-row";
import { META_OBJECTIVES, strategiesFor, conversionsFor, MESSAGING_APPS, PLACEMENTS, type MetaStrategy } from "@/lib/meta-strategies";

// Meta Ads — live campaigns with full management, Meta-style:
// campaign → ad sets → ads. Filter by status (active first by default), edit /
// duplicate / delete, create new (PAUSED by default so nothing spends without an
// explicit choice), and click a campaign for its overview: totals, a daily-spend
// graph, and its ad sets & ads. All through the marketing engine.

interface MetaAccount { id: string; name: string; status: string; currency: string }
interface MetaCampaign { id: string; name: string; status: string; objective: string; dailyBudget: number | null; lifetimeBudget: number | null; startTime: string | null; spend: number | null; clicks: number | null; impressions: number | null; results: number | null; resultLabel: string; costPerResult: number | null; issues: string[]; recommendations: string[]; smart?: string[] }
interface MetaInsights { spend: number; impressions: number; clicks: number; ctr: number; cpc: number }
interface AdRow { id: string; name: string; status: string }
interface AdSetPerf { spend: number; impressions: number; clicks: number; results: number; ctr: number }
interface AdSetRow { id: string; name: string; status: string; dailyBudget: number | null; lifetimeBudget: number | null; optimization: string | null; perf?: AdSetPerf | null; ads: AdRow[] }
interface DailyRow { date: string; spend: number; impressions: number; clicks: number }

interface MetaData {
  configured: boolean;
  connected?: boolean;
  error?: string;
  accounts?: MetaAccount[];
  account?: string;
  campaigns?: MetaCampaign[];
  insights?: MetaInsights | null;
  adsCount?: number | null;
  accountAlerts?: string[];
  autoRecommendations?: boolean;
  insightsError?: string | null;
  campaignsError?: string | null;
}

const OBJ_ICONS: Record<string, typeof Users> = { Users, ShoppingBag, MousePointerClick, MessageCircle, Megaphone, Smartphone };

// Meta-style date ranges: the presets Meta's insights API accepts, plus
// this/last month and a fully custom calendar range (since → until).
interface DateRange { preset: string; since: string; until: string }
const RANGE_PRESETS: [string, string][] = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["last_7d", "Last 7 days"],
  ["last_14d", "Last 14 days"],
  ["last_28d", "Last 28 days"],
  ["last_30d", "Last 30 days"],
  ["last_90d", "Last 90 days"],
  ["maximum", "All time (maximum)"],
  ["this_month", "This month"],
  ["last_month", "Last month"],
  ["custom", "Custom range…"],
];
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function computeRange(r: DateRange): { qs: string; label: string } {
  if (r.preset === "custom") {
    if (r.since && r.until) return { qs: `&since=${r.since}&until=${r.until}`, label: `${r.since} → ${r.until}` };
    return { qs: "&preset=last_30d", label: "Last 30 days" }; // until both dates picked
  }
  if (r.preset === "this_month" || r.preset === "last_month") {
    const now = new Date();
    const first = r.preset === "this_month" ? new Date(now.getFullYear(), now.getMonth(), 1) : new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last = r.preset === "this_month" ? now : new Date(now.getFullYear(), now.getMonth(), 0);
    return { qs: `&since=${isoDay(first)}&until=${isoDay(last)}`, label: r.preset === "this_month" ? "This month" : "Last month" };
  }
  return { qs: `&preset=${r.preset || "last_30d"}`, label: RANGE_PRESETS.find(([k]) => k === r.preset)?.[1] ?? "Last 30 days" };
}

const money = (n: number, cur = "USD") => `${cur === "USD" ? "$" : `${cur} `}${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const statusTone = (s: string): "green" | "amber" | "gray" | "red" =>
  /ACTIVE/i.test(s) ? "green" : /PAUSED/i.test(s) ? "amber" : /DELET|DISABLE|ARCHIV/i.test(s) ? "red" : "gray";
const isActive = (s: string) => /ACTIVE/i.test(s);
const isPaused = (s: string) => /PAUSED/i.test(s);
const objLabel = (o: string) => o.replaceAll("OUTCOME_", "").replaceAll("_", " ").toLowerCase();

export default function MetaAdsPage() {
  const [data, setData] = useState<MetaData | null>(null);
  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState<string>("");
  const [ws, setWs] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "active" | "paused">("all");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [editCampaign, setEditCampaign] = useState<MetaCampaign | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<MetaCampaign | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [range, setRange] = useState<DateRange>({ preset: "last_30d", since: "", until: "" });
  const { qs: rangeQs, label: rangeLabel } = computeRange(range);
  const accountRef = useRef("");
  useEffect(() => { accountRef.current = account; }, [account]);

  const fetchData = useCallback((acct?: string) => {
    getWorkspaceId()
      .then((w) => { setWs(w); return fetch(`/api/hyperfx/meta?ws=${w ?? ""}${acct ? `&account=${encodeURIComponent(acct)}` : ""}${rangeQs}`); })
      .then((r) => r.json())
      .then((d) => { setData(d); if (d.account) setAccount(d.account); })
      .catch((e) => setData({ configured: true, connected: false, error: e instanceof Error ? e.message : "Request failed" }))
      .finally(() => setLoading(false));
  }, [rangeQs]);
  const load = useCallback((acct?: string) => { setLoading(true); fetchData(acct); }, [fetchData]);
  // Initial load + refetch whenever the date range changes (keeps the account;
  // no sync setState here — `loading` already starts true for the first load).
  useEffect(() => { fetchData(accountRef.current || undefined); }, [fetchData]);

  const cur = data?.accounts?.find((a) => a.id === account)?.currency ?? "USD";

  // Active first (Meta-style default), then paused, then the rest.
  const campaigns = useMemo(() => {
    const list = [...(data?.campaigns ?? [])];
    const rank = (s: string) => (isActive(s) ? 0 : isPaused(s) ? 1 : 2);
    list.sort((a, b) => rank(a.status) - rank(b.status) || a.name.localeCompare(b.name));
    if (filter === "active") return list.filter((c) => isActive(c.status));
    if (filter === "paused") return list.filter((c) => isPaused(c.status));
    return list;
  }, [data?.campaigns, filter]);
  const counts = useMemo(() => ({
    all: data?.campaigns?.length ?? 0,
    active: (data?.campaigns ?? []).filter((c) => isActive(c.status)).length,
    paused: (data?.campaigns ?? []).filter((c) => isPaused(c.status)).length,
  }), [data?.campaigns]);
  // Account-wide results total (conversions/leads/messages…), labeled by the
  // most common result type among campaigns that actually delivered.
  const resultsTotal = useMemo(() => {
    const list = data?.campaigns ?? [];
    const value = list.reduce((s, c) => s + (c.results ?? 0), 0);
    const tally = new Map<string, number>();
    for (const c of list) if ((c.results ?? 0) > 0) tally.set(c.resultLabel, (tally.get(c.resultLabel) ?? 0) + c.results!);
    const label = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Results";
    return { value, label };
  }, [data?.campaigns]);

  async function manage(action: string, params: Record<string, unknown>, okMsg: string) {
    const res = await fetch("/api/hyperfx/meta/manage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ws, action, ...params }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { toast(d.error ?? "Action failed", "info"); return false; }
    toast(okMsg, "success");
    return true;
  }

  async function toggleStatus(c: MetaCampaign) {
    setBusyId(c.id);
    const next = isActive(c.status) ? "PAUSED" : "ACTIVE";
    if (await manage("update_campaign", { campaign_id: c.id, status: next }, next === "PAUSED" ? "Campaign paused." : "Campaign is live.")) fetchData(account);
    setBusyId(null);
  }
  async function duplicate(c: MetaCampaign) {
    setMenuFor(null);
    setBusyId(c.id);
    if (await manage("create_campaign", { account_id: account, name: `${c.name} (copy)`, objective: c.objective, daily_budget: c.dailyBudget ?? undefined, status: "PAUSED" }, "Duplicated — the copy is PAUSED until you activate it.")) fetchData(account);
    setBusyId(null);
  }
  async function remove(c: MetaCampaign) {
    setMenuFor(null);
    if (!confirm(`Delete campaign "${c.name}"? This deletes it on Meta and can't be undone.`)) return;
    setBusyId(c.id);
    if (await manage("delete_campaign", { campaign_id: c.id }, "Campaign deleted.")) fetchData(account);
    setBusyId(null);
  }

  return (
    <div className="space-y-6">
      {createOpen && (
        <CreateCampaignWizard
          currency={cur}
          ws={ws}
          onClose={() => setCreateOpen(false)}
          onCreate={async (payload) => {
            const res = await fetch("/api/hyperfx/meta/manage", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ws, action: "create_campaign_advanced", account_id: account, ...payload }),
            });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) { toast(d.error ?? "Campaign creation failed", "info"); return false; }
            toast(d.summary ?? "Campaign created.", "success");
            setCreateOpen(false);
            fetchData(account);
            return true;
          }}
        />
      )}
      {editCampaign && (
        <CampaignModal
          title={`Edit — ${editCampaign.name}`}
          edit
          initial={{ name: editCampaign.name, objective: editCampaign.objective, dailyBudget: editCampaign.dailyBudget ?? 0, status: isActive(editCampaign.status) ? "ACTIVE" : "PAUSED" }}
          currency={cur}
          onClose={() => setEditCampaign(null)}
          onSave={async (v) => {
            const ok = await manage("update_campaign", { campaign_id: editCampaign.id, name: v.name, status: v.status, daily_budget: v.dailyBudget || undefined }, "Campaign updated.");
            if (ok) { setEditCampaign(null); fetchData(account); }
          }}
        />
      )}
      {detail && ws && <CampaignDrawer campaign={detail} ws={ws} account={account} currency={cur} rangeQs={rangeQs} rangeLabel={rangeLabel} onClose={() => setDetail(null)} onChanged={() => fetchData(account)} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-xl font-bold text-ink-900">
            <Megaphone className="h-5 w-5 text-brand-500" /> Meta Ads
          </h1>
          <p className="text-sm text-ink-500">Your live Meta campaigns — view, edit, duplicate, create. Click a campaign for its full overview.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-2 py-1">
            <CalendarDays className="h-4 w-4 shrink-0 text-ink-400" />
            <select
              value={range.preset}
              onChange={(e) => setRange((r) => ({ ...r, preset: e.target.value }))}
              className="bg-transparent py-0.5 text-sm text-ink-700 outline-none"
              title="Date range"
            >
              {RANGE_PRESETS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
            {range.preset === "custom" && (
              <>
                <input type="date" value={range.since} max={range.until || undefined} onChange={(e) => setRange((r) => ({ ...r, since: e.target.value }))} className="rounded border border-ink-200 bg-surface px-1.5 py-0.5 text-xs text-ink-700 outline-none" title="From" />
                <span className="text-xs text-ink-400">→</span>
                <input type="date" value={range.until} min={range.since || undefined} onChange={(e) => setRange((r) => ({ ...r, until: e.target.value }))} className="rounded border border-ink-200 bg-surface px-1.5 py-0.5 text-xs text-ink-700 outline-none" title="To" />
              </>
            )}
          </div>
          {(data?.accounts?.length ?? 0) > 1 && (
            <select value={account} onChange={(e) => { setAccount(e.target.value); load(e.target.value); }} className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-sm text-ink-700 outline-none" title="Ad account">
              {data!.accounts!.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
          {data?.connected && (
            <button
              onClick={async () => {
                const next = !data.autoRecommendations;
                if (await manage("set_auto_recommendations", { enabled: next }, next ? "Auto-recommendations ON — Meta's creative suggestions are handled by Helena automatically." : "Auto-recommendations off — you'll still see alerts in the table.")) fetchData(account);
              }}
              title="When ON, Meta's creative-fatigue recommendations are sent to Helena automatically: she generates a fresh creative and prepares a paused replacement ad for your review."
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium ${data.autoRecommendations ? "border-emerald-500 bg-emerald-500/10 text-emerald-600" : "border-ink-200 text-ink-700 hover:bg-ink-50"}`}
            >
              <Lightbulb className="h-4 w-4" /> Auto-recommendations
              <span className={`relative ml-0.5 h-4 w-7 rounded-full transition-colors ${data.autoRecommendations ? "bg-emerald-500" : "bg-ink-200"}`}>
                <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${data.autoRecommendations ? "left-3.5" : "left-0.5"}`} />
              </span>
            </button>
          )}
          <button onClick={() => load(account || undefined)} className="flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
          {data?.connected && (
            <button onClick={() => setCreateOpen(true)} className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700">
              <Plus className="h-4 w-4" /> New campaign
            </button>
          )}
        </div>
      </div>

      {/* All ad platforms at a glance — connection + last-30-day spend. */}
      <AdsStatusRow ws={ws} />

      {loading && !data && <Card className="p-10 text-center text-sm text-ink-400">Loading Meta ads…</Card>}

      {data && (!data.configured || data.connected === false) && (
        <Card className="p-8">
          <p className="flex items-center gap-2 font-semibold text-ink-900"><Plug className="h-5 w-5 text-amber-500" /> Meta Ads isn&apos;t connected yet</p>
          <p className="mt-2 max-w-2xl text-sm text-ink-600">Once the clinic&apos;s Meta account is connected, this page fills itself with live accounts and campaigns.</p>
          {data.error && <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">{data.error}</p>}
          <a href="/dashboard/settings?tab=connections" className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
            Open Connections <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </Card>
      )}

      {data && data.configured && data.connected && (
        <>
          {data.insights && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              {[
                [DollarSign, `Spend — ${rangeLabel}`, money(data.insights.spend, cur)],
                [Users, resultsTotal.label, resultsTotal.value.toLocaleString()],
                [Eye, "Impressions", data.insights.impressions.toLocaleString()],
                [MousePointerClick, "Clicks", data.insights.clicks.toLocaleString()],
                [Percent, "CTR / CPC", `${data.insights.ctr.toFixed(2)}% · ${money(data.insights.cpc, cur)}`],
                [Megaphone, "Campaigns / ads", `${counts.active} active${data.adsCount != null ? ` · ${data.adsCount} ads` : ` of ${counts.all}`}`],
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

          {(data.accountAlerts?.length ?? 0) > 0 && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-700"><Lightbulb className="h-3.5 w-3.5" /> Meta recommendations for this account</p>
              <ul className="mt-1.5 space-y-1 text-sm text-amber-800">
                {data.accountAlerts!.map((a, i) => <li key={i}>• {a}</li>)}
              </ul>
            </div>
          )}

          {data.insightsError && (
            <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-700">
              Performance data unavailable for this range: {data.insightsError}
            </p>
          )}
          <Card className="overflow-visible">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200 px-5 py-4">
              <div>
                <h2 className="font-semibold text-ink-900">Campaigns</h2>
                <p className="text-sm text-ink-500">Active campaigns first. Click one to see its budget, graph, ad sets and ads.</p>
              </div>
              <div className="flex rounded-xl border border-ink-200 bg-ink-50/50 p-1">
                {([["all", `All (${counts.all})`], ["active", `Active (${counts.active})`], ["paused", `Paused (${counts.paused})`]] as const).map(([k, label]) => (
                  <button key={k} onClick={() => setFilter(k)} className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${filter === k ? "bg-surface text-ink-900 shadow-sm" : "text-ink-500 hover:text-ink-800"}`}>{label}</button>
                ))}
              </div>
            </div>
            {campaigns.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-ink-400">No {filter === "all" ? "" : filter + " "}campaigns on this ad account.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1080px] text-left text-sm">
                  <thead className="border-b border-ink-200 bg-ink-50 text-xs font-semibold uppercase tracking-wide text-ink-500">
                    <tr>
                      <th className="px-5 py-2.5">Campaign</th>
                      <th className="px-4 py-2.5">Status</th>
                      <th className="px-4 py-2.5">Alerts</th>
                      <th className="px-4 py-2.5 text-right">Results</th>
                      <th className="px-4 py-2.5 text-right">Cost / result</th>
                      <th className="px-4 py-2.5 text-right">Spend ({rangeLabel})</th>
                      <th className="px-4 py-2.5 text-right">Impressions</th>
                      <th className="px-4 py-2.5 text-right">Clicks</th>
                      <th className="px-4 py-2.5 text-right">Budget</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.map((c) => (
                      <tr key={c.id} className={`border-b border-ink-100 last:border-0 hover:bg-ink-50/60 ${busyId === c.id ? "opacity-50" : ""}`}>
                        <td className="px-5 py-3">
                          <button onClick={() => setDetail(c)} className="font-medium text-ink-900 hover:text-brand-600">{c.name}</button>
                        </td>
                        <td className="px-4 py-3"><StatusBadge status={c.status} tone={statusTone(c.status)} /></td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            {c.issues.length > 0 && (
                              <span title={c.issues.join("\n")} className="cursor-help text-rose-500"><AlertTriangle className="h-4 w-4" /></span>
                            )}
                            {(c.recommendations.length > 0 || (c.smart?.length ?? 0) > 0) && (
                              <span title={[...c.recommendations, ...(c.smart ?? [])].join("\n")} className="cursor-help text-amber-500"><Lightbulb className="h-4 w-4" /></span>
                            )}
                            {c.issues.length === 0 && c.recommendations.length === 0 && (c.smart?.length ?? 0) === 0 && <span className="text-xs text-ink-300">—</span>}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className="font-medium text-ink-900">{c.results != null ? c.results.toLocaleString() : "—"}</span>
                          <span className="block text-[10px] text-ink-400">{c.resultLabel}</span>
                        </td>
                        <td className="px-4 py-3 text-right text-ink-700">{c.costPerResult != null ? money(c.costPerResult, cur) : "—"}</td>
                        <td className="px-4 py-3 text-right font-medium text-ink-900">{c.spend != null ? money(c.spend, cur) : "—"}</td>
                        <td className="px-4 py-3 text-right text-ink-700">{c.impressions != null ? c.impressions.toLocaleString() : "—"}</td>
                        <td className="px-4 py-3 text-right text-ink-700">{c.clicks != null ? c.clicks.toLocaleString() : "—"}</td>
                        <td className="px-4 py-3 text-right text-ink-700">{c.dailyBudget != null ? `${money(c.dailyBudget, cur)}/day` : c.lifetimeBudget != null ? `${money(c.lifetimeBudget, cur)} lifetime` : <span className="text-ink-400" title="Budget is set on the ad sets">on ad sets</span>}</td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <button onClick={() => toggleStatus(c)} disabled={busyId === c.id} title={isActive(c.status) ? "Pause" : "Activate"} className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700">
                              {isActive(c.status) ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                            </button>
                            <div className="relative">
                              <button onClick={() => setMenuFor((v) => (v === c.id ? null : c.id))} className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700" title="More actions">
                                <MoreVertical className="h-4 w-4" />
                              </button>
                              {menuFor === c.id && (
                                <>
                                  <div className="fixed inset-0 z-10" onClick={() => setMenuFor(null)} />
                                  <div className="absolute right-0 z-20 mt-1 w-40 rounded-xl border border-ink-200 bg-surface py-1 shadow-lg">
                                    <button onClick={() => { setMenuFor(null); setEditCampaign(c); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-700 hover:bg-ink-50"><Pencil className="h-3.5 w-3.5 text-ink-400" /> Edit</button>
                                    <button onClick={() => duplicate(c)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-700 hover:bg-ink-50"><Copy className="h-3.5 w-3.5 text-ink-400" /> Duplicate</button>
                                    <button onClick={() => remove(c)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-rose-600 hover:bg-rose-500/10"><Trash2 className="h-3.5 w-3.5" /> Delete</button>
                                  </div>
                                </>
                              )}
                            </div>
                          </div>
                        </td>
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

// ------------------------------------------------------------ create / edit
function CampaignModal({ title, initial, currency, edit, onClose, onSave }: {
  title: string;
  initial: { name: string; objective: string; dailyBudget: number; status: "ACTIVE" | "PAUSED" };
  currency: string;
  edit?: boolean;
  onClose: () => void;
  onSave: (v: { name: string; objective: string; dailyBudget: number; status: "ACTIVE" | "PAUSED" }) => Promise<void>;
}) {
  const [name, setName] = useState(initial.name);
  const [objective, setObjective] = useState(initial.objective);
  const [dailyBudget, setDailyBudget] = useState(initial.dailyBudget);
  const [status, setStatus] = useState<"ACTIVE" | "PAUSED">(initial.status);
  const [saving, setSaving] = useState(false);
  return (
    <Modal open onClose={onClose} title={title} subtitle={edit ? "Changes apply on Meta immediately." : "New campaigns start PAUSED unless you choose Live — nothing spends without your say-so."}>
      <div className="space-y-4">
        <Field label="Campaign name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Spring whitening promo" /></Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Objective">
            <select className={inputCls} value={objective} onChange={(e) => setObjective(e.target.value)} disabled={edit}>
              {[...new Set([initial.objective, ...META_OBJECTIVES.map((o) => o.key)])].filter(Boolean).map((o) => <option key={o} value={o}>{objLabel(o)}</option>)}
            </select>
          </Field>
          <Field label={`Daily budget (${currency})`}>
            <input type="number" min={0} step="0.01" className={inputCls} value={dailyBudget || ""} onChange={(e) => setDailyBudget(Number(e.target.value) || 0)} placeholder="10" />
          </Field>
        </div>
        <Field label="Status">
          <div className="flex gap-2">
            {(["PAUSED", "ACTIVE"] as const).map((s) => (
              <button key={s} onClick={() => setStatus(s)} className={`flex-1 rounded-xl border px-3 py-2 text-sm font-medium ${status === s ? (s === "ACTIVE" ? "border-emerald-500 bg-emerald-500/10 text-emerald-600" : "border-amber-500 bg-amber-500/10 text-amber-600") : "border-ink-200 text-ink-500 hover:bg-ink-50"}`}>
                {s === "ACTIVE" ? "Live (spending)" : "Paused"}
              </button>
            ))}
          </div>
        </Field>
      </div>
      <ModalFooter onClose={onClose} submitLabel={saving ? "Saving…" : edit ? "Save changes" : status === "ACTIVE" ? "Create & go live" : "Create (paused)"} onSubmit={async () => {
        if (!name.trim()) { toast("Give the campaign a name.", "info"); return; }
        setSaving(true);
        await onSave({ name: name.trim(), objective, dailyBudget, status });
        setSaving(false);
      }} />
    </Modal>
  );
}

// ------------------------------------------------------------ detail drawer
function CampaignDrawer({ campaign, ws, account, currency, rangeQs, rangeLabel, onClose, onChanged }: {
  campaign: MetaCampaign;
  ws: string;
  account: string;
  currency: string;
  rangeQs: string;
  rangeLabel: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [adsets, setAdsets] = useState<AdSetRow[] | null>(null);
  const [daily, setDaily] = useState<DailyRow[]>([]);
  const [totals, setTotals] = useState<MetaInsights | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openSet, setOpenSet] = useState<string | null>(null);
  const [busySet, setBusySet] = useState<string | null>(null);

  // Which ad set is performing best: share of results (fallback: clicks) each
  // set contributes, so the drawer can rank them like Meta's breakdown view.
  const perfShares = useMemo(() => {
    const withPerf = (adsets ?? []).filter((s) => s.perf);
    const totalResults = withPerf.reduce((t, s) => t + (s.perf!.results || 0), 0);
    const totalClicks = withPerf.reduce((t, s) => t + (s.perf!.clicks || 0), 0);
    const basis = totalResults > 0 ? "results" : totalClicks > 0 ? "clicks" : null;
    const share = new Map<string, number>();
    if (basis) {
      const total = basis === "results" ? totalResults : totalClicks;
      for (const s of withPerf) share.set(s.id, (((basis === "results" ? s.perf!.results : s.perf!.clicks) || 0) / total) * 100);
    }
    let bestId: string | null = null, bestV = 0;
    for (const [id, v] of share) if (v > bestV) { bestV = v; bestId = id; }
    return { share, bestId, basis };
  }, [adsets]);

  const load = useCallback(() => {
    fetch(`/api/hyperfx/meta/campaign?ws=${ws}&id=${encodeURIComponent(campaign.id)}&account=${encodeURIComponent(account)}${rangeQs}`)
      .then((r) => r.json())
      .then((d) => {
        setAdsets(d.adsets ?? []);
        setDaily(d.daily ?? []);
        setTotals(d.totals ?? null);
        setErr(d.adsetsError || d.insightsError || null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Failed to load"));
  }, [ws, campaign.id, account, rangeQs]);
  useEffect(() => { load(); }, [load]);

  async function adsetAction(action: string, params: Record<string, unknown>, okMsg: string, id: string) {
    setBusySet(id);
    const res = await fetch("/api/hyperfx/meta/manage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ws, action, ...params }) });
    const d = await res.json().catch(() => ({}));
    setBusySet(null);
    if (!res.ok) { toast(d.error ?? "Action failed", "info"); return; }
    toast(okMsg, "success");
    load();
    onChanged();
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-2xl flex-col overflow-y-auto bg-surface shadow-2xl">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-ink-200 bg-surface px-6 py-4">
          <div>
            <p className="flex items-center gap-2 font-semibold text-ink-900">{campaign.name} <StatusBadge status={campaign.status} tone={statusTone(campaign.status)} /></p>
            <p className="text-xs text-ink-400">{objLabel(campaign.objective)} · {campaign.dailyBudget != null ? `${money(campaign.dailyBudget, currency)}/day` : "budget on ad sets"}{campaign.startTime ? ` · started ${campaign.startTime.slice(0, 10)}` : ""}</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100"><X className="h-5 w-5" /></button>
        </div>

        <div className="space-y-5 p-6">
          {(campaign.issues.length > 0 || campaign.recommendations.length > 0 || (campaign.smart?.length ?? 0) > 0) && (
            <div className="space-y-2">
              {campaign.issues.length > 0 && (
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3">
                  <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-rose-600"><AlertTriangle className="h-3.5 w-3.5" /> Issues</p>
                  <ul className="mt-1 space-y-1 text-sm text-rose-700">{campaign.issues.map((t, i) => <li key={i}>• {t}</li>)}</ul>
                </div>
              )}
              {campaign.recommendations.length > 0 && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                  <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-700"><Lightbulb className="h-3.5 w-3.5" /> Meta&apos;s recommendations</p>
                  <ul className="mt-1 space-y-1 text-sm text-amber-800">{campaign.recommendations.map((t, i) => <li key={i}>• {t}</li>)}</ul>
                </div>
              )}
              {(campaign.smart?.length ?? 0) > 0 && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                  <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-700"><Lightbulb className="h-3.5 w-3.5" /> Recommendations — from this range&apos;s performance</p>
                  <ul className="mt-1 space-y-1 text-sm text-amber-800">{campaign.smart!.map((t, i) => <li key={i}>• {t}</li>)}</ul>
                </div>
              )}
            </div>
          )}
          {totals && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                [`Spend — ${rangeLabel}`, money(totals.spend, currency)],
                ["Impressions", totals.impressions.toLocaleString()],
                ["Clicks", totals.clicks.toLocaleString()],
                ["CTR / CPC", `${totals.ctr.toFixed(2)}% · ${money(totals.cpc, currency)}`],
              ].map(([label, value], i) => (
                <div key={i} className="rounded-xl border border-ink-100 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{label}</p>
                  <p className="mt-0.5 text-base font-bold text-ink-900">{value}</p>
                </div>
              ))}
            </div>
          )}

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Daily spend — {rangeLabel}</p>
            {daily.length > 1 ? (
              <SpendChart daily={daily} currency={currency} />
            ) : (
              <p className="rounded-xl border border-ink-100 px-4 py-6 text-center text-sm text-ink-400">{adsets === null ? "Loading…" : "No delivery in this date range."}</p>
            )}
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Ad sets {adsets ? `(${adsets.length})` : ""}</p>
            {adsets === null ? (
              <p className="text-sm text-ink-400">Loading ad sets…</p>
            ) : adsets.length === 0 ? (
              <p className="rounded-xl border border-ink-100 px-4 py-6 text-center text-sm text-ink-400">No ad sets in this campaign yet.</p>
            ) : (
              <div className="space-y-2">
                {adsets.map((s) => (
                  <div key={s.id} className={`rounded-xl border border-ink-200 ${busySet === s.id ? "opacity-50" : ""}`}>
                    <div className="flex items-center gap-2 px-3.5 py-2.5">
                      <button onClick={() => setOpenSet((v) => (v === s.id ? null : s.id))} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                        {openSet === s.id ? <ChevronDown className="h-4 w-4 shrink-0 text-ink-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-ink-400" />}
                        <span className="truncate text-sm font-medium text-ink-900">{s.name}</span>
                        <StatusBadge status={s.status} tone={statusTone(s.status)} />
                        {perfShares.bestId === s.id && (
                          <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600">Top performer</span>
                        )}
                      </button>
                      <span className="shrink-0 text-xs text-ink-500">{s.dailyBudget != null ? `${money(s.dailyBudget, currency)}/day` : s.lifetimeBudget != null ? `${money(s.lifetimeBudget, currency)} lifetime` : "—"}</span>
                      <button
                        onClick={() => adsetAction("update_ad_set", { ad_set_id: s.id, status: isActive(s.status) ? "PAUSED" : "ACTIVE" }, isActive(s.status) ? "Ad set paused." : "Ad set live.", s.id)}
                        title={isActive(s.status) ? "Pause ad set" : "Activate ad set"}
                        className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
                      >
                        {isActive(s.status) ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        onClick={() => {
                          const v = prompt(`New daily budget for "${s.name}" (${currency}):`, s.dailyBudget != null ? String(s.dailyBudget) : "10");
                          if (v && Number(v) > 0) adsetAction("update_ad_set", { ad_set_id: s.id, daily_budget: Number(v) }, "Ad set budget updated.", s.id);
                        }}
                        title="Edit daily budget"
                        className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => { if (confirm(`Delete ad set "${s.name}"? This deletes it on Meta.`)) adsetAction("delete_ad_set", { ad_set_id: s.id }, "Ad set deleted.", s.id); }}
                        title="Delete ad set"
                        className="rounded-lg p-1.5 text-ink-400 hover:bg-rose-500/10 hover:text-rose-500"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {s.perf && (
                      <div className="flex flex-wrap items-center gap-2 px-3.5 pb-2.5 text-xs text-ink-500">
                        <span>
                          {money(s.perf.spend, currency)} · {s.perf.impressions.toLocaleString()} impr · {s.perf.clicks.toLocaleString()} clicks · CTR {s.perf.ctr.toFixed(2)}%
                          {s.perf.results > 0 ? ` · ${s.perf.results.toLocaleString()} results` : ""}
                        </span>
                        {perfShares.share.has(s.id) && (
                          <span className="ml-auto flex items-center gap-1.5" title={`Share of campaign ${perfShares.basis}`}>
                            <span className="h-1.5 w-20 overflow-hidden rounded-full bg-ink-100">
                              <span className="block h-full rounded-full bg-brand-500" style={{ width: `${Math.min(100, perfShares.share.get(s.id)!)}%` }} />
                            </span>
                            <span className="font-semibold text-ink-700">{perfShares.share.get(s.id)!.toFixed(0)}%</span>
                          </span>
                        )}
                      </div>
                    )}
                    {openSet === s.id && (
                      <div className="border-t border-ink-100 px-3.5 py-2">
                        {s.optimization && <p className="mb-1.5 text-[11px] text-ink-400">Optimisation: {s.optimization.replaceAll("_", " ").toLowerCase()}</p>}
                        {s.ads.length === 0 ? (
                          <p className="py-2 text-xs text-ink-400">No ads in this ad set.</p>
                        ) : (
                          <ul className="divide-y divide-ink-100">
                            {s.ads.map((a) => (
                              <AdRowItem key={a.id} ad={a} ws={ws} onToggle={(next) => adsetAction("update_ad", { ad_id: a.id, status: next }, next === "PAUSED" ? "Ad paused." : "Ad live.", s.id)} />
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {err && <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">{err}</p>}
        </div>
      </div>
    </div>
  );
}

// One ad inside the drawer: status toggle + Meta-rendered creative preview.
function AdRowItem({ ad, ws, onToggle }: { ad: AdRow; ws: string; onToggle: (next: string) => void }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<{ iframeSrc?: string | null; title?: string; body?: string; error?: string } | null>(null);

  function togglePreview() {
    const next = !open;
    setOpen(next);
    if (next && !preview) {
      fetch(`/api/hyperfx/meta/adpreview?ws=${ws}&ad=${encodeURIComponent(ad.id)}`)
        .then((r) => r.json())
        .then(setPreview)
        .catch((e) => setPreview({ error: e instanceof Error ? e.message : "Preview failed" }));
    }
  }

  const active = /ACTIVE/i.test(ad.status);
  return (
    <li className="py-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-ink-800">{ad.name}</span>
        <StatusBadge status={ad.status} tone={statusTone(ad.status)} />
        <button onClick={() => onToggle(active ? "PAUSED" : "ACTIVE")} title={active ? "Pause ad" : "Activate ad"} className="rounded-lg p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700">
          {active ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        <button onClick={togglePreview} title="Preview the creative" className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium ${open ? "border-brand-400 text-brand-600" : "border-ink-200 text-ink-500 hover:bg-ink-50"}`}>
          <ImageIcon className="h-3 w-3" /> Preview
        </button>
      </div>
      {open && (
        <div className="mt-2 rounded-xl border border-ink-100 bg-ink-50/50 p-2.5">
          {!preview ? (
            <p className="py-4 text-center text-xs text-ink-400">Loading preview from Meta…</p>
          ) : preview.error && !preview.iframeSrc ? (
            <p className="text-xs text-amber-600">{preview.error}</p>
          ) : (
            <>
              {(preview.title || preview.body) && (
                <div className="mb-2 text-xs">
                  {preview.title && <p className="font-semibold text-ink-900">{preview.title}</p>}
                  {preview.body && <p className="whitespace-pre-wrap text-ink-600">{preview.body}</p>}
                </div>
              )}
              {preview.iframeSrc ? (
                <iframe src={preview.iframeSrc} className="h-[560px] w-full max-w-[520px] rounded-lg border border-ink-200 bg-white" title={`Preview — ${ad.name}`} />
              ) : (
                <p className="text-xs text-ink-400">Meta returned no visual preview for this format.</p>
              )}
              <p className="mt-1.5 text-[10px] text-ink-400">To change this creative, ask Helena in AI Marketing (e.g. “make a new creative for the ad ‘{ad.name}’”) — she generates the image and updates the ad after your approval.</p>
            </>
          )}
        </div>
      )}
    </li>
  );
}

// ------------------------------------------------------------ daily spend chart
// Single-series line (2px) with area, recessive gridlines, crosshair + tooltip on
// hover. Text uses ink tokens; the line uses the brand hue via currentColor so it
// adapts to light/dark.
function SpendChart({ daily, currency }: { daily: DailyRow[]; currency: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = 180, PAD_L = 8, PAD_R = 8, PAD_T = 12, PAD_B = 22;
  const max = Math.max(...daily.map((d) => d.spend), 0.01);
  const x = (i: number) => PAD_L + (i / (daily.length - 1)) * (W - PAD_L - PAD_R);
  const y = (v: number) => PAD_T + (1 - v / max) * (H - PAD_T - PAD_B);
  const line = daily.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d.spend).toFixed(1)}`).join(" ");
  const area = `${line} L${x(daily.length - 1).toFixed(1)},${H - PAD_B} L${x(0).toFixed(1)},${H - PAD_B} Z`;
  const maxIdx = daily.reduce((mi, d, i) => (d.spend > daily[mi].spend ? i : mi), 0);

  function onMove(e: React.MouseEvent) {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD_L) / (W - PAD_L - PAD_R)) * (daily.length - 1));
    setHover(Math.max(0, Math.min(daily.length - 1, i)));
  }

  const h = hover != null ? daily[hover] : null;
  return (
    <div ref={ref} className="relative" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full text-brand-600 dark:text-brand-300" role="img" aria-label="Daily spend for the selected date range">
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={PAD_L} x2={W - PAD_R} y1={PAD_T + f * (H - PAD_T - PAD_B)} y2={PAD_T + f * (H - PAD_T - PAD_B)} className="stroke-ink-100" strokeWidth="1" />
        ))}
        <line x1={PAD_L} x2={W - PAD_R} y1={H - PAD_B} y2={H - PAD_B} className="stroke-ink-200" strokeWidth="1" />
        <path d={area} fill="currentColor" opacity="0.08" />
        <path d={line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {/* direct label on the peak day only */}
        <circle cx={x(maxIdx)} cy={y(daily[maxIdx].spend)} r="3" fill="currentColor" />
        <text x={x(maxIdx)} y={y(daily[maxIdx].spend) - 6} textAnchor="middle" className="fill-ink-500" fontSize="10">{money(daily[maxIdx].spend, currency)}</text>
        {/* x labels: first + last date */}
        <text x={PAD_L} y={H - 6} className="fill-ink-400" fontSize="10">{daily[0].date.slice(5)}</text>
        <text x={W - PAD_R} y={H - 6} textAnchor="end" className="fill-ink-400" fontSize="10">{daily[daily.length - 1].date.slice(5)}</text>
        {h && hover != null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={H - PAD_B} className="stroke-ink-300" strokeWidth="1" strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(h.spend)} r="4" fill="currentColor" className="stroke-surface" strokeWidth="2" />
          </>
        )}
      </svg>
      {h && hover != null && (
        <div className="pointer-events-none absolute -top-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs shadow-lg" style={{ left: `${(x(hover) / W) * 100}%`, transform: `translateX(${hover > daily.length / 2 ? "-105%" : "5%"})` }}>
          <p className="font-semibold text-ink-900">{h.date}</p>
          <p className="text-ink-600">{money(h.spend, currency)} · {h.clicks} clicks · {h.impressions.toLocaleString()} impr.</p>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------- create-campaign wizard
// Step 1: Meta objectives as selectable boxes (icon, description, "good for" on
// hover). Step 2: 3–6 named Pydent STRATEGIES for that objective — pre-made
// audience/age/interest recipes with an ad-set plan. Step 3: name, location,
// number of ad sets, budget per ad set, live/paused — then everything is created
// on Meta automatically (ad sets paused; creatives come next via Helena).
interface WizardAd { name: string; primaryText: string; headline: string; description: string; imageUrl: string }
interface WizardAdSet { name: string; ageMin: number; ageMax: number; interests: string; budget: number; ads: WizardAd[] }
interface GeoArea { key: string; name: string; type: string; region?: string | null; supportsRadius?: boolean; radius?: number }

const blankAd = (n: number): WizardAd => ({ name: `Ad ${n}`, primaryText: "", headline: "", description: "", imageUrl: "" });
const STEPS = ["Objective", "Strategy", "Conversion & budget", "Locations", "Ad sets & ads", "Review"];

function CreateCampaignWizard({ currency, ws, onClose, onCreate }: {
  currency: string;
  ws: string | null;
  onClose: () => void;
  onCreate: (payload: Record<string, unknown>) => Promise<boolean>;
}) {
  const [step, setStep] = useState(1);
  const [objective, setObjective] = useState<string>("");
  const [strategy, setStrategy] = useState<MetaStrategy | null>(null);
  const [name, setName] = useState("");
  // conversion + budget
  const [conversion, setConversion] = useState("");
  const [messagingApp, setMessagingApp] = useState("whatsapp");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [budgetMode, setBudgetMode] = useState<"CBO" | "ABO">("ABO");
  const [budgetType, setBudgetType] = useState<"daily" | "lifetime">("daily");
  const [budget, setBudget] = useState(15);
  const [endDate, setEndDate] = useState("");
  const [placements, setPlacements] = useState<string[]>(["facebook", "instagram"]);
  // locations
  const [geoIncluded, setGeoIncluded] = useState<GeoArea[]>([]);
  const [geoExcluded, setGeoExcluded] = useState<GeoArea[]>([]);
  const [geoQuery, setGeoQuery] = useState("");
  const [geoResults, setGeoResults] = useState<GeoArea[]>([]);
  const [geoSearching, setGeoSearching] = useState(false);
  // ad sets
  const [adSets, setAdSets] = useState<WizardAdSet[]>([]);
  const [status, setStatus] = useState<"ACTIVE" | "PAUSED">("PAUSED");
  const [creating, setCreating] = useState(false);

  const strategies = objective ? strategiesFor(objective) : [];
  const selObj = META_OBJECTIVES.find((o) => o.key === objective);
  const conversions = objective ? conversionsFor(objective) : [];
  const selConv = conversions.find((c) => c.id === conversion);

  // Apply a strategy: prefill name, ad sets (name/age/interests/budget) and ads.
  function applyStrategy(st: MetaStrategy | null) {
    setStrategy(st);
    if (st) {
      setName(st.name);
      setBudget(st.suggestedDailyBudget);
      setAdSets(st.adSets.map((a) => ({ name: a.name, ageMin: a.ageMin, ageMax: a.ageMax, interests: a.interests.join(", "), budget: st.suggestedDailyBudget, ads: [blankAd(1)] })));
    } else {
      setName("");
      setAdSets([{ name: "Ad set 1", ageMin: 22, ageMax: 55, interests: "", budget: 15, ads: [blankAd(1)] }]);
    }
  }

  async function searchGeo() {
    if (geoQuery.trim().length < 2) return;
    setGeoSearching(true);
    const res = await fetch(`/api/hyperfx/meta/geo?ws=${ws ?? ""}&q=${encodeURIComponent(geoQuery.trim())}`);
    const d = await res.json().catch(() => ({}));
    setGeoResults((d.results ?? []).slice(0, 15));
    setGeoSearching(false);
  }
  const addGeo = (g: GeoArea, list: "in" | "ex") => {
    const item = { ...g, radius: g.supportsRadius ? 25 : undefined };
    if (list === "in") setGeoIncluded((p) => (p.some((x) => x.key === g.key) ? p : [...p, item]));
    else setGeoExcluded((p) => (p.some((x) => x.key === g.key) ? p : [...p, item]));
    setGeoResults([]); setGeoQuery("");
  };

  const setAdSet = (i: number, patch: Partial<WizardAdSet>) => setAdSets((p) => p.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const setAd = (si: number, ai: number, patch: Partial<WizardAd>) =>
    setAdSets((p) => p.map((a, j) => (j === si ? { ...a, ads: a.ads.map((ad, k) => (k === ai ? { ...ad, ...patch } : ad)) } : a)));

  async function create() {
    if (!name.trim()) { toast("Give the campaign a name.", "info"); return; }
    setCreating(true);
    await onCreate({
      objective,
      strategy_key: strategy?.key ?? null,
      name: name.trim(),
      conversionLocation: conversion,
      messagingApp: selConv?.needsMessagingApp ? messagingApp : undefined,
      websiteUrl: selConv?.needsUrl ? websiteUrl.trim() : undefined,
      budgetMode, budgetType,
      budget,
      endDate: budgetType === "lifetime" ? endDate : undefined,
      placements,
      countryCode: "AE",
      geoIncluded: geoIncluded.map((g) => ({ key: g.key, type: g.type, radius: g.radius })),
      geoExcluded: geoExcluded.map((g) => ({ key: g.key, type: g.type })),
      adSets: adSets.map((a) => ({
        name: a.name, ageMin: a.ageMin, ageMax: a.ageMax,
        interests: a.interests.split(",").map((s) => s.trim()).filter(Boolean),
        budget: budgetMode === "ABO" ? a.budget : undefined,
        ads: a.ads.map((ad) => ({ name: ad.name, primaryText: ad.primaryText, headline: ad.headline, description: ad.description, imageUrl: ad.imageUrl, linkUrl: websiteUrl })),
      })),
      status,
    });
    setCreating(false);
  }

  const canNext =
    (step === 1 && !!objective) ||
    (step === 2 && (strategy !== null || name !== "" || adSets.length > 0)) ||
    (step === 3 && (!!conversion || conversions.length === 0) && (!selConv?.needsUrl || websiteUrl.trim() !== "")) ||
    step === 4 ||
    step === 5;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
          <div>
            <p className="font-semibold text-ink-900">{STEPS[step - 1]}</p>
            <p className="text-xs text-ink-400">
              {step === 1 ? "What should this campaign achieve?" : step === 2 ? `Pre-made ${selObj?.label ?? ""} strategies — pick one to prefill everything, or go custom.` : step === 3 ? "Where conversions happen, and how the budget works." : step === 4 ? "Pick exactly the areas to target (and any to exclude)." : step === 5 ? "Fine-tune ad sets and write the ad creatives." : "Review and create — everything is built on Meta, paused."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-ink-400">Step {step} / {STEPS.length}</span>
            <button onClick={onClose} className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100"><X className="h-5 w-5" /></button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {/* STEP 1 — objective */}
          {step === 1 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {META_OBJECTIVES.map((o) => {
                const I = OBJ_ICONS[o.icon] ?? Megaphone;
                const sel = objective === o.key;
                return (
                  <button key={o.key} onClick={() => { setObjective(o.key); applyStrategy(null); setConversion(conversionsFor(o.key)[0]?.id ?? ""); }} title={`${o.details}\n\nGood for: ${o.goodFor}`} className={`flex flex-col rounded-xl border p-4 text-left transition-colors ${sel ? "border-brand-500 bg-brand-50/60 ring-1 ring-brand-500" : "border-ink-200 hover:border-brand-300 hover:bg-ink-50"}`}>
                    <I className={`h-5 w-5 ${sel ? "text-brand-600" : "text-ink-400"}`} />
                    <p className="mt-2 text-sm font-semibold text-ink-900">{o.label}</p>
                    <p className="mt-1 text-xs leading-relaxed text-ink-500">{o.description}</p>
                    <p className="mt-2 text-[10px] font-medium uppercase tracking-wide text-ink-400">Good for</p>
                    <p className="text-[11px] text-ink-500">{o.goodFor}</p>
                  </button>
                );
              })}
            </div>
          )}

          {/* STEP 2 — strategy */}
          {step === 2 && (
            <div className="space-y-3">
              {strategies.map((st) => {
                const sel = strategy?.key === st.key;
                return (
                  <button key={st.key} onClick={() => applyStrategy(st)} className={`w-full rounded-xl border p-4 text-left transition-colors ${sel ? "border-brand-500 bg-brand-50/60 ring-1 ring-brand-500" : "border-ink-200 hover:border-brand-300 hover:bg-ink-50"}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div><p className="text-sm font-semibold text-ink-900">{st.name}</p><p className="mt-0.5 text-xs text-ink-600">{st.tagline}</p></div>
                      <span className="shrink-0 rounded-full bg-ink-100 px-2.5 py-1 text-[10px] font-medium text-ink-600">~{money(st.suggestedDailyBudget, currency)}/day per ad set</span>
                    </div>
                    <p className="mt-1.5 text-[11px] text-emerald-600">{st.projection}</p>
                    <p className="text-[11px] text-ink-400">Best for: {st.bestFor}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {st.adSets.map((a) => <span key={a.name} title={`${a.angle} · age ${a.ageMin}–${a.ageMax} · ${a.interests.join(", ")}`} className="cursor-help rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-medium text-brand-600 dark:text-brand-300">{a.name}</span>)}
                    </div>
                  </button>
                );
              })}
              <button onClick={() => applyStrategy(null)} className={`w-full rounded-xl border border-dashed p-3.5 text-left text-sm ${strategy === null ? "border-brand-400 text-brand-600" : "border-ink-300 text-ink-500 hover:border-brand-300"}`}>
                Custom — start from one blank ad set and set everything yourself
              </button>
            </div>
          )}

          {/* STEP 3 — conversion & budget */}
          {step === 3 && (
            <div className="space-y-5">
              <Field label="Campaign name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="New Patient Acquisition — July" /></Field>

              {conversions.length > 0 && (
                <div>
                  <p className="mb-2 text-sm font-medium text-ink-700">Conversion location — where do the results happen?</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {conversions.map((c) => (
                      <button key={c.id} onClick={() => setConversion(c.id)} className={`rounded-xl border p-3 text-left ${conversion === c.id ? "border-brand-500 bg-brand-50/60 ring-1 ring-brand-500" : "border-ink-200 hover:bg-ink-50"}`}>
                        <p className="text-sm font-semibold text-ink-900">{c.label}</p>
                        <p className="mt-0.5 text-[11px] leading-snug text-ink-500">{c.description}</p>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {selConv?.needsMessagingApp && (
                <Field label="Which app should the conversation open in?">
                  <div className="flex gap-2">
                    {MESSAGING_APPS.map((m) => (
                      <button key={m.id} onClick={() => setMessagingApp(m.id)} className={`flex-1 rounded-xl border px-3 py-2 text-sm font-medium ${messagingApp === m.id ? "border-brand-500 bg-brand-500/10 text-brand-600" : "border-ink-200 text-ink-500 hover:bg-ink-50"}`}>{m.label}</button>
                    ))}
                  </div>
                </Field>
              )}
              {selConv?.needsUrl && (
                <Field label="Destination URL (booking / landing page)"><input className={inputCls} value={websiteUrl} onChange={(e) => setWebsiteUrl(e.target.value)} placeholder="https://clinic.com/book" /></Field>
              )}

              <div>
                <p className="mb-2 text-sm font-medium text-ink-700">Budget setup</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <button onClick={() => setBudgetMode("CBO")} className={`rounded-xl border p-3 text-left ${budgetMode === "CBO" ? "border-brand-500 bg-brand-50/60 ring-1 ring-brand-500" : "border-ink-200 hover:bg-ink-50"}`}>
                    <p className="text-sm font-semibold text-ink-900">Campaign budget (CBO)</p>
                    <p className="mt-0.5 text-[11px] text-ink-500">One budget for the whole campaign — Meta splits it across ad sets automatically.</p>
                  </button>
                  <button onClick={() => setBudgetMode("ABO")} className={`rounded-xl border p-3 text-left ${budgetMode === "ABO" ? "border-brand-500 bg-brand-50/60 ring-1 ring-brand-500" : "border-ink-200 hover:bg-ink-50"}`}>
                    <p className="text-sm font-semibold text-ink-900">Ad set budget (ABO)</p>
                    <p className="mt-0.5 text-[11px] text-ink-500">Set the budget on each ad set yourself (in the next step).</p>
                  </button>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Budget type">
                  <div className="flex gap-2">
                    {(["daily", "lifetime"] as const).map((t) => (
                      <button key={t} onClick={() => setBudgetType(t)} className={`flex-1 rounded-xl border px-3 py-2 text-sm font-medium capitalize ${budgetType === t ? "border-brand-500 bg-brand-500/10 text-brand-600" : "border-ink-200 text-ink-500 hover:bg-ink-50"}`}>{t}</button>
                    ))}
                  </div>
                </Field>
                {budgetMode === "CBO" ? (
                  <Field label={`Campaign ${budgetType} budget (${currency})`}><input type="number" min={1} className={inputCls} value={budget || ""} onChange={(e) => setBudget(Number(e.target.value) || 0)} /></Field>
                ) : (
                  <Field label={`Default per-ad-set ${budgetType} budget (${currency})`}><input type="number" min={1} className={inputCls} value={budget || ""} onChange={(e) => setBudget(Number(e.target.value) || 0)} /></Field>
                )}
              </div>
              {budgetType === "lifetime" && (
                <Field label="End date (when the lifetime budget stops)"><input type="date" className={inputCls} value={endDate} onChange={(e) => setEndDate(e.target.value)} /></Field>
              )}

              <Field label="Placements — where the ads show">
                <div className="flex flex-wrap gap-2">
                  {PLACEMENTS.map((p) => {
                    const on = placements.includes(p.id);
                    return (
                      <button key={p.id} onClick={() => setPlacements((ps) => (on ? ps.filter((x) => x !== p.id) : [...ps, p.id]))} className={`rounded-xl border px-3 py-2 text-sm font-medium ${on ? "border-brand-500 bg-brand-500/10 text-brand-600" : "border-ink-200 text-ink-500 hover:bg-ink-50"}`}>{p.label}</button>
                    );
                  })}
                </div>
                <p className="mt-1 text-[11px] text-ink-400">Leave all on for Meta&apos;s automatic placements, or uncheck the ones you don&apos;t want.</p>
              </Field>
            </div>
          )}

          {/* STEP 4 — locations */}
          {step === 4 && (
            <div className="space-y-4">
              <Field label="Search for areas to target (city, emirate/region, or neighbourhood)">
                <div className="flex gap-2">
                  <input className={inputCls} value={geoQuery} onChange={(e) => setGeoQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); searchGeo(); } }} placeholder="Dubai, Abu Dhabi, Dubai Marina…" />
                  <button onClick={searchGeo} disabled={geoSearching} className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{geoSearching ? "…" : "Search"}</button>
                </div>
              </Field>
              {geoResults.length > 0 && (
                <div className="rounded-xl border border-ink-200 divide-y divide-ink-100">
                  {geoResults.map((g) => (
                    <div key={g.key} className="flex items-center gap-2 px-3 py-2 text-sm">
                      <span className="min-w-0 flex-1 truncate"><span className="font-medium text-ink-900">{g.name}</span> <span className="text-xs text-ink-400">· {g.type}{g.region ? ` · ${g.region}` : ""}</span></span>
                      <button onClick={() => addGeo(g, "in")} className="rounded-lg border border-emerald-500/40 px-2.5 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-500/10">Include</button>
                      <button onClick={() => addGeo(g, "ex")} className="rounded-lg border border-rose-500/40 px-2.5 py-1 text-xs font-medium text-rose-500 hover:bg-rose-500/10">Exclude</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-600">Targeting ({geoIncluded.length})</p>
                  {geoIncluded.length === 0 ? <p className="rounded-lg border border-dashed border-ink-200 px-3 py-4 text-center text-xs text-ink-400">Nothing yet — defaults to the whole country (AE).</p> : (
                    <div className="space-y-1.5">
                      {geoIncluded.map((g) => (
                        <div key={g.key} className="flex items-center gap-2 rounded-lg border border-ink-100 px-2.5 py-1.5 text-sm">
                          <span className="min-w-0 flex-1 truncate">{g.name} <span className="text-[10px] text-ink-400">{g.type}</span></span>
                          {g.supportsRadius && <input type="number" min={17} max={80} value={g.radius ?? 25} onChange={(e) => setGeoIncluded((p) => p.map((x) => (x.key === g.key ? { ...x, radius: Number(e.target.value) || 25 } : x)))} className="w-14 rounded border border-ink-200 px-1.5 py-0.5 text-xs" title="Radius km (min 17)" />}
                          <button onClick={() => setGeoIncluded((p) => p.filter((x) => x.key !== g.key))} className="text-ink-400 hover:text-rose-500"><X className="h-3.5 w-3.5" /></button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-rose-500">Excluding ({geoExcluded.length})</p>
                  {geoExcluded.length === 0 ? <p className="rounded-lg border border-dashed border-ink-200 px-3 py-4 text-center text-xs text-ink-400">No exclusions.</p> : (
                    <div className="space-y-1.5">
                      {geoExcluded.map((g) => (
                        <div key={g.key} className="flex items-center gap-2 rounded-lg border border-ink-100 px-2.5 py-1.5 text-sm">
                          <span className="min-w-0 flex-1 truncate">{g.name} <span className="text-[10px] text-ink-400">{g.type}</span></span>
                          <button onClick={() => setGeoExcluded((p) => p.filter((x) => x.key !== g.key))} className="text-ink-400 hover:text-rose-500"><X className="h-3.5 w-3.5" /></button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* STEP 5 — ad sets & ads */}
          {step === 5 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-ink-500">{adSets.length} ad set{adSets.length !== 1 ? "s" : ""}{strategy ? ` · recommended ${strategy.adSets.length}` : ""}. Each can hold multiple ad creatives.</p>
                <button onClick={() => setAdSets((p) => [...p, { name: `Ad set ${p.length + 1}`, ageMin: 22, ageMax: 55, interests: "", budget, ads: [blankAd(1)] }])} className="flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50"><Plus className="h-4 w-4" /> Add ad set</button>
              </div>
              {adSets.map((as, si) => (
                <div key={si} className="rounded-xl border border-ink-200 p-4">
                  <div className="flex items-center gap-2">
                    <input className={`${inputCls} font-medium`} value={as.name} onChange={(e) => setAdSet(si, { name: e.target.value })} placeholder={`Ad set ${si + 1} name`} />
                    {adSets.length > 1 && <button onClick={() => setAdSets((p) => p.filter((_, j) => j !== si))} className="rounded-lg p-2 text-ink-400 hover:bg-rose-500/10 hover:text-rose-500"><Trash2 className="h-4 w-4" /></button>}
                  </div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Field label="Age min"><input type="number" min={13} max={65} className={inputCls} value={as.ageMin} onChange={(e) => setAdSet(si, { ageMin: Number(e.target.value) || 18 })} /></Field>
                    <Field label="Age max"><input type="number" min={13} max={65} className={inputCls} value={as.ageMax} onChange={(e) => setAdSet(si, { ageMax: Number(e.target.value) || 65 })} /></Field>
                    {budgetMode === "ABO" && <Field label={`Budget (${currency})`}><input type="number" min={1} className={inputCls} value={as.budget || ""} onChange={(e) => setAdSet(si, { budget: Number(e.target.value) || 0 })} /></Field>}
                    <Field label="Interests (comma-separated)"><input className={inputCls} value={as.interests} onChange={(e) => setAdSet(si, { interests: e.target.value })} placeholder="Dentistry, Invisalign" /></Field>
                  </div>
                  <div className="mt-3 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Ads ({as.ads.length})</p>
                      <button onClick={() => setAdSet(si, { ads: [...as.ads, blankAd(as.ads.length + 1)] })} className="flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"><Plus className="h-3.5 w-3.5" /> Add ad</button>
                    </div>
                    {as.ads.map((ad, ai) => (
                      <div key={ai} className="rounded-lg border border-ink-100 bg-ink-50/40 p-3">
                        <div className="flex items-center gap-2">
                          <input className={`${inputCls} text-sm`} value={ad.name} onChange={(e) => setAd(si, ai, { name: e.target.value })} placeholder={`Ad ${ai + 1} name`} />
                          {as.ads.length > 1 && <button onClick={() => setAdSet(si, { ads: as.ads.filter((_, k) => k !== ai) })} className="rounded p-1.5 text-ink-400 hover:text-rose-500"><X className="h-3.5 w-3.5" /></button>}
                        </div>
                        <div className="mt-2 grid gap-2">
                          <textarea rows={2} className={inputCls} value={ad.primaryText} onChange={(e) => setAd(si, ai, { primaryText: e.target.value })} placeholder="Primary text — the main body of the ad" />
                          <div className="grid gap-2 sm:grid-cols-2">
                            <input className={inputCls} value={ad.headline} onChange={(e) => setAd(si, ai, { headline: e.target.value })} placeholder="Headline (under 40 chars)" />
                            <input className={inputCls} value={ad.description} onChange={(e) => setAd(si, ai, { description: e.target.value })} placeholder="Description (optional)" />
                          </div>
                          <input className={inputCls} value={ad.imageUrl} onChange={(e) => setAd(si, ai, { imageUrl: e.target.value })} placeholder="Image URL (paste a public link, or leave blank to add later)" />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* STEP 6 — review */}
          {step === 6 && (
            <div className="space-y-4">
              <div className="rounded-xl border border-ink-200 p-4 text-sm">
                <p className="font-semibold text-ink-900">{name || "(unnamed campaign)"}</p>
                <ul className="mt-2 space-y-1 text-ink-600">
                  <li>Objective: <strong>{selObj?.label}</strong>{selConv ? ` · ${selConv.label}` : ""}{selConv?.needsMessagingApp ? ` (${MESSAGING_APPS.find((m) => m.id === messagingApp)?.label})` : ""}</li>
                  <li>Budget: <strong>{budgetMode}</strong> · {budgetType} · {money(budget, currency)}{budgetType === "lifetime" && endDate ? ` until ${endDate}` : ""}</li>
                  <li>Placements: {placements.length ? placements.map((p) => PLACEMENTS.find((x) => x.id === p)?.label).join(", ") : "automatic"}</li>
                  <li>Targeting: {geoIncluded.length ? geoIncluded.map((g) => g.name).join(", ") : "whole country (AE)"}{geoExcluded.length ? ` · excluding ${geoExcluded.map((g) => g.name).join(", ")}` : ""}</li>
                  <li>Ad sets: {adSets.length} · ads: {adSets.reduce((n, a) => n + a.ads.length, 0)}</li>
                </ul>
              </div>
              <Field label="Create as">
                <div className="flex gap-2">
                  {(["PAUSED", "ACTIVE"] as const).map((st) => (
                    <button key={st} onClick={() => setStatus(st)} className={`flex-1 rounded-xl border px-3 py-2 text-sm font-medium ${status === st ? (st === "ACTIVE" ? "border-emerald-500 bg-emerald-500/10 text-emerald-600" : "border-amber-500 bg-amber-500/10 text-amber-600") : "border-ink-200 text-ink-500 hover:bg-ink-50"}`}>{st === "ACTIVE" ? "Live (spending)" : "Draft (paused)"}</button>
                  ))}
                </div>
              </Field>
              <p className="text-xs text-ink-400">Ad sets and ads are always created paused. Everything is built on Meta through the marketing engine; review it in the Ads tab, then activate.</p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-ink-200 px-6 py-4">
          <button onClick={() => (step === 1 ? onClose() : setStep(step - 1))} className="flex items-center gap-1.5 rounded-xl border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50">
            <ArrowLeft className="h-4 w-4" /> {step === 1 ? "Cancel" : "Back"}
          </button>
          {step < STEPS.length ? (
            <button onClick={() => setStep(step + 1)} disabled={!canNext} className="rounded-xl bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">Continue</button>
          ) : (
            <button onClick={create} disabled={creating} className="rounded-xl bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
              {creating ? "Creating on Meta…" : status === "ACTIVE" ? "Create & go live" : "Create as draft"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
