"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BarChart3,
  Search,
  Store,
  Megaphone,
  HardDrive,
  CalendarDays,
  CircleAlert,
  CheckCircle2,
} from "lucide-react";
import { Card } from "@/components/ui";
import { toast } from "@/components/toast";
import { fetchConnections, disconnectConnection, getWorkspaceId, type Connection } from "@/lib/db";

// Google products a clinic can connect (each via the same OAuth app, its own
// account). Marketing/social channels come later.
const GOOGLE_PROVIDERS: { key: string; name: string; detail: string; icon: typeof BarChart3 }[] = [
  { key: "google_analytics", name: "Google Analytics", detail: "Website traffic & conversions (GA4).", icon: BarChart3 },
  { key: "google_search_console", name: "Google Search Console", detail: "Search rankings, clicks & impressions.", icon: Search },
  { key: "google_business", name: "Google Business Profile", detail: "Reviews, calls & map listing.", icon: Store },
  { key: "google_ads", name: "Google Ads", detail: "Campaign spend & performance.", icon: Megaphone },
  { key: "google_drive", name: "Google Drive", detail: "Pull documents into agent knowledge.", icon: HardDrive },
  { key: "google_calendar", name: "Google Calendar", detail: "Mirror booked appointments to a calendar.", icon: CalendarDays },
];

export function IntegrationsPanel() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [ws, setWs] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetchConnections().then(setConnections);
  }, []);

  useEffect(() => {
    refresh();
    getWorkspaceId().then(setWs);
    fetch("/api/health").then((r) => r.json()).then((h) => setConfigured(!!h.google)).catch(() => setConfigured(false));
  }, [refresh]);

  // When the OAuth popup finishes, it postMessages us — refresh the cards.
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.data?.type === "pydent-oauth") {
        if (e.data.status === "connected") toast("Connected.", "success");
        else if (e.data.status && e.data.status !== "denied") toast(`Connection: ${e.data.status}`, "info");
        setBusy(null);
        refresh();
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [refresh]);

  function connect(provider: string) {
    if (!configured) {
      toast("Add GOOGLE_OAUTH_CLIENT_ID / SECRET in Netlify to enable Google connections.", "info");
      return;
    }
    if (!ws) {
      toast("Sign in first.", "info");
      return;
    }
    setBusy(provider);
    const url = `/api/google/oauth?provider=${provider}&ws=${encodeURIComponent(ws)}&popup=1`;
    const popup = window.open(url, "pydent-oauth", "width=520,height=680");
    // Fallback: if popups are blocked, navigate in the same tab.
    if (!popup) {
      window.location.assign(url.replace("&popup=1", ""));
      return;
    }
    // Fallback: if no message arrives but the popup closed, refresh anyway.
    const timer = setInterval(() => {
      if (popup.closed) {
        clearInterval(timer);
        setBusy(null);
        refresh();
      }
    }, 800);
  }

  async function disconnect(provider: string) {
    setBusy(provider);
    await disconnectConnection(provider);
    setBusy(null);
    refresh();
    toast("Disconnected.", "success");
  }

  const byProvider = Object.fromEntries(connections.map((c) => [c.provider, c]));

  return (
    <div className="space-y-4">
      {configured === false && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Google connections need a one-time setup: create an OAuth client in Google Cloud Console, add
            <code className="mx-1 rounded bg-amber-500/15 px-1">GOOGLE_OAUTH_CLIENT_ID</code> and
            <code className="mx-1 rounded bg-amber-500/15 px-1">GOOGLE_OAUTH_CLIENT_SECRET</code> in Netlify, and add this
            redirect URI: <code className="rounded bg-amber-500/15 px-1">{typeof window !== "undefined" ? window.location.origin : ""}/api/google/oauth/callback</code>.
          </span>
        </div>
      )}

      <div>
        <h3 className="mb-1 text-sm font-semibold text-ink-900">Channel data &amp; setup — Google</h3>
        <p className="mb-3 text-sm text-ink-500">Each clinic connects its own Google accounts. One click, approve in the Google popup — done.</p>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {GOOGLE_PROVIDERS.map((p) => {
            const conn = byProvider[p.key];
            const connected = !!conn;
            const Icon = p.icon;
            return (
              <Card key={p.key} className="flex flex-col p-4">
                <div className="flex items-start gap-3">
                  <div className="rounded-lg border border-ink-100 bg-ink-50 p-2"><Icon className="h-5 w-5 text-ink-600" /></div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink-900">{p.name}</p>
                    <p className="flex items-center gap-1.5 text-xs">
                      <span className={`inline-block h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-ink-300"}`} />
                      <span className={connected ? "text-emerald-600" : "text-ink-400"}>
                        {connected ? (conn.accountLabel ? `Connected · ${conn.accountLabel}` : "Connected") : "Not connected"}
                      </span>
                    </p>
                  </div>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-ink-500">{p.detail}</p>
                {connected ? (
                  <div className="mt-3 flex gap-2">
                    <span className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-500/15 py-2 text-xs font-semibold text-emerald-600">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Connected
                    </span>
                    <button onClick={() => disconnect(p.key)} disabled={busy === p.key} className="rounded-lg border border-ink-200 px-3 py-2 text-xs font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-50">
                      Disconnect
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => connect(p.key)}
                    disabled={busy === p.key}
                    className="mt-3 rounded-lg border border-ink-200 py-2 text-xs font-semibold text-brand-600 hover:bg-brand-50 disabled:opacity-50 dark:text-brand-300"
                  >
                    {busy === p.key ? "Connecting…" : "Connect"}
                  </button>
                )}
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
