"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Camera, RefreshCw, ExternalLink, CheckCircle2, CalendarDays, Sparkles, TrendingUp } from "lucide-react";
import { Card } from "@/components/ui";
import { getWorkspaceId } from "@/lib/db";

// Social Media Overview — every social platform the clinic can connect, its
// live connected status, and what lights up once it's on. Platform metrics
// (reach, views, what's trending) read through the marketing engine per
// connected platform; the AI Marketing team analyzes them on demand.

interface AppItem { id: string; name: string; connected: boolean; needsAuth: boolean; category: string }

const SOCIAL_IDS: Record<string, { label: string; gives: string }> = {
  instagram_toolkit: { label: "Instagram", gives: "posts, reels, reach & engagement" },
  meta_business: { label: "Facebook (Meta)", gives: "page reach, posts & ad audiences" },
  tiktok: { label: "TikTok", gives: "videos, views & audience" },
  youtube_toolkit: { label: "YouTube", gives: "channel & video performance" },
  linkedin_toolkit: { label: "LinkedIn", gives: "company page & posts" },
  x_toolkit: { label: "X (Twitter)", gives: "posts & engagement" },
  pinterest_toolkit: { label: "Pinterest", gives: "boards, pins & saves" },
};

// Scraper-powered research that works with NO account connection.
const RESEARCH = [
  { id: "instagram_scraper", label: "Instagram research", gives: "scrape any public profile/posts — see what performs in your niche" },
  { id: "tiktok_scraper", label: "TikTok research", gives: "scrape trending clinic content ideas" },
  { id: "youtube_scraper", label: "YouTube research", gives: "scrape video performance in your niche" },
  { id: "twitter_scraper", label: "X research", gives: "scrape public posts & topics" },
  { id: "google_trends_scraper", label: "Google Trends", gives: "what patients search for right now" },
];

export default function SocialOverviewPage() {
  const [apps, setApps] = useState<AppItem[]>([]);
  const [loading, setLoading] = useState(true);

  function fetchApps() {
    getWorkspaceId()
      .then((ws) => fetch(`/api/hyperfx/apps?ws=${ws ?? ""}`))
      .then((r) => r.json())
      .then((d) => setApps(d.apps ?? []))
      .catch(() => setApps([]))
      .finally(() => setLoading(false));
  }
  // loading starts true, so the initial effect only fires the fetch (no sync setState).
  function reload() { setLoading(true); fetchApps(); }
  useEffect(fetchApps, []);

  const byId = new Map(apps.map((a) => [a.id, a]));
  const platforms = Object.entries(SOCIAL_IDS).map(([id, meta]) => ({ id, ...meta, connected: byId.get(id)?.connected ?? false }));
  const connected = platforms.filter((p) => p.connected).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-xl font-bold text-ink-900">
            <Camera className="h-5 w-5 text-brand-500" /> Social Media
          </h1>
          <p className="text-sm text-ink-500">All the clinic&apos;s social platforms in one place — connect them and the overview fills with reach, views and what&apos;s working.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/instagram" className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700">
            <CalendarDays className="h-4 w-4" /> Content calendar
          </Link>
          <button onClick={reload} className="flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      <Card className="p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-ink-900">Your platforms</h2>
          <span className="text-xs text-ink-400">{connected} of {platforms.length} connected</span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {platforms.map((p) => (
            <div key={p.id} className={`rounded-xl border p-4 ${p.connected ? "border-emerald-500/40 bg-emerald-500/5" : "border-ink-200"}`}>
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-ink-900">{p.label}</p>
                {p.connected ? (
                  <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-600"><CheckCircle2 className="h-3 w-3" /> Connected</span>
                ) : (
                  <Link href="/dashboard/settings?tab=connections" className="flex items-center gap-1 rounded-full bg-brand-600 px-2.5 py-0.5 text-[10px] font-semibold text-white hover:bg-brand-700">Connect <ExternalLink className="h-2.5 w-2.5" /></Link>
                )}
              </div>
              <p className="mt-1.5 text-xs text-ink-500">{p.connected ? `Live: ${p.gives}.` : `Connect to see ${p.gives}.`}</p>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-6">
          <h2 className="flex items-center gap-2 font-semibold text-ink-900"><TrendingUp className="h-5 w-5 text-brand-500" /> Research — works today, no connection needed</h2>
          <p className="mt-1 text-sm text-ink-500">Public-data research the engine can run right now for content ideas and competitor watching.</p>
          <ul className="mt-4 space-y-2.5">
            {RESEARCH.map((r) => (
              <li key={r.id} className="flex items-start gap-2.5 text-sm">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                <span><strong className="text-ink-900">{r.label}</strong> <span className="text-ink-500">— {r.gives}</span></span>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="p-6">
          <h2 className="flex items-center gap-2 font-semibold text-ink-900"><Sparkles className="h-5 w-5 text-brand-500" /> Put the AI Marketing team on it</h2>
          <p className="mt-1 text-sm text-ink-500">The four specialists read every connected platform. Try asking:</p>
          <ul className="mt-4 space-y-2.5 text-sm text-ink-700">
            <li className="rounded-lg border border-ink-100 px-3 py-2">&quot;Helena, what dental content is performing on Instagram right now? Draft me 5 post ideas.&quot;</li>
            <li className="rounded-lg border border-ink-100 px-3 py-2">&quot;Helena, pull my Meta ads performance for the last 30 days and tell me what to change.&quot;</li>
            <li className="rounded-lg border border-ink-100 px-3 py-2">&quot;Sam, how visible are we in AI search and Google for &apos;dentist in Dubai&apos;?&quot;</li>
            <li className="rounded-lg border border-ink-100 px-3 py-2">&quot;Kai, scrape our latest Google reviews and flag anything unhappy.&quot;</li>
          </ul>
          <Link href="/dashboard/team-ai" className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
            Open AI Marketing <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </Card>
      </div>
    </div>
  );
}
