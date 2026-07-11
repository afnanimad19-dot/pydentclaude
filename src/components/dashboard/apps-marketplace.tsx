"use client";

import { useEffect, useMemo, useState } from "react";
import { Grid3x3, RefreshCw, ExternalLink, CheckCircle2, Search } from "lucide-react";
import { Card } from "@/components/ui";
import { getWorkspaceId } from "@/lib/db";

// App marketplace: every platform the clinic can connect through the marketing
// engine (~70 visible apps), with live connected status. Connecting happens on
// the engine's secure portal (their OAuth); once connected there, the app is
// instantly usable inside Pydent — the tabs and AI Marketing agents read it.

interface AppItem {
  id: string;
  name: string;
  description: string;
  connected: boolean;
  needsAuth: boolean;
  toolCount: number;
  category: string;
}

const PORTAL = "https://hyperfx.ai";

export function AppsMarketplace() {
  const [apps, setApps] = useState<AppItem[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("All");

  function fetchApps() {
    getWorkspaceId()
      .then((ws) => fetch(`/api/hyperfx/apps?ws=${ws ?? ""}`))
      .then((r) => r.json())
      .then((d) => { setApps(d.apps ?? []); setConfigured(d.configured !== false); })
      .catch(() => setApps([]))
      .finally(() => setLoading(false));
  }
  // loading starts true, so the initial effect only fires the fetch (no sync setState).
  function reload() { setLoading(true); fetchApps(); }
  useEffect(fetchApps, []);

  const cats = useMemo(() => ["All", ...Array.from(new Set(apps.map((a) => a.category))).sort()], [apps]);
  const list = apps.filter((a) => (cat === "All" || a.category === cat) && (!q || `${a.name} ${a.description}`.toLowerCase().includes(q.toLowerCase())));
  const connectedCount = apps.filter((a) => a.connected).length;

  if (!configured) return null; // marketplace appears once the engine is configured

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold text-ink-900">
          <Grid3x3 className="h-5 w-5 text-brand-500" /> Apps
        </h2>
        <div className="flex items-center gap-2 text-xs text-ink-400">
          <span>{connectedCount} connected · {apps.length} available</span>
          <button onClick={reload} title="Refresh" className="rounded-lg p-1 text-ink-400 hover:bg-ink-100"><RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /></button>
        </div>
      </div>
      <p className="mt-1 max-w-2xl text-sm text-ink-500">
        Connect the platforms your clinic uses — ads, social media, CRM, email, analytics. Click Connect, authorize on the
        secure portal, then hit refresh here: the app turns green and starts working across Pydent immediately.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 rounded-xl border border-ink-200 bg-surface px-3 py-1.5">
          <Search className="h-3.5 w-3.5 text-ink-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search apps…" className="w-40 bg-transparent text-sm text-ink-800 outline-none placeholder:text-ink-400" />
        </div>
        {cats.map((c) => (
          <button key={c} onClick={() => setCat(c)} className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${cat === c ? "bg-brand-600 text-white" : "text-ink-500 hover:bg-ink-100"}`}>{c}</button>
        ))}
      </div>

      {loading && apps.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-400">Loading apps…</p>
      ) : list.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-400">No apps match.</p>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((a) => (
            <div key={a.id} className={`flex flex-col rounded-xl border p-3.5 ${a.connected ? "border-emerald-500/40 bg-emerald-500/5" : "border-ink-200"}`}>
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-semibold text-ink-900">{a.name}</p>
                {a.connected ? (
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-600"><CheckCircle2 className="h-3 w-3" /> Connected</span>
                ) : a.needsAuth ? (
                  <a href={PORTAL} target="_blank" rel="noreferrer" className="flex shrink-0 items-center gap-1 rounded-full bg-brand-600 px-2.5 py-0.5 text-[10px] font-semibold text-white hover:bg-brand-700">Connect <ExternalLink className="h-2.5 w-2.5" /></a>
                ) : (
                  <span className="shrink-0 rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-medium text-ink-500">Built-in</span>
                )}
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-ink-500">{a.description}</p>
              <p className="mt-auto pt-2 text-[10px] text-ink-400">{a.category} · {a.toolCount} actions</p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
