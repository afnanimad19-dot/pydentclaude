"use client";

import { useEffect, useState } from "react";
import { Grid3x3, RefreshCw, CheckCircle2 } from "lucide-react";
import { Card, StatusBadge } from "@/components/ui";
import { getWorkspaceId } from "@/lib/db";

// Integrations — a card grid (3-up) of the apps that power Pydent, with each
// one's LIVE connected status pulled from the clinic's marketing engine
// (Hyperfx). There is nothing to sign up for or configure here: connect an app
// on the engine and its card flips to Connected by itself, and everything that
// uses it (Ads tabs, Social, Reports, email, calendar, the AI team) starts
// working. Anything else connected on the engine appears as an extra card.

interface AppItem { id: string; name: string; connected: boolean; description?: string; builtin?: boolean }

// The apps a dental clinic actually uses, with a short chip style per brand.
const CURATED: { id: string; name: string; detail: string; badge: string; color: string }[] = [
  { id: "meta_business", name: "Meta Ads", detail: "Facebook & Instagram ads — powers the Meta Ads tab.", badge: "f", color: "bg-[#1877f2] text-white" },
  { id: "instagram_toolkit", name: "Instagram", detail: "Profile, posts and engagement data.", badge: "IG", color: "bg-gradient-to-tr from-[#f58529] to-[#dd2a7b] text-white" },
  { id: "google_ads", name: "Google Ads", detail: "Campaigns & performance — powers the Google Ads tab.", badge: "Ad", color: "bg-[#fbbc04] text-ink-900" },
  { id: "google_analytics_toolkit", name: "Google Analytics", detail: "Website traffic and conversion reporting.", badge: "GA", color: "bg-[#e8710a] text-white" },
  { id: "google_search_console_toolkit", name: "Search Console", detail: "Search rankings, clicks and indexing.", badge: "SC", color: "bg-[#4285f4] text-white" },
  { id: "google_calendar", name: "Google Calendar", detail: "Bookings mirror to the clinic calendar.", badge: "Ca", color: "bg-[#4285f4] text-white" },
  { id: "gmail", name: "Gmail", detail: "Patient emails send from the clinic's own address.", badge: "Gm", color: "bg-[#ea4335] text-white" },
  { id: "google_sheets", name: "Google Sheets", detail: "Export and sync data to spreadsheets.", badge: "Sh", color: "bg-[#1fa463] text-white" },
  { id: "google_docs_toolkit", name: "Google Docs", detail: "The AI team drafts documents and shares links.", badge: "Do", color: "bg-[#4285f4] text-white" },
  { id: "tiktok_marketing", name: "TikTok Ads", detail: "Campaigns & performance — powers the TikTok tab.", badge: "♪", color: "bg-black text-white" },
  { id: "linkedin_ads_toolkit", name: "LinkedIn Ads", detail: "Campaign reporting for LinkedIn.", badge: "in", color: "bg-[#0a66c2] text-white" },
  { id: "wordpress_org_toolkit", name: "WordPress", detail: "Publish blog posts to the clinic website.", badge: "W", color: "bg-[#21759b] text-white" },
  { id: "hubspot_toolkit", name: "HubSpot", detail: "CRM contacts, deals and pipelines.", badge: "H", color: "bg-[#ff7a59] text-white" },
  { id: "calendly_toolkit", name: "Calendly", detail: "Availability and scheduled events.", badge: "C", color: "bg-[#006bff] text-white" },
  { id: "stripe", name: "Stripe", detail: "Payments and subscriptions.", badge: "S", color: "bg-[#635bff] text-white" },
];

function AppCard({ name, detail, badge, color, connected, loading }: { name: string; detail: string; badge: string; color: string; connected: boolean; loading: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 transition-colors ${connected ? "border-emerald-500/40 bg-emerald-500/[0.04]" : "border-ink-200"}`}>
      <div className="flex items-center gap-2.5">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold ${color}`}>{badge}</span>
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-ink-900">{name}</p>
      </div>
      <p className="mt-2 line-clamp-2 text-xs text-ink-400">{detail}</p>
      <div className="mt-3">
        {loading ? (
          <StatusBadge status="Checking…" tone="gray" />
        ) : connected ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-600">
            <CheckCircle2 className="h-3 w-3" /> Connected
          </span>
        ) : (
          <StatusBadge status="Not connected" tone="gray" />
        )}
      </div>
    </div>
  );
}

export function AppsMarketplace() {
  const [apps, setApps] = useState<Map<string, AppItem>>(new Map());
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);

  function fetchApps() {
    getWorkspaceId()
      .then((ws) => fetch(`/api/hyperfx/apps?ws=${ws ?? ""}`))
      .then((r) => r.json())
      .then((d) => {
        setConfigured(d.configured !== false);
        setApps(new Map(((d.apps ?? []) as AppItem[]).map((a) => [a.id, a])));
      })
      .catch(() => setApps(new Map()))
      .finally(() => setLoading(false));
  }
  function reload() { setLoading(true); fetchApps(); }
  useEffect(fetchApps, []);

  const connectedCount = CURATED.filter((c) => apps.get(c.id)?.connected).length;
  // Anything ELSE the clinic connected on the engine (Notion, Shopify, Snapchat,
  // Outlook, …) appears automatically as an extra card.
  const curatedIds = new Set(CURATED.map((c) => c.id));
  const extras = [...apps.values()].filter((a) => a.connected && !a.builtin && !curatedIds.has(a.id));

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold text-ink-900">
          <Grid3x3 className="h-5 w-5 text-brand-500" /> Integrations
        </h2>
        <div className="flex items-center gap-2 text-xs text-ink-400">
          <span>{connectedCount + extras.length} connected</span>
          <button onClick={reload} title="Refresh" className="rounded-lg p-1 text-ink-400 hover:bg-ink-100"><RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /></button>
        </div>
      </div>
      <p className="mt-1 max-w-2xl text-sm text-ink-500">
        Everything connects through your marketing engine — nothing to sign up for here. Connect an app there and its
        card flips to <strong className="font-semibold text-emerald-600">Connected</strong> automatically, and every part
        of Pydent that uses it starts working.
      </p>
      {!configured && (
        <p className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-600">
          The marketing engine isn&apos;t configured for this clinic yet — add your Hyperfx credentials above and these
          cards will show live status.
        </p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CURATED.map((c) => (
          <AppCard key={c.id} name={c.name} detail={c.detail} badge={c.badge} color={c.color} connected={apps.get(c.id)?.connected ?? false} loading={loading && configured} />
        ))}
        {extras.map((a) => (
          <AppCard key={a.id} name={a.name} detail={a.description || "Connected for this clinic — available to the AI team."} badge={a.name.slice(0, 2).toUpperCase()} color="bg-ink-700 text-white" connected loading={false} />
        ))}
      </div>
    </Card>
  );
}
