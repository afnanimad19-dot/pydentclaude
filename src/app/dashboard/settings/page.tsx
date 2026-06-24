"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Database,
  MessageCircle,
  MessageSquareText,
  Mail,
  PhoneCall,
  Bot,
  Camera,
  MessageSquare,
  Globe,
  AtSign,
  User,
  PlugZap,
  Tag as TagIcon,
  UsersRound,
  Palette,
  LogOut,
  Plus,
  X,
} from "lucide-react";
import { Card, PageHeader, StatusBadge } from "@/components/ui";
import { Field, inputCls } from "@/components/modal";
import { WhatsAppConfigForm } from "@/components/dashboard/whatsapp-config";
import { OpenDentalConfigCard } from "@/components/dashboard/opendental-config";
import { WebsiteConfigCard } from "@/components/dashboard/website-config";
import { IntegrationsPanel } from "@/components/dashboard/integrations-panel";
import { TeamMembersPanel } from "@/components/dashboard/team-members";
import { ThemeToggle } from "@/components/theme";
import { fetchPatients } from "@/lib/db";
import { supabase } from "@/lib/supabase";
import { toast } from "@/components/toast";

const channelIntegrations: { icon: typeof Database; name: string; detail: string; href?: string }[] = [
  { icon: MessageCircle, name: "WhatsApp Business", detail: "Meta Cloud API — connect your clinic's WhatsApp number for two-way chat, template broadcasts and chatbot flows.", href: "/dashboard/settings?tab=whatsapp" },
  { icon: Camera, name: "Instagram (Meta)", detail: "Reply to Instagram DMs straight from the inbox. Connects through your Meta app's Page token.", href: "/dashboard/settings?tab=whatsapp" },
  { icon: MessageSquare, name: "Facebook Messenger (Meta)", detail: "Connect your Facebook Page so Messenger conversations land in the same inbox. (Facebook & Meta are the same login.)", href: "/dashboard/settings?tab=whatsapp" },
  { icon: MessageSquareText, name: "SMS (Twilio)", detail: "Reminders, confirmations and two-way texting from your clinic number." },
  { icon: AtSign, name: "Gmail / Google Workspace", detail: "Connect the clinic's Gmail so patient emails sync into the inbox and replies send from your own address." },
  { icon: Mail, name: "Email campaigns (Resend)", detail: "Bulk campaigns, drip automations and transactional email sent from your verified domain." },
];

const TAB_PALETTE = ["#8b5cf6", "#22c55e", "#3b82f6", "#f59e0b", "#ec4899", "#06b6d4", "#ef4444"];
const SEED_TAGS = [
  { id: "t1", name: "New patient", color: "#3b82f6" },
  { id: "t2", name: "High value", color: "#8b5cf6" },
  { id: "t3", name: "Recall due", color: "#f59e0b" },
  { id: "t4", name: "Billing", color: "#ef4444" },
  { id: "t5", name: "VIP", color: "#22c55e" },
];

const TABS = [
  { key: "profile", label: "Profile", icon: User },
  { key: "connections", label: "Connections", icon: PlugZap },
  { key: "channels", label: "Channels", icon: MessageCircle },
  { key: "whatsapp", label: "WhatsApp config", icon: MessageCircle },
  { key: "tags", label: "Tags", icon: TagIcon },
  { key: "team", label: "Team", icon: UsersRound },
] as const;
type TabKey = (typeof TABS)[number]["key"];

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
  const router = useRouter();
  const searchParams = useSearchParams();
  const googleStatus = searchParams.get("google");
  const urlTab = searchParams.get("tab");
  const tab: TabKey = (TABS.find((t) => t.key === urlTab)?.key ?? "profile") as TabKey;
  const setTab = (t: TabKey) => router.replace(`/dashboard/settings?tab=${t}`, { scroll: false });

  const [dbLive, setDbLive] = useState<boolean | null>(null);
  const [health, setHealth] = useState<{ openrouter: boolean; vapi: boolean; google: boolean } | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("Dana Reyes");
  const [tags, setTags] = useState(SEED_TAGS);
  const [newTag, setNewTag] = useState("");

  useEffect(() => {
    fetchPatients().then((r) => setDbLive(r.source === "live"));
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => setHealth({ openrouter: false, vapi: false, google: false }));
    supabase.auth.getSession().then(({ data }) => setEmail(data.session?.user.email ?? null));
  }, []);

  function addTag() {
    if (!newTag.trim()) return;
    setTags((prev) => [...prev, { id: `t-${prev.length + 1}-${newTag.length}`, name: newTag.trim(), color: TAB_PALETTE[prev.length % TAB_PALETTE.length] }]);
    setNewTag("");
  }

  async function signOut() {
    await supabase.auth.signOut();
    try { sessionStorage.removeItem("pydental-demo"); } catch {}
    router.push("/login");
  }

  return (
    <>
      <PageHeader title="Settings" subtitle="Your profile, connections, channels and tags — everything that powers the workspace." />

      {googleStatus && (
        <div className={`mb-6 rounded-xl border px-4 py-2.5 text-sm ${googleStatus === "connected" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600" : "border-amber-500/30 bg-amber-500/10 text-amber-600"}`}>
          {googleStatus === "connected" && "Google Calendar connected — new appointments will be mirrored to your calendar."}
          {googleStatus === "token_ok_no_storage" && "Google authorized! To finish, add SUPABASE_SERVICE_ROLE_KEY to the server environment so the connection can be stored, then connect again."}
          {googleStatus === "denied" && "Google connection was cancelled."}
          {(googleStatus === "error" || googleStatus === "unconfigured") && "Google connection failed — check the OAuth credentials and redirect URI."}
        </div>
      )}

      {/* Tab bar */}
      <div className="mb-6 flex flex-wrap gap-1 rounded-xl border border-ink-200 bg-surface p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${tab === t.key ? "bg-brand-600 text-white" : "text-ink-600 hover:bg-ink-50"}`}
          >
            <t.icon className="h-4 w-4" /> {t.label}
          </button>
        ))}
      </div>

      {tab === "profile" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-6">
            <h2 className="flex items-center gap-2 font-semibold text-ink-900"><User className="h-5 w-5 text-brand-500" /> Account</h2>
            <div className="mt-5 grid gap-4">
              <Field label="Display name">
                <input className={inputCls} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </Field>
              <Field label="Email">
                <input className={`${inputCls} opacity-70`} value={email ?? "Demo mode (not signed in)"} disabled />
              </Field>
              <div className="flex items-center gap-3 border-t border-ink-100 pt-4">
                <button onClick={() => toast("Profile saved.")} className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">Save profile</button>
                <button onClick={signOut} className="flex items-center gap-1.5 rounded-xl border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50">
                  <LogOut className="h-4 w-4" /> Sign out
                </button>
              </div>
            </div>
          </Card>
          <Card className="p-6">
            <h2 className="flex items-center gap-2 font-semibold text-ink-900"><Palette className="h-5 w-5 text-brand-500" /> Appearance</h2>
            <p className="mt-1 text-sm text-ink-500">Switch between light and dark mode.</p>
            <div className="mt-5 flex items-center gap-3">
              <ThemeToggle /> <span className="text-sm text-ink-600">Toggle theme</span>
            </div>
          </Card>
        </div>
      )}

      {tab === "connections" && (
        <div className="space-y-4">
          <ConnCard
            icon={Database}
            name="Database (Supabase)"
            detail="Patients, appointments, treatment plans, documents, insurance, payments and AI agents — your clinic's own practice database."
            badge={dbLive === null ? <StatusBadge status="Checking…" tone="gray" /> : dbLive ? <StatusBadge status="Connected" tone="green" /> : <StatusBadge status="Schema missing" tone="amber" />}
          />
          <ConnCard
            icon={Bot}
            name="AI Brain (chat agents)"
            detail="Powers every chat agent's replies — choose the model per agent (GPT-4o, Claude, Gemini, Llama)."
            badge={health === null ? <StatusBadge status="Checking…" tone="gray" /> : health.openrouter ? <StatusBadge status="Connected" tone="green" /> : <StatusBadge status="Add OPENROUTER_API_KEY" tone="amber" />}
          />
          <ConnCard
            icon={PhoneCall}
            name="Voice Agents (Vapi)"
            detail="Runs your phone agents — calls, transcription and voices come from Vapi; you adjust everything here."
            badge={health === null ? <StatusBadge status="Checking…" tone="gray" /> : health.vapi ? <StatusBadge status="Key configured" tone="green" /> : <StatusBadge status="Add VAPI_API_KEY (private key)" tone="amber" />}
          />
          <IntegrationsPanel />
          <OpenDentalConfigCard />
          <WebsiteConfigCard />
        </div>
      )}

      {tab === "channels" && (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            {channelIntegrations.map((i) => (
              <ConnCard
                key={i.name}
                icon={i.icon}
                name={i.name}
                detail={i.detail}
                badge={<StatusBadge status="Not connected" tone="gray" />}
                action={
                  i.href ? (
                    <button onClick={() => setTab("whatsapp")} className="shrink-0 rounded-xl bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700">Set up</button>
                  ) : (
                    <button onClick={() => toast(`${i.name}: the guided connection wizard ships with the channel-webhook update — your platform keys are already configured.`, "info")} className="shrink-0 rounded-xl border border-ink-200 px-3.5 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50">Connect</button>
                  )
                }
              />
            ))}
          </div>
          <h2 className="mb-4 mt-8 text-lg font-semibold text-ink-900">Website &amp; widget</h2>
          <div className="space-y-4">
            <ConnCard
              icon={Globe}
              name="Website chat widget"
              detail="Drop a chat bubble on your WordPress, Wix or any website. New conversations flow into the inbox and your AI agent can answer 24/7. Paste the snippet before the closing </body> tag."
              badge={<StatusBadge status="Not connected" tone="gray" />}
              action={<button onClick={() => toast('Embed snippet copied: <script src="https://cdn.pydental.ai/widget.js" data-clinic="YOUR_CLINIC_ID"></script>', "success")} className="shrink-0 rounded-xl border border-ink-200 px-3.5 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50">Copy embed code</button>}
            />
            <ConnCard icon={Globe} name="WordPress plugin" detail="Prefer a plugin? Install the Pydent plugin on WordPress to add the widget, booking form and lead capture without touching code." badge={<StatusBadge status="Planned" tone="gray" />} />
          </div>
        </>
      )}

      {tab === "whatsapp" && (
        <>
          <div className="mb-3 text-sm text-ink-500">
            Need the standalone view? <Link href="/dashboard/settings/whatsapp" className="font-medium text-brand-600 dark:text-brand-300">Open full page →</Link>
          </div>
          <WhatsAppConfigForm />
        </>
      )}

      {tab === "tags" && (
        <Card className="p-6">
          <h2 className="flex items-center gap-2 font-semibold text-ink-900"><TagIcon className="h-5 w-5 text-brand-500" /> Tags</h2>
          <p className="mt-1 text-sm text-ink-500">Label contacts and conversations. Tags double as broadcast audience filters.</p>
          <div className="mt-5 flex flex-wrap gap-2">
            {tags.map((t) => (
              <span key={t.id} className="flex items-center gap-2 rounded-full border border-ink-200 bg-surface px-3 py-1.5 text-sm font-medium text-ink-700">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: t.color }} />
                {t.name}
                <button onClick={() => setTags((prev) => prev.filter((x) => x.id !== t.id))} className="text-ink-400 hover:text-rose-500">
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
          </div>
          <div className="mt-5 flex items-center gap-2 border-t border-ink-100 pt-5">
            <input
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addTag()}
              placeholder="New tag name…"
              className={`${inputCls} max-w-xs`}
            />
            <button onClick={addTag} className="flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700">
              <Plus className="h-4 w-4" /> Add tag
            </button>
          </div>
        </Card>
      )}

      {tab === "team" && <TeamMembersPanel />}
    </>
  );
}
