"use client";

import { useEffect, useState } from "react";
import { Grid3x3, RefreshCw, CheckCircle2 } from "lucide-react";
import { Card, StatusBadge } from "@/components/ui";
import { getWorkspaceId } from "@/lib/db";

// Marketing apps — a short, curated status list (the apps a clinic actually
// uses), styled like the Channels/Integrations rows. Status is detected
// automatically from the clinic's marketing engine: connect an app there and
// this flips to Connected by itself — there is nothing to click here.

interface AppItem { id: string; name: string; connected: boolean; description?: string; builtin?: boolean }

// The main apps a dental clinic actually needs — deliberately short.
const CURATED: { id: string; name: string; detail: string }[] = [
  { id: "meta_business", name: "Meta Ads (Facebook & Instagram)", detail: "Ad accounts, campaigns, insights — powers the Meta Ads tab." },
  { id: "instagram_toolkit", name: "Instagram", detail: "Profile, posts and engagement data." },
  { id: "google_ads", name: "Google Ads", detail: "Campaigns and performance — powers the Google Ads tab." },
  { id: "google_analytics_toolkit", name: "Google Analytics", detail: "Website traffic and conversion reporting." },
  { id: "google_search_console_toolkit", name: "Google Search Console", detail: "Search rankings, clicks and indexing." },
  { id: "google_calendar", name: "Google Calendar", detail: "Appointment sync to the clinic calendar." },
  { id: "gmail", name: "Gmail", detail: "Send email from the clinic's own address." },
  { id: "google_sheets", name: "Google Sheets", detail: "Export and sync data to spreadsheets." },
  { id: "tiktok_marketing", name: "TikTok Ads", detail: "Campaigns and performance — powers the TikTok Ads tab." },
  { id: "linkedin_ads_toolkit", name: "LinkedIn Ads", detail: "Campaign reporting for LinkedIn." },
  { id: "wordpress_org_toolkit", name: "WordPress", detail: "Publish blog posts to the clinic website." },
  { id: "hubspot_toolkit", name: "HubSpot", detail: "CRM contacts, deals and pipelines." },
];

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
  // loading starts true, so the initial effect only fires the fetch (no sync setState).
  function reload() { setLoading(true); fetchApps(); }
  useEffect(fetchApps, []);

  if (!configured) return null; // appears once the engine is configured

  const connectedCount = CURATED.filter((c) => apps.get(c.id)?.connected).length;
  // Anything ELSE the clinic has connected on the engine (GitHub, Notion,
  // Shopify, Stripe, Calendly, …) appears automatically below the curated list.
  const curatedIds = new Set(CURATED.map((c) => c.id));
  const extras = [...apps.values()].filter((a) => a.connected && !a.builtin && !curatedIds.has(a.id));

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold text-ink-900">
          <Grid3x3 className="h-5 w-5 text-brand-500" /> Marketing apps
        </h2>
        <div className="flex items-center gap-2 text-xs text-ink-400">
          <span>{connectedCount + extras.length} connected</span>
          <button onClick={reload} title="Refresh" className="rounded-lg p-1 text-ink-400 hover:bg-ink-100"><RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /></button>
        </div>
      </div>
      <p className="mt-1 max-w-2xl text-sm text-ink-500">
        Status updates automatically as apps are connected for this clinic — connected apps start working across
        Pydent (the Ads tabs, Social Media overview and the AI Marketing team) right away.
      </p>

      <div className="mt-4 divide-y divide-ink-100">
        {CURATED.map((c) => {
          const on = apps.get(c.id)?.connected ?? false;
          return (
            <div key={c.id} className="flex items-center gap-3 py-3">
              <span className={`h-2 w-2 shrink-0 rounded-full ${on ? "bg-emerald-500" : "bg-ink-300"}`} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink-900">{c.name}</p>
                <p className="truncate text-xs text-ink-400">{c.detail}</p>
              </div>
              {loading ? (
                <StatusBadge status="Checking…" tone="gray" />
              ) : on ? (
                <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-600"><CheckCircle2 className="h-3 w-3" /> Connected</span>
              ) : (
                <StatusBadge status="Needs integration" tone="gray" />
              )}
            </div>
          );
        })}
        {extras.map((a) => (
          <div key={a.id} className="flex items-center gap-3 py-3">
            <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink-900">{a.name}</p>
              <p className="truncate text-xs text-ink-400">{a.description || "Connected for this clinic — available to the AI Marketing team."}</p>
            </div>
            <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-600"><CheckCircle2 className="h-3 w-3" /> Connected</span>
          </div>
        ))}
      </div>
    </Card>
  );
}
