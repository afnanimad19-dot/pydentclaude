"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, MessageCircle, Copy, Check, ExternalLink } from "lucide-react";
import { Card, PageHeader, StatusBadge } from "@/components/ui";
import { Field, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import { fetchWhatsappConfig, saveWhatsappConfig, emptyWhatsappConfig, type WhatsappConfig } from "@/lib/db";

const SETUP_STEPS = [
  { title: "Create a Meta app", body: "At developers.facebook.com → My Apps → Create App (Business type). Add the WhatsApp product." },
  { title: "Link your business", body: "In WhatsApp → Setup, connect your Meta Business account and add/verify the clinic phone number." },
  { title: "Get API credentials", body: "WhatsApp → API Setup: copy the Phone Number ID and WhatsApp Business Account ID. Generate a permanent Access Token from Business Settings → System Users." },
  { title: "Configure the webhook", body: "WhatsApp → Configuration → Edit. Paste the Webhook Callback URL below, enter the same Verify Token you set here, and subscribe to the “messages” field." },
  { title: "Set the two-step PIN", body: "Business Manager → WhatsApp Accounts → Phone Numbers → Two-step verification. Enter that 6-digit PIN below the first time you connect a number." },
];

export default function WhatsAppConnectionPage() {
  const [cfg, setCfg] = useState<WhatsappConfig>(emptyWhatsappConfig);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("https://your-site.netlify.app/api/whatsapp/webhook");

  useEffect(() => {
    fetchWhatsappConfig().then((c) => {
      setCfg(c);
      setLoading(false);
      if (typeof window !== "undefined") setWebhookUrl(`${window.location.origin}/api/whatsapp/webhook`);
    });
  }, []);

  function set<K extends keyof WhatsappConfig>(k: K, v: WhatsappConfig[K]) {
    setCfg((c) => ({ ...c, [k]: v }));
  }

  async function save() {
    setSaving(true);
    const res = await saveWhatsappConfig(cfg);
    setSaving(false);
    toast(res.message, res.ok ? "success" : "info");
    if (res.ok) fetchWhatsappConfig().then(setCfg);
  }

  function copyWebhook() {
    navigator.clipboard?.writeText(webhookUrl);
    setCopied(true);
    toast("Webhook URL copied.");
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <>
      <Link href="/dashboard/settings" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-ink-500 hover:text-ink-900">
        <ArrowLeft className="h-4 w-4" /> Settings
      </Link>
      <PageHeader
        title="WhatsApp connection"
        subtitle="Connect your clinic's WhatsApp Business number (Meta Cloud API) to power the inbox, broadcasts and chatbots."
        actions={
          cfg.connected ? <StatusBadge status="Connected" tone="green" /> : <StatusBadge status="Not connected" tone="gray" />
        }
      />

      {loading ? (
        <p className="py-20 text-center text-sm text-ink-500">Loading…</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          {/* Credentials form */}
          <div className="space-y-6">
            <Card className="p-6">
              <h2 className="flex items-center gap-2 font-semibold text-ink-900">
                <MessageCircle className="h-5 w-5 text-emerald-500" /> API credentials
              </h2>
              <p className="mt-1 text-sm text-ink-500">From Meta → WhatsApp → API Setup. These stay private to your workspace.</p>
              <div className="mt-5 grid gap-4">
                <Field label="Display number (for your reference)">
                  <input className={inputCls} placeholder="+1 (305) 555-0100" value={cfg.displayNumber} onChange={(e) => set("displayNumber", e.target.value)} />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Phone Number ID *">
                    <input className={inputCls} placeholder="1093xxxxxxxxxxx" value={cfg.phoneNumberId} onChange={(e) => set("phoneNumberId", e.target.value)} />
                  </Field>
                  <Field label="WhatsApp Business Account ID">
                    <input className={inputCls} placeholder="1029xxxxxxxxxxx" value={cfg.wabaId} onChange={(e) => set("wabaId", e.target.value)} />
                  </Field>
                </div>
                <Field label="Permanent Access Token *">
                  <input className={inputCls} type="password" placeholder="EAAG… (stored privately)" value={cfg.accessToken} onChange={(e) => set("accessToken", e.target.value)} />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Webhook Verify Token *">
                    <input className={inputCls} placeholder="A custom string you choose" value={cfg.verifyToken} onChange={(e) => set("verifyToken", e.target.value)} />
                  </Field>
                  <Field label="Two-step verification PIN">
                    <input className={inputCls} inputMode="numeric" maxLength={6} placeholder="6-digit PIN" value={cfg.pin} onChange={(e) => set("pin", e.target.value.replace(/\D/g, "").slice(0, 6))} />
                  </Field>
                </div>
              </div>
              <div className="mt-5 flex items-center gap-3 border-t border-ink-100 pt-5">
                <button
                  onClick={save}
                  disabled={saving}
                  className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save & connect"}
                </button>
                <span className="text-xs text-ink-400">* required to route messages</span>
              </div>
            </Card>

            {/* Webhook URL */}
            <Card className="p-6">
              <h2 className="font-semibold text-ink-900">Webhook callback URL</h2>
              <p className="mt-1 text-sm text-ink-500">Paste this into Meta → WhatsApp → Configuration, with your Verify Token above.</p>
              <div className="mt-4 flex items-center gap-2">
                <code className="flex-1 truncate rounded-xl border border-ink-200 bg-ink-50 px-3.5 py-2.5 text-sm text-ink-700">{webhookUrl}</code>
                <button
                  onClick={copyWebhook}
                  className="flex items-center gap-1.5 rounded-xl border border-ink-200 px-3.5 py-2.5 text-sm font-medium text-ink-700 hover:bg-ink-50"
                >
                  {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />} {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="mt-3 text-xs text-ink-400">
                Subscribe to the <strong className="text-ink-600">messages</strong> webhook field. The platform <code>META_APP_SECRET</code> (set in Netlify) verifies each inbound request.
              </p>
            </Card>
          </div>

          {/* Setup guide */}
          <Card className="h-fit p-6">
            <h2 className="font-semibold text-ink-900">Setup guide</h2>
            <ol className="mt-4 space-y-4">
              {SETUP_STEPS.map((s, i) => (
                <li key={i} className="flex gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white">{i + 1}</span>
                  <div>
                    <p className="text-sm font-semibold text-ink-900">{s.title}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-ink-500">{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <a
              href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-5 flex items-center gap-1.5 border-t border-ink-100 pt-4 text-sm font-medium text-brand-600 hover:text-brand-700 dark:text-brand-300"
            >
              Meta Cloud API docs <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Card>
        </div>
      )}
    </>
  );
}
