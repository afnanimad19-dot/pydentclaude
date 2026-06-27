"use client";

import { useState } from "react";
import { MessageSquareText, Send, Info } from "lucide-react";
import { Card, PageHeader, LiveBanner } from "@/components/ui";
import { Field, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";

// Quick-start texts the front desk can drop into the composer.
const QUICK = [
  "Reminder: your appointment is tomorrow. Reply C to confirm or R to reschedule.",
  "We missed you today! Want to grab a new time? Reply YES and we'll find you a slot.",
  "Hi! It's been a while since your last cleaning — we have openings this week. Reply YES to book.",
];

export default function SmsPage() {
  const [to, setTo] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    if (!to.trim()) { toast("Enter a recipient number.", "info"); return; }
    setSending(true);
    try {
      const res = await fetch("/api/sms/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: to.trim(), body }),
      });
      const data = await res.json();
      toast(data.message, data.ok ? "success" : "info");
      if (data.ok) { setTo(""); setBody(""); }
    } catch {
      toast("Could not reach the SMS service.", "info");
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <LiveBanner context="SMS sends through Twilio. Inbound texts land in the Omnichannel Inbox automatically (point your Twilio number's webhook at /api/sms/webhook)." />
      <PageHeader title="SMS" subtitle="Reminders, confirmations and recovery texts patients actually answer." />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="p-6 lg:col-span-2">
          <h2 className="mb-4 flex items-center gap-2 font-semibold text-ink-900"><MessageSquareText className="h-4 w-4 text-brand-500" /> Send a text</h2>
          <div className="space-y-4">
            <Field label="To (E.164, e.g. +9715…)"><input className={inputCls} placeholder="+971501234567" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            <Field label="Message">
              <textarea rows={5} className={inputCls} maxLength={1500} placeholder="Hi! Your appointment is tomorrow at 4 PM…" value={body} onChange={(e) => setBody(e.target.value)} />
            </Field>
            <div className="flex flex-wrap gap-2">
              {QUICK.map((q, i) => (
                <button key={i} onClick={() => setBody(q)} className="rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs text-ink-600 hover:bg-ink-50">{q.slice(0, 32)}…</button>
              ))}
            </div>
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
          <h2 className="mb-3 flex items-center gap-2 font-semibold text-ink-900"><Info className="h-4 w-4 text-brand-500" /> Connect SMS</h2>
          <ul className="space-y-2.5 text-sm text-ink-600">
            <li>• Add <code>TWILIO_ACCOUNT_SID</code>, <code>TWILIO_AUTH_TOKEN</code> and <code>TWILIO_FROM_NUMBER</code> in Netlify.</li>
            <li>• In Twilio, set your number&apos;s inbound webhook to <code>/api/sms/webhook</code> — replies appear in the inbox.</li>
            <li>• Replies are captured as contacts automatically (source: SMS).</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
