"use client";

import { useState } from "react";
import {
  Database,
  MessageCircle,
  MessageSquareText,
  Mail,
  PhoneCall,
  ShieldCheck,
  KeyRound,
  CheckCircle2,
  Lock,
} from "lucide-react";
import { useEffect } from "react";
import { Card, PageHeader, DemoBanner, StatusBadge } from "@/components/ui";
import { fetchPatients } from "@/lib/db";

const otherIntegrations = [
  {
    icon: MessageCircle,
    name: "WhatsApp Business",
    detail: "Meta Cloud API — two-way chat, template broadcasts, chatbot flows.",
    status: "Not connected",
  },
  {
    icon: MessageSquareText,
    name: "SMS (Twilio)",
    detail: "Reminders, confirmations and two-way texting from your clinic number.",
    status: "Not connected",
  },
  {
    icon: Mail,
    name: "Email (Resend)",
    detail: "Campaigns, automations and transactional email from your domain.",
    status: "Not connected",
  },
  {
    icon: PhoneCall,
    name: "Voice Agents (Retell AI)",
    detail: "AI receptionists on your phone line with live transcripts.",
    status: "Not connected",
  },
];

export default function SettingsPage() {
  const [developerKey, setDeveloperKey] = useState("");
  const [customerKey, setCustomerKey] = useState("");
  const [tested, setTested] = useState<null | string>(null);
  const [dbLive, setDbLive] = useState<boolean | null>(null);

  useEffect(() => {
    fetchPatients().then((r) => setDbLive(r.source === "live"));
  }, []);

  return (
    <>
      <DemoBanner context="Keys entered here are held locally for the demo — no live connection is made." />
      <PageHeader
        title="Settings"
        subtitle="Connect your practice systems and channels. Everything works in demo mode until you flip the switch."
      />

      {/* Supabase database */}
      <Card className="mb-6 flex flex-wrap items-center justify-between gap-4 p-6">
        <div className="flex items-start gap-4">
          <div className="rounded-xl bg-emerald-500/15 p-3 text-emerald-600">
            <Database className="h-6 w-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-ink-900">Database (Supabase)</h2>
              {dbLive === null ? (
                <StatusBadge status="Checking…" tone="gray" />
              ) : dbLive ? (
                <StatusBadge status="Connected" tone="green" />
              ) : (
                <StatusBadge status="Schema not installed" tone="amber" />
              )}
            </div>
            <p className="mt-1 max-w-xl text-sm leading-relaxed text-ink-500">
              {dbLive
                ? "Patients, appointments, treatment plans, documents, insurance and payments are stored in your Supabase project."
                : "Run supabase/migrations/0001_init.sql in the Supabase SQL Editor to create the tables and sample data."}
            </p>
          </div>
        </div>
      </Card>

      {/* OpenDental */}
      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="rounded-xl bg-brand-50 p-3 text-brand-600">
              <Database className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-ink-900">OpenDental</h2>
                <StatusBadge status="Demo mode" tone="blue" />
              </div>
              <p className="mt-1 max-w-xl text-sm leading-relaxed text-ink-500">
                Connect your clinic&apos;s OpenDental API key to sync patients, appointments,
                recall lists and treatment plans. OpenDental stays your system of record —
                Pydental is the conversation layer on top.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-ink-700">
              <KeyRound className="h-4 w-4 text-ink-400" /> Developer key
            </span>
            <input
              type="password"
              value={developerKey}
              onChange={(e) => setDeveloperKey(e.target.value)}
              placeholder="ODDevKey…"
              className="w-full rounded-xl border border-ink-200 bg-surface px-3.5 py-2.5 text-sm outline-none placeholder:text-ink-300 focus:border-brand-400"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-ink-700">
              <KeyRound className="h-4 w-4 text-ink-400" /> Customer key
            </span>
            <input
              type="password"
              value={customerKey}
              onChange={(e) => setCustomerKey(e.target.value)}
              placeholder="ODCustKey…"
              className="w-full rounded-xl border border-ink-200 bg-surface px-3.5 py-2.5 text-sm outline-none placeholder:text-ink-300 focus:border-brand-400"
            />
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            onClick={() =>
              setTested(
                developerKey && customerKey
                  ? "Demo mode — keys look well-formed. Live connection testing is disabled in this build."
                  : "Enter both keys to test the connection."
              )
            }
            className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
          >
            Test connection
          </button>
          <button className="cursor-not-allowed rounded-xl border border-ink-200 px-4 py-2.5 text-sm font-semibold text-ink-400" disabled>
            <span className="flex items-center gap-1.5">
              <Lock className="h-4 w-4" /> Go live (disabled in demo)
            </span>
          </button>
          {tested && <p className="text-sm text-ink-500">{tested}</p>}
        </div>

        <div className="mt-6 rounded-xl border border-ink-200 bg-ink-50 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-ink-800">
            <ShieldCheck className="h-4 w-4 text-emerald-600" /> Safety model
          </p>
          <ul className="mt-2 space-y-1.5 text-sm text-ink-600">
            {[
              "Phase 1 — Read-only: patients, appointments, recalls and treatment plans sync in. Nothing is ever written back.",
              "Phase 2 — Opt-in writes: appointment booking, confirmations and commlogs, enabled per clinic, per action.",
              "Your data stays yours: disconnect anytime; OpenDental remains untouched as the system of record.",
            ].map((t) => (
              <li key={t} className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" /> {t}
              </li>
            ))}
          </ul>
        </div>
      </Card>

      {/* Channel integrations */}
      <h2 className="mb-4 mt-8 text-lg font-semibold text-ink-900">Channels</h2>
      <div className="grid gap-4 md:grid-cols-2">
        {otherIntegrations.map((i) => (
          <Card key={i.name} className="flex items-start justify-between gap-4 p-5">
            <div className="flex items-start gap-3.5">
              <div className="rounded-xl bg-ink-100 p-2.5 text-ink-600">
                <i.icon className="h-5 w-5" />
              </div>
              <div>
                <p className="font-semibold text-ink-900">{i.name}</p>
                <p className="mt-0.5 text-sm text-ink-500">{i.detail}</p>
              </div>
            </div>
            <button className="shrink-0 rounded-xl border border-ink-200 px-3.5 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50">
              Connect
            </button>
          </Card>
        ))}
      </div>
    </>
  );
}
