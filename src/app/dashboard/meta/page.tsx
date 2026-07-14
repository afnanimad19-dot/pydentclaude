"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Megaphone, RefreshCw, ExternalLink, Plug, DollarSign, Eye, MousePointerClick, Percent, Plus, MoreVertical, Pencil, Copy, Trash2, X, ChevronDown, ChevronRight, Pause, Play } from "lucide-react";
import { Card, StatusBadge } from "@/components/ui";
import { Modal, Field, ModalFooter, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import { getWorkspaceId } from "@/lib/db";

// Meta Ads — live campaigns with full management, Meta-style:
// campaign → ad sets → ads. Filter by status (active first by default), edit /
// duplicate / delete, create new (PAUSED by default so nothing spends without an
// explicit choice), and click a campaign for its overview: totals, a daily-spend
// graph, and its ad sets & ads. All through the marketing engine.

interface MetaAccount { id: string; name: string; status: string; currency: string }
interface MetaCampaign { id: string; name: string; status: string; objective: string; dailyBudget: number | null; lifetimeBudget: number | null; startTime: string | null }
interface MetaInsights { spend: number; impressions: number; clicks: number; ctr: number; cpc: number }
interface AdRow { id: string; name: string; status: string }
interface AdSetRow { id: string; name: string; status: string; dailyBudget: number | null; lifetimeBudget: number | null; optimization: string | null; ads: AdRow[] }
interface DailyRow { date: string; spend: number; impressions: number; clicks: number }

interface MetaData {
  configured: boolean;
  connected?: boolean;
  error?: string;
  accounts?: MetaAccount[];
  account?: string;
  campaigns?: MetaCampaign[];
  insights?: MetaInsights | null;
}

const OBJECTIVES = ["OUTCOME_TRAFFIC", "OUTCOME_LEADS", "OUTCOME_ENGAGEMENT", "OUTCOME_AWARENESS", "OUTCOME_SALES", "OUTCOME_APP_PROMOTION"];

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

  const fetchData = useCallback((acct?: string) => {
    getWorkspaceId()
      .then((w) => { setWs(w); return fetch(`/api/hyperfx/meta?ws=${w ?? ""}${acct ? `&account=${encodeURIComponent(acct)}` : ""}`); })
      .then((r) => r.json())
      .then((d) => { setData(d); if (d.account) setAccount(d.account); })
      .catch((e) => setData({ configured: true, connected: false, error: e instanceof Error ? e.message : "Request failed" }))
      .finally(() => setLoading(false));
  }, []);
  const load = useCallback((acct?: string) => { setLoading(true); fetchData(acct); }, [fetchData]);
  useEffect(() => { fetchData(); }, [fetchData]);

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
        <CampaignModal
          title="New campaign"
          initial={{ name: "", objective: OBJECTIVES[0], dailyBudget: 10, status: "PAUSED" }}
          currency={cur}
          onClose={() => setCreateOpen(false)}
          onSave={async (v) => {
            const ok = await manage("create_campaign", { account_id: account, name: v.name, objective: v.objective, daily_budget: v.dailyBudget || undefined, status: v.status }, v.status === "ACTIVE" ? "Campaign created and LIVE." : "Campaign created (paused).");
            if (ok) { setCreateOpen(false); fetchData(account); }
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
      {detail && ws && <CampaignDrawer campaign={detail} ws={ws} account={account} currency={cur} onClose={() => setDetail(null)} onChanged={() => fetchData(account)} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-xl font-bold text-ink-900">
            <Megaphone className="h-5 w-5 text-brand-500" /> Meta Ads
          </h1>
          <p className="text-sm text-ink-500">Your live Meta campaigns — view, edit, duplicate, create. Click a campaign for its full overview.</p>
        </div>
        <div className="flex items-center gap-2">
          {(data?.accounts?.length ?? 0) > 1 && (
            <select value={account} onChange={(e) => { setAccount(e.target.value); load(e.target.value); }} className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-sm text-ink-700 outline-none" title="Ad account">
              {data!.accounts!.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
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
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="border-b border-ink-200 bg-ink-50 text-xs font-semibold uppercase tracking-wide text-ink-500">
                    <tr>
                      <th className="px-5 py-2.5">Campaign</th>
                      <th className="px-4 py-2.5">Status</th>
                      <th className="px-4 py-2.5">Objective</th>
                      <th className="px-4 py-2.5 text-right">Daily budget</th>
                      <th className="px-4 py-2.5">Started</th>
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
                        <td className="px-4 py-3 text-ink-600">{objLabel(c.objective)}</td>
                        <td className="px-4 py-3 text-right text-ink-700">{c.dailyBudget != null ? money(c.dailyBudget, cur) : c.lifetimeBudget != null ? `${money(c.lifetimeBudget, cur)} lifetime` : <span className="text-ink-400" title="Budget is set on the ad sets">on ad sets</span>}</td>
                        <td className="px-4 py-3 text-ink-600">{c.startTime ? c.startTime.slice(0, 10) : "—"}</td>
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
              {[...new Set([initial.objective, ...OBJECTIVES])].filter(Boolean).map((o) => <option key={o} value={o}>{objLabel(o)}</option>)}
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
function CampaignDrawer({ campaign, ws, account, currency, onClose, onChanged }: {
  campaign: MetaCampaign;
  ws: string;
  account: string;
  currency: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [adsets, setAdsets] = useState<AdSetRow[] | null>(null);
  const [daily, setDaily] = useState<DailyRow[]>([]);
  const [totals, setTotals] = useState<MetaInsights | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openSet, setOpenSet] = useState<string | null>(null);
  const [busySet, setBusySet] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/hyperfx/meta/campaign?ws=${ws}&id=${encodeURIComponent(campaign.id)}&account=${encodeURIComponent(account)}`)
      .then((r) => r.json())
      .then((d) => {
        setAdsets(d.adsets ?? []);
        setDaily(d.daily ?? []);
        setTotals(d.totals ?? null);
        setErr(d.adsetsError || d.insightsError || null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Failed to load"));
  }, [ws, campaign.id, account]);
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
          {totals && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Spend (30d)", money(totals.spend, currency)],
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
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Daily spend — last 30 days</p>
            {daily.length > 1 ? (
              <SpendChart daily={daily} currency={currency} />
            ) : (
              <p className="rounded-xl border border-ink-100 px-4 py-6 text-center text-sm text-ink-400">{adsets === null ? "Loading…" : "No delivery in the last 30 days."}</p>
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
                    {openSet === s.id && (
                      <div className="border-t border-ink-100 px-3.5 py-2">
                        {s.optimization && <p className="mb-1.5 text-[11px] text-ink-400">Optimisation: {s.optimization.replaceAll("_", " ").toLowerCase()}</p>}
                        {s.ads.length === 0 ? (
                          <p className="py-2 text-xs text-ink-400">No ads in this ad set.</p>
                        ) : (
                          <ul className="divide-y divide-ink-100">
                            {s.ads.map((a) => (
                              <li key={a.id} className="flex items-center justify-between py-2 text-sm">
                                <span className="truncate text-ink-800">{a.name}</span>
                                <StatusBadge status={a.status} tone={statusTone(a.status)} />
                              </li>
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
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full text-brand-600 dark:text-brand-300" role="img" aria-label="Daily spend, last 30 days">
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
