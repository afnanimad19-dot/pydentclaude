"use client";

import { useEffect, useState } from "react";
import { Mail, Send, Info } from "lucide-react";
import { Card, PageHeader, LiveBanner } from "@/components/ui";
import { Field, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import { getWorkspaceId } from "@/lib/db";
import { MarketingCampaigns } from "@/components/dashboard/marketing-campaigns";
import { NativeBroadcast } from "@/components/dashboard/native-broadcast";

export default function EmailPage() {
  const [ws, setWs] = useState<string | null>(null);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => { getWorkspaceId().then(setWs); }, []);

  async function send() {
    if (!to.trim()) { toast("Enter a recipient email.", "info"); return; }
    setSending(true);
    // Plain text → simple HTML (preserve line breaks).
    const html = `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2937">${body.replace(/\n/g, "<br>")}</div>`;
    try {
      const res = await fetch("/api/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: ws, to: to.trim(), subject, html }),
      });
      const data = await res.json();
      toast(data.message, data.ok ? "success" : "info");
      if (data.ok) { setTo(""); setSubject(""); setBody(""); }
    } catch {
      toast("Could not reach the email service.", "info");
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <LiveBanner context="Emails send through the clinic's connected Gmail (Settings → Connections → Gmail), or Brevo if configured. No sample data here — what you send is real." />
      <PageHeader title="Email" subtitle="Compose and send a patient email — recall reminders, follow-ups, promos." />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="p-6 lg:col-span-2">
          <h2 className="mb-4 flex items-center gap-2 font-semibold text-ink-900"><Mail className="h-4 w-4 text-brand-500" /> Compose</h2>
          <div className="space-y-4">
            <Field label="To"><input className={inputCls} type="email" placeholder="patient@email.com" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            <Field label="Subject"><input className={inputCls} placeholder="Time for your check-up at Bright Smile" value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
            <Field label="Message">
              <textarea rows={10} className={inputCls} placeholder={"Hi {{first_name}},\n\nIt's been a while since your last visit…"} value={body} onChange={(e) => setBody(e.target.value)} />
            </Field>
            <button
              onClick={send}
              disabled={sending}
              className="flex items-center gap-2 rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              <Send className="h-4 w-4" /> {sending ? "Sending…" : "Send now"}
            </button>
          </div>
        </Card>

        <Card className="h-fit p-6">
          <h2 className="mb-3 flex items-center gap-2 font-semibold text-ink-900"><Info className="h-4 w-4 text-brand-500" /> How sending works</h2>
          <ul className="space-y-2.5 text-sm text-ink-600">
            <li>• Connect <strong>Gmail</strong> in Settings → Connections to send from the clinic&apos;s own inbox — no extra cost.</li>
            <li>• Connect <strong>Brevo</strong> in Settings → Connections to run full email campaigns to your contact lists (below).</li>
            <li>• <strong>Angela</strong> (AI Team) can draft and send recall reminders and newsletters for you.</li>
            <li>• For bulk sends, test to one address first.</li>
          </ul>
        </Card>
      </div>

      <div className="mt-6">
        <NativeBroadcast channel="email" ws={ws} />
      </div>
      <div className="mt-6">
        <MarketingCampaigns type="email" ws={ws} />
      </div>
    </>
  );
}
