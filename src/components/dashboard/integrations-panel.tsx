"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Search, CheckCircle2, CircleAlert, X } from "lucide-react";
import { Card } from "@/components/ui";
import { Modal, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import { fetchConnections, disconnectConnection, setConnectionAccessMode, getWorkspaceId, type Connection } from "@/lib/db";

// A provider in the catalog. `oauth: "google"` ones connect for real (popup);
// the rest render as cards and explain the one-time app setup they need.
interface Provider {
  key: string;
  name: string;
  detail: string;
  group: "posting" | "data";
  badge: string; // short label shown in the logo chip
  color: string; // chip background
  oauth?: "google";
  apiKey?: boolean; // connects with a pasted API key (Brevo, Mailchimp)
}

const PROVIDERS: Provider[] = [
  // Content posting
  { key: "x", name: "X (Twitter)", detail: "Schedule & publish posts.", group: "posting", badge: "X", color: "bg-black text-white" },
  { key: "linkedin", name: "LinkedIn", detail: "Publish to your company page.", group: "posting", badge: "in", color: "bg-[#0a66c2] text-white" },
  { key: "youtube", name: "YouTube", detail: "Publish videos & shorts.", group: "posting", badge: "▶", color: "bg-[#ff0000] text-white" },
  { key: "tiktok", name: "TikTok", detail: "Schedule & publish clips.", group: "posting", badge: "♪", color: "bg-black text-white" },
  { key: "pinterest", name: "Pinterest", detail: "Schedule pins.", group: "posting", badge: "P", color: "bg-[#e60023] text-white" },
  { key: "wordpress", name: "WordPress", detail: "Publish blog posts (WordPress.com).", group: "posting", badge: "W", color: "bg-[#21759b] text-white" },
  { key: "wordpress_self", name: "WordPress (Self-Hosted)", detail: "Publish to your own WP site.", group: "posting", badge: "W", color: "bg-ink-700 text-white" },
  { key: "reddit", name: "Reddit", detail: "Post to subreddits.", group: "posting", badge: "r", color: "bg-[#ff4500] text-white" },
  { key: "threads", name: "Threads", detail: "Publish to Threads.", group: "posting", badge: "@", color: "bg-black text-white" },

  // Channel data & setup
  { key: "shopify", name: "Shopify", detail: "Store orders & customers.", group: "data", badge: "S", color: "bg-[#95bf47] text-white" },
  { key: "google_analytics", name: "Google Analytics", detail: "Website traffic & conversions (GA4).", group: "data", badge: "GA", color: "bg-[#e8710a] text-white", oauth: "google" },
  { key: "google_search_console", name: "Google Search Console", detail: "Rankings, clicks & impressions.", group: "data", badge: "SC", color: "bg-[#4285f4] text-white", oauth: "google" },
  { key: "google_business", name: "Google Business Profile", detail: "Reviews, calls & map listing.", group: "data", badge: "GB", color: "bg-[#4285f4] text-white", oauth: "google" },
  { key: "google_ads", name: "Google Ads", detail: "Campaign spend & performance.", group: "data", badge: "Ad", color: "bg-[#fbbc04] text-ink-900", oauth: "google" },
  { key: "google_drive", name: "Google Drive", detail: "Pull documents into agent knowledge.", group: "data", badge: "Dr", color: "bg-[#1fa463] text-white", oauth: "google" },
  { key: "google_calendar", name: "Google Calendar", detail: "Mirror booked appointments.", group: "data", badge: "Ca", color: "bg-[#4285f4] text-white", oauth: "google" },
  { key: "google_gmail", name: "Gmail", detail: "Send patient emails from the clinic's Gmail.", group: "data", badge: "Gm", color: "bg-[#ea4335] text-white", oauth: "google" },
  { key: "tiktok_ads", name: "TikTok Ads", detail: "TikTok ad campaign data.", group: "data", badge: "♪", color: "bg-black text-white" },
  { key: "stripe", name: "Stripe", detail: "Payments & subscriptions.", group: "data", badge: "S", color: "bg-[#635bff] text-white" },
  { key: "notion", name: "Notion", detail: "Sync notes & docs.", group: "data", badge: "N", color: "bg-black text-white" },
  { key: "brevo", name: "Brevo", detail: "Send patient emails & newsletters (recommended).", group: "data", badge: "B", color: "bg-[#0b996e] text-white", apiKey: true },
  { key: "mailchimp", name: "Mailchimp", detail: "Email campaigns & audiences.", group: "data", badge: "M", color: "bg-[#ffe01b] text-ink-900", apiKey: true },
  { key: "twilio", name: "Twilio SMS", detail: "Send single texts from your own Twilio number.", group: "data", badge: "Tw", color: "bg-[#f22f46] text-white" },
];

// Catalog keys that are Google products (use the Google OAuth flow).
const GOOGLE_KEYS = new Set(["google_analytics", "google_search_console", "google_business", "google_ads", "google_drive", "google_calendar", "google_gmail", "youtube"]);

export function IntegrationsPanel() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [googleReady, setGoogleReady] = useState<boolean | null>(null);
  const [genericReady, setGenericReady] = useState<Record<string, boolean>>({});
  const [ws, setWs] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [setupFor, setSetupFor] = useState<Provider | null>(null);
  const [apiKeyFor, setApiKeyFor] = useState<Provider | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<Provider | null>(null);
  const [wpSelfOpen, setWpSelfOpen] = useState(false);
  const [twilioOpen, setTwilioOpen] = useState(false);

  const refresh = useCallback(() => {
    fetchConnections().then(setConnections);
  }, []);

  useEffect(() => {
    refresh();
    getWorkspaceId().then(setWs);
    fetch("/api/health").then((r) => r.json()).then((h) => setGoogleReady(!!h.google)).catch(() => setGoogleReady(false));
    fetch("/api/oauth/configured").then((r) => r.json()).then((d) => setGenericReady(d.configured ?? {})).catch(() => setGenericReady({}));
  }, [refresh]);

  // Open a popup OAuth window and refresh when it closes / messages back.
  function openPopup(url: string, key: string) {
    setBusy(key);
    const popup = window.open(url, "pydent-oauth", "width=520,height=680");
    if (!popup) { window.location.assign(url.replace("&popup=1", "")); return; }
    const timer = setInterval(() => {
      if (popup.closed) { clearInterval(timer); setBusy(null); refresh(); }
    }, 800);
  }

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

  function connect(p: Provider) {
    if (!ws) { toast("Sign in first.", "info"); return; }
    // Self-hosted WordPress uses a form (site URL + application password), not OAuth.
    if (p.key === "wordpress_self") { setWpSelfOpen(true); return; }
    // Twilio needs a bespoke 3-field form (SID + token + from number).
    if (p.key === "twilio") { setTwilioOpen(true); return; }
    // Google products (incl. YouTube) use the Google OAuth flow.
    if (GOOGLE_KEYS.has(p.key)) {
      if (!googleReady) { toast("Add GOOGLE_OAUTH_CLIENT_ID / SECRET in Netlify to enable Google connections.", "info"); return; }
      openPopup(`/api/google/oauth?provider=${p.key}&ws=${encodeURIComponent(ws)}&popup=1`, p.key);
      return;
    }
    // Generic OAuth2 providers (Meta, LinkedIn, Reddit, Pinterest, TikTok, WordPress…).
    if (p.key in genericReady) {
      if (!genericReady[p.key]) { setSetupFor(p); return; }
      openPopup(`/api/oauth/${p.key}?ws=${encodeURIComponent(ws)}&popup=1`, p.key);
      return;
    }
    // Key-based providers (Brevo, Mailchimp): paste the key right here, per clinic.
    if (p.apiKey) { setApiKeyFor(p); return; }
    // Special providers that need a bespoke flow — explain the setup.
    setSetupFor(p);
  }

  async function doDisconnect(p: Provider) {
    setConfirmDisconnect(null);
    setBusy(p.key);
    await disconnectConnection(p.key);
    setBusy(null);
    refresh();
    toast("Disconnected.", "success");
  }

  async function changeMode(p: Provider, mode: "read" | "write") {
    // Optimistic: update the card immediately, then persist.
    setConnections((prev) => prev.map((c) => (c.provider === p.key ? { ...c, accessMode: mode } : c)));
    await setConnectionAccessMode(p.key, mode);
  }

  const byProvider = Object.fromEntries(connections.map((c) => [c.provider, c]));
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => PROVIDERS.filter((p) => !q || p.name.toLowerCase().includes(q) || p.detail.toLowerCase().includes(q)),
    [q]
  );
  const posting = filtered.filter((p) => p.group === "posting");
  const data = filtered.filter((p) => p.group === "data");

  const grid = (items: Provider[]) => (
    <Grid items={items} byProvider={byProvider} busy={busy} onConnect={connect} onDisconnect={(p) => setConfirmDisconnect(p)} onChangeMode={changeMode} />
  );

  return (
    <div className="space-y-6">
      {wpSelfOpen && ws && (
        <WordPressSelfModal ws={ws} onClose={() => setWpSelfOpen(false)} onConnected={() => { setWpSelfOpen(false); refresh(); }} />
      )}
      {twilioOpen && ws && (
        <TwilioConnectModal ws={ws} onClose={() => setTwilioOpen(false)} onConnected={() => { setTwilioOpen(false); refresh(); }} />
      )}
      {apiKeyFor && ws && (
        <ApiKeyModal provider={apiKeyFor} ws={ws} onClose={() => setApiKeyFor(null)} onConnected={() => { setApiKeyFor(null); refresh(); }} />
      )}
      {confirmDisconnect && (
        <Modal open onClose={() => setConfirmDisconnect(null)} title={`Disconnect ${confirmDisconnect.name}?`} subtitle="The clinic will need to reconnect to use it again." z="z-[60]">
          <p className="text-sm text-ink-600">This removes the stored access for <strong>{confirmDisconnect.name}</strong>. You can reconnect any time.</p>
          <div className="mt-5 flex gap-2">
            <button onClick={() => setConfirmDisconnect(null)} className="flex-1 rounded-xl border border-ink-200 py-2.5 text-sm font-semibold text-ink-700 hover:bg-ink-50">Go back</button>
            <button onClick={() => doDisconnect(confirmDisconnect)} className="flex-1 rounded-xl bg-rose-600 py-2.5 text-sm font-semibold text-white hover:bg-rose-700">Disconnect</button>
          </div>
        </Modal>
      )}
      {setupFor && (
        <Modal open onClose={() => setSetupFor(null)} title={`Connect ${setupFor.name}`} subtitle="One-time setup">
          {setupFor.apiKey ? (
            <div className="space-y-3 text-sm text-ink-600">
              <p><strong>{setupFor.name}</strong> connects with an API key.</p>
              <ol className="ml-4 list-decimal space-y-1.5">
                <li>In {setupFor.name}, create an API key (Brevo: Settings → SMTP &amp; API → API Keys; Mailchimp: Account → Extras → API keys).</li>
                <li>Add it in Netlify as <code className="rounded bg-ink-100 px-1">{setupFor.key.toUpperCase()}_API_KEY</code>{setupFor.key === "brevo" && <> plus <code className="rounded bg-ink-100 px-1">BREVO_FROM_EMAIL</code> (a verified sender)</>}.</li>
                <li>Redeploy. Angela can then send email through it.</li>
              </ol>
              <p className="text-xs text-ink-400">Brevo runs full email &amp; SMS campaigns from the Email and SMS pages once connected. Mailchimp campaign send is next.</p>
            </div>
          ) : ["instagram", "facebook", "meta_ads"].includes(setupFor.key) ? (
            <div className="space-y-3 text-sm text-ink-600">
              <p><strong>{setupFor.name}</strong> connects with Meta (Facebook). One Meta app powers Instagram, Facebook &amp; Meta Ads. To enable it:</p>
              <ol className="ml-4 list-decimal space-y-1.5 text-ink-600">
                <li>At <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener noreferrer" className="font-medium text-brand-600 dark:text-brand-300">developers.facebook.com</a>, create a <strong>Business</strong> app and add <strong>Facebook Login</strong> + <strong>Instagram Graph API</strong>.</li>
                <li>Add the redirect URI <code className="rounded bg-ink-100 px-1">{typeof window !== "undefined" ? window.location.origin : ""}/api/oauth/{setupFor.key}/callback</code>.</li>
                <li>Put <code className="rounded bg-ink-100 px-1">FACEBOOK_CLIENT_ID</code> + <code className="rounded bg-ink-100 px-1">FACEBOOK_CLIENT_SECRET</code> in Netlify and redeploy.</li>
                <li>Make sure the clinic&apos;s Instagram is a <strong>Business/Creator</strong> account linked to a Facebook Page they admin.</li>
              </ol>
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700">
                <p className="font-semibold">Seeing &ldquo;this app isn&apos;t safe / unverified&rdquo; when connecting?</p>
                <p className="mt-1">That means the Meta app needs <strong>Business Verification + App Review</strong> (request Advanced Access for <code>instagram_content_publish</code>, <code>pages_manage_posts</code>…) and to be switched to <strong>Live</strong> mode. To test right now, add the user under <strong>App roles → Roles</strong> as a Tester/Admin, or click <strong>Advanced → Continue (unsafe)</strong>. Full guide: <code>META_INSTAGRAM_SETUP.md</code>.</p>
              </div>
            </div>
          ) : (
            <div className="space-y-3 text-sm text-ink-600">
              <p><strong>{setupFor.name}</strong> connects the same way as Google — a one-click popup — once its developer app is registered. To enable it:</p>
              <ol className="ml-4 list-decimal space-y-1.5 text-ink-600">
                <li>Create an app in the {setupFor.name} developer portal and get its Client ID / Secret.</li>
                <li>Add those as environment variables in Netlify.</li>
                <li>Add the redirect URI <code className="rounded bg-ink-100 px-1">{typeof window !== "undefined" ? window.location.origin : ""}/api/{setupFor.key}/oauth/callback</code>.</li>
              </ol>
            </div>
          )}
          <button onClick={() => setSetupFor(null)} className="mt-5 w-full rounded-xl bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700">Got it</button>
        </Modal>
      )}

      <div>
        <h2 className="text-lg font-semibold text-ink-900">Integrations</h2>
        <p className="text-sm text-ink-500">Connect your clinic&apos;s own accounts — each connection is yours, signed in via a secure popup.</p>
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search integrations…"
            className="w-full rounded-xl border border-ink-200 bg-surface py-2.5 pl-9 pr-9 text-sm text-ink-800 outline-none placeholder:text-ink-400 focus:border-brand-400"
          />
          {query && <button onClick={() => setQuery("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-600"><X className="h-4 w-4" /></button>}
        </div>
      </div>

      {googleReady === false && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Google connections need a one-time setup: create an OAuth client in Google Cloud Console, add
            <code className="mx-1 rounded bg-amber-500/15 px-1">GOOGLE_OAUTH_CLIENT_ID</code> and
            <code className="mx-1 rounded bg-amber-500/15 px-1">GOOGLE_OAUTH_CLIENT_SECRET</code> in Netlify, and add this exact
            redirect URI: <code className="rounded bg-amber-500/15 px-1">{typeof window !== "undefined" ? window.location.origin : ""}/api/google/oauth/callback</code>.
          </span>
        </div>
      )}

      {data.length > 0 && (
        <div>
          <h3 className="mb-1 text-sm font-semibold text-ink-900">Channel data &amp; setup</h3>
          <p className="mb-3 text-sm text-ink-500">Connect advertising & analytics platforms to track performance and pull data.</p>
          {grid(data)}
        </div>
      )}

      {posting.length > 0 && (
        <div>
          <h3 className="mb-1 text-sm font-semibold text-ink-900">Content posting</h3>
          <p className="mb-3 text-sm text-ink-500">Connect your social & content platforms to schedule and publish posts.</p>
          {grid(posting)}
        </div>
      )}

      {filtered.length === 0 && <p className="py-8 text-center text-sm text-ink-400">No integrations match &ldquo;{query}&rdquo;.</p>}
    </div>
  );
}

function Grid({
  items,
  byProvider,
  busy,
  onConnect,
  onDisconnect,
  onChangeMode,
}: {
  items: Provider[];
  byProvider: Record<string, Connection>;
  busy: string | null;
  onConnect: (p: Provider) => void;
  onDisconnect: (p: Provider) => void;
  onChangeMode: (p: Provider, mode: "read" | "write") => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {items.map((p) => {
        const conn = byProvider[p.key];
        const connected = !!conn;
        return (
          <Card key={p.key} className="flex flex-col p-4">
            <div className="flex items-start gap-3">
              <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-bold ${p.color}`}>{p.badge}</div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink-900">{p.name}</p>
                <p className="flex items-center gap-1.5 text-xs">
                  <span className={`inline-block h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-ink-300"}`} />
                  <span className={connected ? "text-emerald-600" : "text-ink-400"}>
                    {connected ? (conn.accountLabel ? `Connected · ${conn.accountLabel}` : "Connected") : "Not Connected"}
                  </span>
                </p>
              </div>
            </div>
            <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-ink-500">{p.detail}</p>
            {connected ? (
              <div className="mt-3 space-y-2">
                {/* Access mode: read-only vs read & write */}
                <div className="flex items-center justify-between rounded-lg border border-ink-100 bg-ink-50 px-2.5 py-1.5">
                  <span className="text-[11px] font-medium text-ink-500">Access</span>
                  <div className="flex rounded-md border border-ink-200 bg-surface p-0.5 text-[11px] font-semibold">
                    <button
                      onClick={() => onChangeMode(p, "read")}
                      className={`rounded px-2 py-0.5 ${conn.accessMode !== "write" ? "bg-brand-600 text-white" : "text-ink-500"}`}
                    >
                      Read-only
                    </button>
                    <button
                      onClick={() => onChangeMode(p, "write")}
                      className={`rounded px-2 py-0.5 ${conn.accessMode === "write" ? "bg-brand-600 text-white" : "text-ink-500"}`}
                    >
                      Read &amp; write
                    </button>
                  </div>
                </div>
                <div className="flex gap-2">
                  <span className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-500/15 py-2 text-xs font-semibold text-emerald-600">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Connected
                  </span>
                  <button onClick={() => onDisconnect(p)} disabled={busy === p.key} className="rounded-lg border border-ink-200 px-3 py-2 text-xs font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-50">Disconnect</button>
                </div>
              </div>
            ) : (
              <button onClick={() => onConnect(p)} disabled={busy === p.key} className="mt-3 rounded-lg border border-ink-200 py-2 text-xs font-semibold text-brand-600 hover:bg-brand-50 disabled:opacity-50 dark:text-brand-300">
                {busy === p.key ? "Connecting…" : "Connect"}
              </button>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function WordPressSelfModal({ ws, onClose, onConnected }: { ws: string; onClose: () => void; onConnected: () => void }) {
  const [siteUrl, setSiteUrl] = useState("");
  const [username, setUsername] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!siteUrl.trim() || !username.trim() || !appPassword.trim()) {
      toast("Fill in the site URL, username and application password.", "info");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/connections/wordpress-self", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: ws, siteUrl, username, appPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not connect.");
      toast("WordPress connected.", "success");
      onConnected();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not connect to WordPress.", "info");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Connect WordPress (Self-Hosted)" subtitle="Use a WordPress Application Password — no plugin needed." z="z-[60]">
      <div className="space-y-4">
        <div className="rounded-xl border border-ink-100 bg-ink-50/60 p-3 text-xs leading-relaxed text-ink-600">
          In your WordPress admin: <strong>Users → Profile → Application Passwords</strong>, type a name
          (e.g. &ldquo;Pydent&rdquo;) and click <strong>Add New Application Password</strong>. Copy the password it shows
          and paste it below. (Needs WordPress 5.6+ over HTTPS.)
        </div>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink-700">Site URL</span>
          <input className={inputCls} placeholder="https://yourclinic.com" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink-700">WordPress username</span>
          <input className={inputCls} placeholder="admin" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink-700">Application password</span>
          <input className={inputCls} placeholder="xxxx xxxx xxxx xxxx xxxx xxxx" value={appPassword} onChange={(e) => setAppPassword(e.target.value)} />
        </label>
      </div>
      <div className="mt-5 flex gap-2">
        <button onClick={onClose} className="flex-1 rounded-xl border border-ink-200 py-2.5 text-sm font-semibold text-ink-700 hover:bg-ink-50">Cancel</button>
        <button onClick={submit} disabled={saving} className="flex-1 rounded-xl bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
          {saving ? "Connecting…" : "Connect"}
        </button>
      </div>
    </Modal>
  );
}

// Per-clinic Twilio connect (3 fields: Account SID, Auth Token, From number).
function TwilioConnectModal({ ws, onClose, onConnected }: { ws: string; onClose: () => void; onConnected: () => void }) {
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [fromNumber, setFromNumber] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!accountSid.trim() || !authToken.trim() || !fromNumber.trim()) { toast("Fill in the Account SID, Auth Token and From number.", "info"); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/connections/twilio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ws, accountSid: accountSid.trim(), authToken: authToken.trim(), fromNumber: fromNumber.trim() }),
      });
      const data = await res.json();
      if (!data.ok) { toast(data.error ?? "Could not connect.", "info"); return; }
      toast("Twilio connected.", "success");
      onConnected();
    } catch {
      toast("Could not reach the server.", "info");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Connect Twilio SMS" subtitle="Use your own Twilio account for single texts." z="z-[60]">
      <div className="space-y-4">
        <div className="rounded-xl border border-ink-100 bg-ink-50/60 p-3 text-xs leading-relaxed text-ink-600">
          In the <strong>Twilio Console</strong>: copy the <strong>Account SID</strong> + <strong>Auth Token</strong> from <em>Account → API keys &amp; tokens</em>, and an active number from <em>Phone Numbers → Active numbers</em>. (Point that number&apos;s inbound webhook at <code className="rounded bg-ink-100 px-1">/api/sms/webhook</code> so replies land in the inbox.)
        </div>
        <label className="block"><span className="mb-1.5 block text-sm font-medium text-ink-700">Account SID</span>
          <input className={inputCls} placeholder="AC…" value={accountSid} onChange={(e) => setAccountSid(e.target.value)} /></label>
        <label className="block"><span className="mb-1.5 block text-sm font-medium text-ink-700">Auth Token</span>
          <input className={inputCls} type="password" placeholder="Your primary auth token" value={authToken} onChange={(e) => setAuthToken(e.target.value)} /></label>
        <label className="block"><span className="mb-1.5 block text-sm font-medium text-ink-700">From number (E.164)</span>
          <input className={inputCls} placeholder="+15551234567" value={fromNumber} onChange={(e) => setFromNumber(e.target.value)} /></label>
      </div>
      <div className="mt-5 flex gap-2">
        <button onClick={onClose} className="flex-1 rounded-xl border border-ink-200 py-2.5 text-sm font-semibold text-ink-700 hover:bg-ink-50">Cancel</button>
        <button onClick={submit} disabled={saving} className="flex-1 rounded-xl bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{saving ? "Connecting…" : "Connect"}</button>
      </div>
    </Modal>
  );
}

// Per-clinic API-key connect (Brevo, Mailchimp, …). The clinic pastes their own
// key here — stored per workspace via /api/connections/apikey. No Netlify needed.
const KEY_HELP: Record<string, { where: string; prefix?: string; sender?: boolean }> = {
  brevo: { where: "Brevo → SMTP & API → API Keys → Generate a new API key", prefix: "xkeysib-", sender: true },
  mailchimp: { where: "Mailchimp → Account → Extras → API keys → Create A Key" },
};

function ApiKeyModal({ provider, ws, onClose, onConnected }: { provider: Provider; ws: string; onClose: () => void; onConnected: () => void }) {
  const help = KEY_HELP[provider.key] ?? { where: `${provider.name} → API settings` };
  const [key, setKey] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit() {
    if (!key.trim()) { toast("Paste your API key.", "info"); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/connections/apikey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ws, provider: provider.key, apiKey: key.trim(), fromEmail: fromEmail.trim() || undefined }),
      });
      const data = await res.json();
      if (!data.ok) { toast(data.error ?? "Could not connect.", "info"); return; }
      toast(`${provider.name} connected.`, "success");
      onConnected();
    } catch {
      toast("Could not reach the server.", "info");
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal open onClose={onClose} title={`Connect ${provider.name}`} subtitle={`Create an API key in ${provider.name} and paste it below.`} z="z-[60]">
      <div className="space-y-4">
        <p className="text-sm text-ink-500">Open <strong>{help.where}</strong>{help.prefix && <>, copy the key (starts with <code className="rounded bg-ink-100 px-1">{help.prefix}</code>)</>}.</p>
        <div>
          <p className="mb-1.5 text-sm font-medium text-ink-700">API Key</p>
          <input className={inputCls} placeholder={help.prefix ? `${help.prefix}…` : "API key"} value={key} onChange={(e) => setKey(e.target.value)} />
        </div>
        {help.sender && (
          <div>
            <p className="mb-1.5 text-sm font-medium text-ink-700">Sender email (verified in {provider.name})</p>
            <input className={inputCls} placeholder="reception@yourclinic.com" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} />
          </div>
        )}
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 rounded-xl border border-ink-200 py-2.5 text-sm font-semibold text-ink-700 hover:bg-ink-50">Cancel</button>
          <button onClick={submit} disabled={saving} className="flex-1 rounded-xl bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{saving ? "Connecting…" : "Connect"}</button>
        </div>
      </div>
    </Modal>
  );
}
