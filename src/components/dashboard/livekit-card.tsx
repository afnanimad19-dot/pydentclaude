"use client";

import { useEffect, useState } from "react";
import { Radio, CheckCircle2, AlertTriangle, Copy, Check } from "lucide-react";
import { Card } from "@/components/ui";
import { Field, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import { fetchLivekitConfig, saveLivekitConfig, getWorkspaceId, emptyLivekitConfig, type LivekitConfig } from "@/lib/db";

// Settings → Connections: the clinic's LiveKit Cloud project. Paste the values
// LiveKit shows when you create an API key (WebSocket URL, API key, API
// secret). The secret is write-only. "Test connection" proves the credentials
// work and shows the SIP domain carriers dial into + the worker agent name.
function CopyChip({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* blocked */ } }}
      className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 bg-ink-50 px-2 py-1 font-mono text-[11px] text-ink-700 hover:border-brand-400"
    >
      <span className="truncate">{text}</span>
      {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3 text-ink-400" />}
    </button>
  );
}

export function LivekitCard() {
  const [cfg, setCfg] = useState<LivekitConfig>(emptyLivekitConfig);
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{
    ok: boolean; rooms?: number; sipDomain?: string; agentName?: string; workerToken?: boolean; source?: string; error?: string;
    agents?: { agentId: string; agentName: string; version: string; status: string; deployedAt: string | null }[];
    agentsError?: string; workerDeployed?: boolean;
  } | null>(null);

  useEffect(() => { fetchLivekitConfig().then(setCfg); }, []);

  async function save() {
    setSaving(true);
    const res = await saveLivekitConfig({ url: cfg.url, apiKey: cfg.apiKey, apiSecret: secret, agentName: cfg.agentName, enabled: cfg.enabled });
    setSaving(false);
    toast(res.message, res.ok ? "success" : "info");
    if (res.ok) { setSecret(""); fetchLivekitConfig().then(setCfg); }
  }

  async function test() {
    setTesting(true);
    setStatus(null);
    try {
      const ws = await getWorkspaceId();
      const res = await fetch("/api/livekit/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ws }) });
      setStatus(await res.json());
    } catch (e) {
      setStatus({ ok: false, error: e instanceof Error ? e.message : "test failed" });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-semibold text-ink-900">
          <Radio className="h-5 w-5 text-brand-500" /> LiveKit
        </h2>
        {cfg.apiSecretSet && cfg.url && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-600"><CheckCircle2 className="h-3 w-3" /> Configured</span>
        )}
      </div>
      <p className="mt-1 max-w-2xl text-sm text-ink-500">
        Paste the values LiveKit Cloud shows when you create an API key (Settings → API keys). Your voice agents, test calls,
        SIP phone numbers and call logs run on this project when LiveKit is the selected voice engine.
      </p>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Field label="WebSocket URL (LIVEKIT_URL)">
          <input className={inputCls} placeholder="wss://your-project.livekit.cloud" value={cfg.url} onChange={(e) => setCfg({ ...cfg, url: e.target.value })} />
        </Field>
        <Field label="Agent name (the deployed Pydent worker)">
          <input className={inputCls} placeholder="pydent-agent" value={cfg.agentName} onChange={(e) => setCfg({ ...cfg, agentName: e.target.value })} />
        </Field>
        <Field label="API key (LIVEKIT_API_KEY)">
          <input className={inputCls} placeholder="APIxxxxxxxx" value={cfg.apiKey} onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })} />
        </Field>
        <Field label={cfg.apiSecretSet ? "API secret (saved — leave blank to keep)" : "API secret (LIVEKIT_API_SECRET)"}>
          <input type="password" className={inputCls} placeholder={cfg.apiSecretSet ? "••••••••••••" : "paste the secret"} value={secret} onChange={(e) => setSecret(e.target.value)} />
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button onClick={save} disabled={saving} className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">{saving ? "Saving…" : "Save"}</button>
        <button onClick={test} disabled={testing} className="rounded-xl border border-brand-300 px-4 py-2 text-sm font-semibold text-brand-600 hover:bg-brand-50 disabled:opacity-60">{testing ? "Testing…" : "Test connection"}</button>
      </div>

      {status && (
        <div className={`mt-4 rounded-xl border p-3 text-xs ${status.ok ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700" : "border-amber-500/30 bg-amber-500/5 text-amber-700"}`}>
          {status.ok ? (
            <div className="space-y-1.5">
              <p className="flex items-center gap-1.5 font-semibold"><CheckCircle2 className="h-4 w-4" /> Connected to LiveKit ({status.source === "workspace" ? "this clinic's project" : "shared project"}) — {status.rooms} active room{status.rooms === 1 ? "" : "s"}.</p>
              <p className="text-ink-600">SIP domain for phone numbers / the clinic box: {status.sipDomain ? <CopyChip text={status.sipDomain} /> : "—"}</p>
              <p className="text-ink-600">Worker agent name: <span className="font-mono">{status.agentName}</span>{status.workerToken ? "" : " — LIVEKIT_WORKER_TOKEN is not set on the server yet (needed for the worker to read agent settings)."}</p>
              <div className="mt-2 rounded-lg border border-ink-100 bg-surface p-2.5">
                <p className="mb-1 font-semibold text-ink-700">Agents deployed on this LiveKit project</p>
                {status.agentsError ? (
                  <p className="text-amber-600">Couldn&apos;t list agents — {status.agentsError}</p>
                ) : !status.agents?.length ? (
                  <p className="text-ink-500">None yet. Deploy the Pydent worker (livekit-agent/README.md) or build one in the LiveKit console.</p>
                ) : (
                  <ul className="space-y-1">
                    {status.agents.map((a) => (
                      <li key={a.agentId} className="flex items-center justify-between gap-2 text-ink-700">
                        <span className="font-mono">{a.agentName}</span>
                        <span className="text-ink-400">{a.status}{a.version ? ` · v${a.version}` : ""}{a.agentName === status.agentName ? " · Pydent worker" : " · console-built"}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {status.agents && status.agents.length > 0 && !status.workerDeployed && (
                  <p className="mt-1.5 text-amber-600">The Pydent worker &quot;{status.agentName}&quot; isn&apos;t deployed. Console-built agents still work (bind them in the agent builder); deploy the worker for per-agent model/voice control.</p>
                )}
              </div>
            </div>
          ) : (
            <p className="flex items-start gap-1.5"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {status.error}</p>
          )}
        </div>
      )}

      <p className="mt-3 text-[11px] text-ink-400">
        One-time setup: deploy the Pydent worker to your LiveKit project (livekit-agent/README.md — <span className="font-mono">lk agent create</span>), set the same
        <span className="font-mono"> LIVEKIT_WORKER_TOKEN</span> on the server, and add the webhook <span className="font-mono">/api/livekit/webhook</span> in LiveKit for live call logs.
      </p>
    </Card>
  );
}
