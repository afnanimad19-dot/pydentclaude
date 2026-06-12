"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Database,
  MessageCircle,
  MessageSquareText,
  Mail,
  PhoneCall,
  CalendarDays,
  Bot,
  ArrowDownToLine,
} from "lucide-react";
import { Card, PageHeader, StatusBadge } from "@/components/ui";
import { fetchPatients } from "@/lib/db";
import { toast } from "@/components/toast";

const channelIntegrations = [
  {
    icon: MessageCircle,
    name: "WhatsApp Business",
    detail: "Meta Cloud API — two-way chat, template broadcasts, chatbot flows.",
  },
  {
    icon: MessageSquareText,
    name: "SMS (Twilio)",
    detail: "Reminders, confirmations and two-way texting from your clinic number.",
  },
  {
    icon: Mail,
    name: "Email (Resend)",
    detail: "Campaigns, automations and transactional email from your domain.",
  },
];

function ConnCard({
  icon: Icon,
  name,
  detail,
  badge,
  action,
}: {
  icon: typeof Database;
  name: string;
  detail: string;
  badge: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
      <div className="flex items-start gap-3.5">
        <div className="rounded-xl bg-ink-100 p-2.5 text-ink-600">
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <p className="font-semibold text-ink-900">{name}</p>
            {badge}
          </div>
          <p className="mt-0.5 max-w-xl text-sm text-ink-500">{detail}</p>
        </div>
      </div>
      {action}
    </Card>
  );
}

export default function SettingsPage() {
  const searchParams = useSearchParams();
  const googleStatus = searchParams.get("google");
  const [dbLive, setDbLive] = useState<boolean | null>(null);
  const [health, setHealth] = useState<{ openrouter: boolean; vapi: boolean; google: boolean } | null>(null);

  useEffect(() => {
    fetchPatients().then((r) => setDbLive(r.source === "live"));
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ openrouter: false, vapi: false, google: false }));
  }, []);

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Your workspace connections — database, AI, calendar and messaging channels."
      />

      {googleStatus && (
        <div
          className={`mb-6 rounded-xl border px-4 py-2.5 text-sm ${
            googleStatus === "connected"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
              : "border-amber-500/30 bg-amber-500/10 text-amber-600"
          }`}
        >
          {googleStatus === "connected" && "Google Calendar connected — new appointments will be mirrored to your calendar."}
          {googleStatus === "token_ok_no_storage" &&
            "Google authorized! To finish, add SUPABASE_SERVICE_ROLE_KEY to the server environment so the connection can be stored, then connect again."}
          {googleStatus === "denied" && "Google connection was cancelled."}
          {(googleStatus === "error" || googleStatus === "unconfigured") &&
            "Google connection failed — check the OAuth credentials and redirect URI."}
        </div>
      )}

      <div className="space-y-4">
        <ConnCard
          icon={Database}
          name="Database (Supabase)"
          detail="Patients, appointments, treatment plans, documents, insurance, payments and AI agents — your clinic's own practice database."
          badge={
            dbLive === null ? (
              <StatusBadge status="Checking…" tone="gray" />
            ) : dbLive ? (
              <StatusBadge status="Connected" tone="green" />
            ) : (
              <StatusBadge status="Schema missing" tone="amber" />
            )
          }
        />

        <ConnCard
          icon={Bot}
          name="AI Brain (chat agents)"
          detail="Powers every chat agent's replies — choose the model per agent (GPT-4o, Claude, Gemini, Llama)."
          badge={
            health === null ? (
              <StatusBadge status="Checking…" tone="gray" />
            ) : health.openrouter ? (
              <StatusBadge status="Connected" tone="green" />
            ) : (
              <StatusBadge status="Add OPENROUTER_API_KEY" tone="amber" />
            )
          }
        />

        <ConnCard
          icon={PhoneCall}
          name="Voice Agents (Vapi)"
          detail="Runs your phone agents — calls, transcription and voices come from Vapi; you adjust everything here."
          badge={
            health === null ? (
              <StatusBadge status="Checking…" tone="gray" />
            ) : health.vapi ? (
              <StatusBadge status="Key configured" tone="green" />
            ) : (
              <StatusBadge status="Add VAPI_API_KEY (private key)" tone="amber" />
            )
          }
        />

        <ConnCard
          icon={CalendarDays}
          name="Google Calendar"
          detail="Mirror every booked appointment to the clinic's Google Calendar."
          badge={
            health === null ? (
              <StatusBadge status="Checking…" tone="gray" />
            ) : health.google ? (
              <StatusBadge status="Ready to connect" tone="blue" />
            ) : (
              <StatusBadge status="Add OAuth env vars" tone="amber" />
            )
          }
          action={
            <a
              href="/api/google/oauth"
              className="shrink-0 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              Connect Google Calendar
            </a>
          }
        />

        <ConnCard
          icon={ArrowDownToLine}
          name="OpenDental import"
          detail="Coming later: clinics that use OpenDental will import their patient structure here with one click — no risk to their live database. Pydental works fully standalone without it."
          badge={<StatusBadge status="Planned" tone="gray" />}
        />
      </div>

      <h2 className="mb-4 mt-8 text-lg font-semibold text-ink-900">Messaging channels</h2>
      <div className="grid gap-4 md:grid-cols-2">
        {channelIntegrations.map((i) => (
          <ConnCard
            key={i.name}
            icon={i.icon}
            name={i.name}
            detail={i.detail}
            badge={<StatusBadge status="Not connected" tone="gray" />}
            action={
              <button
                onClick={() => toast(`${i.name}: the guided connection wizard ships with the channel-webhook update — your platform keys are already configured.`, "info")}
                className="shrink-0 rounded-xl border border-ink-200 px-3.5 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
              >
                Connect
              </button>
            }
          />
        ))}
      </div>
    </>
  );
}
