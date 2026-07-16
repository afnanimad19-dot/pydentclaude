"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Flame, PhoneOutgoing, MessageCircle, Sparkles, Send, Check, Loader2, Pencil, RefreshCw } from "lucide-react";
import { Card, PageHeader, StatusBadge } from "@/components/ui";
import { inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import { fetchAgents, ensurePhoenixAgents, setAgentVapiId, getWorkspaceId, type AiAgent } from "@/lib/db";

// Phoenix — the clinic's OUTBOUND agent. Same brain, two bodies: it calls a list
// of numbers (voice, via Vapi) and it starts conversations (chat, via WhatsApp).
export default function PhoenixPage() {
  const [voice, setVoice] = useState<AiAgent | null>(null);
  const [chat, setChat] = useState<AiAgent | null>(null);
  const [ws, setWs] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [numbersText, setNumbersText] = useState("");
  const [fromNumber, setFromNumber] = useState("");
  const [opener, setOpener] = useState("");
  const [callingBusy, setCallingBusy] = useState(false);
  const [msgBusy, setMsgBusy] = useState(false);

  function loadAgents() {
    return fetchAgents().then((r) => {
      const v = r.agents.find((a) => a.kind === "voice" && /phoenix/i.test(a.name)) ?? null;
      const c = r.agents.find((a) => a.kind === "chat" && /phoenix/i.test(a.name)) ?? null;
      setVoice(v); setChat(c);
      if (c && !opener) setOpener(c.firstMessage || "Hi! This is Phoenix from the dental clinic — we'd love to help you book in. Is now a good time?");
      return { v, c };
    });
  }
  useEffect(() => { getWorkspaceId().then(setWs); loadAgents().finally(() => setLoading(false)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const numbers = numbersText.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);

  async function seed() {
    setSeeding(true);
    const res = await ensurePhoenixAgents();
    await loadAgents();
    setSeeding(false);
    toast(res.message, res.ok ? "success" : "info");
  }

  // Push the voice Phoenix to Vapi and store its assistant id, so it can dial.
  async function syncVoice() {
    if (!voice) return;
    setSyncing(true);
    const res = await fetch("/api/vapi/assistants", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(voice) });
    const d = await res.json().catch(() => ({}));
    if (res.ok && d.id) { await setAgentVapiId(voice.id, d.id); await loadAgents(); toast("Phoenix synced to Vapi — ready to call.", "success"); }
    else toast(d.error ?? d.message ?? "Vapi sync failed (check VAPI_API_KEY).", "info");
    setSyncing(false);
  }

  async function callList() {
    if (!voice?.vapiAssistantId) { toast("Sync Phoenix to Vapi first.", "info"); return; }
    if (!fromNumber.trim()) { toast("Enter the number to call from.", "info"); return; }
    if (numbers.length === 0) { toast("Paste the list of numbers to call.", "info"); return; }
    setCallingBusy(true);
    const res = await fetch("/api/vapi/outbound", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assistantId: voice.vapiAssistantId, fromNumber: fromNumber.trim(), numbers }) });
    const d = await res.json().catch(() => ({}));
    setCallingBusy(false);
    toast(d.message ?? d.error ?? (d.ok ? "Calls started." : "Couldn't start calls."), d.ok ? "success" : "info");
  }

  async function messageList() {
    if (!chat) { toast("Create Phoenix first.", "info"); return; }
    if (numbers.length === 0) { toast("Paste the list of numbers to message.", "info"); return; }
    if (!opener.trim()) { toast("Write the opening message.", "info"); return; }
    setMsgBusy(true);
    const res = await fetch("/api/agents/outbound-message", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ws, agentId: chat.id, numbers, message: opener.trim() }) });
    const d = await res.json().catch(() => ({}));
    setMsgBusy(false);
    toast(d.message ?? d.error ?? "Done.", d.ok ? "success" : "info");
    if (d.hint) setTimeout(() => toast(d.hint, "info"), 400);
  }

  if (loading) return <p className="py-20 text-center text-sm text-ink-500">Loading Phoenix…</p>;

  const notSetUp = !voice && !chat;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Phoenix — Outbound agent"
        subtitle="One agent, two bodies: Phoenix calls a list of numbers (voice) and starts conversations (chat). Give it a list and it reaches out for you."
      />

      {notSetUp ? (
        <Card className="p-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-500/15 text-orange-500"><Flame className="h-6 w-6" /></div>
          <p className="mt-3 font-semibold text-ink-900">Set up Phoenix in one click</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-ink-500">Creates the voice Phoenix (outbound calls) and the chat Phoenix (outbound messages), pre-configured for dental outreach. You can fine-tune their identity, instructions and knowledge afterwards.</p>
          <button onClick={seed} disabled={seeding} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
            {seeding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Create Phoenix
          </button>
        </Card>
      ) : (
        <>
          {/* Agent bodies */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <span className="rounded-xl bg-orange-500/15 p-2 text-orange-500"><PhoneOutgoing className="h-5 w-5" /></span>
                  <div><p className="font-semibold text-ink-900">Phoenix · Voice</p><p className="text-xs text-ink-400">Outbound calls via Vapi</p></div>
                </div>
                {voice ? (voice.vapiAssistantId ? <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-600"><Check className="h-3 w-3" /> Ready</span> : <StatusBadge status="Needs sync" tone="amber" />) : <StatusBadge status="Not created" tone="gray" />}
              </div>
              {voice ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {!voice.vapiAssistantId && <button onClick={syncVoice} disabled={syncing} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Sync to Vapi</button>}
                  <Link href="/dashboard/agents/voice" className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50"><Pencil className="h-3.5 w-3.5" /> Edit voice & behaviour</Link>
                </div>
              ) : <button onClick={seed} className="mt-4 text-sm font-medium text-brand-600 hover:text-brand-700">Create the voice Phoenix</button>}
            </Card>

            <Card className="p-5">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <span className="rounded-xl bg-brand-500/15 p-2 text-brand-500"><MessageCircle className="h-5 w-5" /></span>
                  <div><p className="font-semibold text-ink-900">Phoenix · Chat</p><p className="text-xs text-ink-400">Outbound WhatsApp / SMS conversations</p></div>
                </div>
                {chat ? <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-600"><Check className="h-3 w-3" /> Ready</span> : <StatusBadge status="Not created" tone="gray" />}
              </div>
              {chat ? (
                <div className="mt-4">
                  <Link href="/dashboard/agents/chat" className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50"><Pencil className="h-3.5 w-3.5" /> Edit instructions & knowledge</Link>
                </div>
              ) : <button onClick={seed} className="mt-4 text-sm font-medium text-brand-600 hover:text-brand-700">Create the chat Phoenix</button>}
            </Card>
          </div>

          {/* The list */}
          <Card className="p-5">
            <h2 className="font-semibold text-ink-900">Who should Phoenix reach out to?</h2>
            <p className="mt-1 text-sm text-ink-500">Paste phone numbers — one per line (or comma-separated), in international format (e.g. +9715…).</p>
            <textarea value={numbersText} onChange={(e) => setNumbersText(e.target.value)} rows={5} className={`${inputCls} mt-3 font-mono text-sm`} placeholder={"+971581234567\n+971509876543"} />
            <p className="mt-1 text-xs text-ink-400">{numbers.length} number{numbers.length === 1 ? "" : "s"} · up to 50 per run</p>
          </Card>

          {/* Voice launch */}
          <Card className="p-5">
            <h2 className="flex items-center gap-2 font-semibold text-ink-900"><PhoneOutgoing className="h-4 w-4 text-orange-500" /> Call the list (voice)</h2>
            <p className="mt-1 text-sm text-ink-500">Phoenix calls each number and speaks with them using its identity, instructions and knowledge — and can book on the spot.</p>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <div className="min-w-56">
                <label className="mb-1 block text-xs font-medium text-ink-600">Call from (your Vapi number)</label>
                <input value={fromNumber} onChange={(e) => setFromNumber(e.target.value)} className={inputCls} placeholder="+9714…" />
              </div>
              <button onClick={callList} disabled={callingBusy || !voice?.vapiAssistantId} className="inline-flex items-center gap-1.5 rounded-xl bg-orange-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50">
                {callingBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PhoneOutgoing className="h-4 w-4" />} Start calls
              </button>
            </div>
            {!voice?.vapiAssistantId && <p className="mt-2 text-xs text-amber-600">Sync Phoenix to Vapi (above) and add the number in Voice Agents → Phone Numbers first.</p>}
          </Card>

          {/* Message launch */}
          <Card className="p-5">
            <h2 className="flex items-center gap-2 font-semibold text-ink-900"><MessageCircle className="h-4 w-4 text-brand-500" /> Message the list (chat)</h2>
            <p className="mt-1 text-sm text-ink-500">Phoenix sends this opener, then handles every reply automatically using its brain.</p>
            <textarea value={opener} onChange={(e) => setOpener(e.target.value)} rows={3} className={`${inputCls} mt-3`} placeholder="Hi! This is Phoenix from the clinic…" />
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-xs text-ink-400">Free-form WhatsApp only reaches people who messaged you in the last 24h; cold outreach needs an approved template.</p>
              <button onClick={messageList} disabled={msgBusy} className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
                {msgBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send messages
              </button>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
