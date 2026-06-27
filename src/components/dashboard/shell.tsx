"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  LayoutDashboard,
  Inbox,
  MessageCircle,
  MessageSquare,
  MessageSquareText,
  Mail,
  PhoneCall,
  Camera,
  KanbanSquare,
  Workflow,
  CalendarDays,
  Users,
  Stethoscope,
  BarChart3,
  Settings,
  Sparkles,
  Search,
  Bell,
  PanelLeftClose,
  PanelLeftOpen,
  LogOut,
} from "lucide-react";
import { Avatar } from "@/components/ui";
import { ThemeToggle } from "@/components/theme";
import { Toaster } from "@/components/toast";
import { supabase } from "@/lib/supabase";
import { clearWorkspaceCache } from "@/lib/db";
import { CLINICAL_MODULES_ENABLED } from "@/lib/features";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  children?: { href: string; label: string }[];
}

const nav: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/inbox", label: "Omnichannel Inbox", icon: Inbox },
  { href: "/dashboard/team-ai", label: "AI Team", icon: Sparkles },
  {
    href: "/dashboard/agents/chat",
    label: "Chat Agents",
    icon: MessageSquare,
    children: [
      { href: "/dashboard/agents/chat", label: "All chat agents" },
      { href: "/dashboard/agents/hub", label: "Agent Hub" },
      { href: "/dashboard/agents/learning", label: "AI Learning" },
    ],
  },
  {
    href: "/dashboard/agents/voice",
    label: "Voice Agents",
    icon: PhoneCall,
    children: [
      { href: "/dashboard/agents/voice", label: "All voice agents" },
      { href: "/dashboard/agents/phone-numbers", label: "Phone Numbers" },
      { href: "/dashboard/agents/contacts", label: "Contacts" },
      { href: "/dashboard/voice", label: "Call Logs" },
    ],
  },
  {
    href: "/dashboard/whatsapp",
    label: "WhatsApp",
    icon: MessageCircle,
    children: [
      { href: "/dashboard/whatsapp?tab=chats", label: "Chats" },
      { href: "/dashboard/whatsapp/templates", label: "Templates" },
      { href: "/dashboard/whatsapp?tab=broadcasts", label: "Broadcasts" },
      { href: "/dashboard/whatsapp?tab=bots", label: "Chatbot builder" },
      { href: "/dashboard/settings/whatsapp", label: "Connection setup" },
    ],
  },
  {
    href: "/dashboard/instagram",
    label: "Instagram",
    icon: Camera,
    children: [
      { href: "/dashboard/instagram", label: "Content calendar" },
    ],
  },
  {
    href: "/dashboard/sms",
    label: "SMS",
    icon: MessageSquareText,
    children: [
      { href: "/dashboard/sms#conversations", label: "Conversations" },
      { href: "/dashboard/sms#templates", label: "Templates" },
    ],
  },
  {
    href: "/dashboard/email",
    label: "Email",
    icon: Mail,
    children: [
      { href: "/dashboard/email#campaigns", label: "Campaigns" },
      { href: "/dashboard/email#automations", label: "Automations" },
    ],
  },
  { href: "/dashboard/pipeline", label: "Pipeline", icon: KanbanSquare },
  {
    href: "/dashboard/workflows",
    label: "Workflows",
    icon: Workflow,
    children: [
      { href: "/dashboard/workflows", label: "My workflows" },
      { href: "/dashboard/workflows/builder", label: "Canvas builder" },
    ],
  },
  { href: "/dashboard/calendar", label: "Calendar", icon: CalendarDays },
  {
    href: "/dashboard/patients",
    label: "Patients",
    icon: Users,
    children: [
      { href: "/dashboard/patients", label: "Roster" },
      { href: "/dashboard/patients#appointments", label: "Appointments" },
      { href: "/dashboard/patients#recall", label: "Recall worklist" },
    ],
  },
  {
    href: "/dashboard/clinical",
    label: "Patient chart",
    icon: Stethoscope,
    children: [
      { href: "/dashboard/clinical", label: "Tooth chart" },
      { href: "/dashboard/clinical/ledger", label: "Account / Ledger" },
      { href: "/dashboard/clinical/claims", label: "Insurance claims" },
      { href: "/dashboard/clinical/rx", label: "Prescriptions" },
    ],
  },
  {
    href: "/dashboard/reports",
    label: "Reports",
    icon: BarChart3,
    children: [
      { href: "/dashboard/reports", label: "Practice analytics" },
      { href: "/dashboard/reports#production", label: "Production" },
      { href: "/dashboard/reports#channels", label: "Channels & agents" },
    ],
  },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentTab = searchParams.get("tab");

  // Reset the cached workspace whenever the signed-in user changes.
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange(() => clearWorkspaceCache());
    return () => sub.subscription.unsubscribe();
  }, []);

  // Auth guard: the dashboard requires a logged-in clinic account.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        setUserEmail(data.session.user.email ?? null);
        return;
      }
      router.replace("/login");
    });
  }, [router]);

  async function signOut() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-20 flex flex-col border-r border-ink-200 bg-surface transition-all duration-200 ${
          open ? "w-60" : "w-[68px]"
        }`}
      >
        <Link href="/" className={`flex items-center gap-2.5 py-5 ${open ? "px-5" : "justify-center px-2"}`}>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-white">
            <Sparkles className="h-5 w-5" />
          </div>
          {open && (
            <div className="leading-tight">
              <span className="block text-base font-semibold tracking-tight text-ink-900">Pydent</span>
              <span className="block text-[11px] font-medium text-ink-400">Bright Smile Dental</span>
            </div>
          )}
        </Link>

        <nav className="mt-2 flex-1 space-y-0.5 overflow-y-auto px-3">
          {nav
            .filter((item) => CLINICAL_MODULES_ENABLED || item.href !== "/dashboard/clinical")
            .map((item) => {
            const childPaths = (item.children ?? []).map((c) => c.href.split(/[?#]/)[0]);
            const matches = (p: string) => pathname === p || pathname.startsWith(p + "/");
            const active =
              item.href === "/dashboard"
                ? pathname === "/dashboard"
                : matches(item.href) || childPaths.some(matches);
            return (
              <div key={item.href}>
                <Link
                  href={item.href}
                  title={item.label}
                  className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                    active
                      ? "bg-brand-50 text-brand-600 dark:text-brand-300"
                      : "text-ink-600 hover:bg-ink-50 hover:text-ink-900"
                  } ${!open && "justify-center"}`}
                >
                  <item.icon className={`h-[18px] w-[18px] shrink-0 ${active ? "" : "text-ink-400"}`} />
                  {open && item.label}
                </Link>
                {open && active && item.children && (
                  <div className="ml-[26px] mt-0.5 space-y-0.5 border-l border-ink-200 pl-3">
                    {item.children.map((sub) => {
                      const subTab = sub.href.includes("?tab=") ? sub.href.split("?tab=")[1] : null;
                      const subPath = sub.href.split(/[?#]/)[0];
                      const subActive = subTab !== null
                        ? pathname === subPath && (currentTab ?? "chats") === subTab
                        : pathname === subPath && !sub.href.includes("#");
                      return (
                        <Link
                          key={sub.href}
                          href={sub.href}
                          className={`block rounded-lg px-2.5 py-1.5 text-[13px] transition-colors ${
                            subActive
                              ? "font-medium text-brand-600 dark:text-brand-300"
                              : "text-ink-500 hover:bg-ink-50 hover:text-ink-900"
                          }`}
                        >
                          {sub.label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {open && (
          <div className="m-3 rounded-xl border border-brand-200 bg-brand-50 p-3.5">
            <p className="text-xs font-semibold text-brand-800 dark:text-brand-300">Bright Smile Dental</p>
            <p className="mt-1 text-xs leading-relaxed text-brand-700 dark:text-brand-400">
              Your full practice workspace — patients, schedule, agents and channels in one place.
            </p>
            <Link
              href="/dashboard/settings"
              className="mt-2.5 inline-block rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"
            >
              Workspace settings
            </Link>
          </div>
        )}
      </aside>

      {/* Main */}
      <div className={`transition-all duration-200 ${open ? "pl-60" : "pl-[68px]"}`}>
        <header className="sticky top-0 z-10 flex h-16 items-center justify-between gap-4 border-b border-ink-200 bg-surface/80 px-6 backdrop-blur">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setOpen(!open)}
              title={open ? "Collapse sidebar" : "Expand sidebar"}
              className="rounded-xl p-2 text-ink-500 hover:bg-ink-50"
            >
              {open ? <PanelLeftClose className="h-5 w-5" /> : <PanelLeftOpen className="h-5 w-5" />}
            </button>
            <div className="flex w-full max-w-md items-center gap-2 rounded-xl border border-ink-200 bg-ink-50 px-3 py-2">
              <Search className="h-4 w-4 text-ink-400" />
              <input
                placeholder="Search patients, conversations, appointments…"
                className="w-full bg-transparent text-sm text-ink-800 outline-none placeholder:text-ink-400 md:w-72"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button className="relative rounded-xl p-2 text-ink-500 hover:bg-ink-50">
              <Bell className="h-5 w-5" />
              <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-brand-500" />
            </button>
            <div className="ml-2 flex items-center gap-2.5">
              <Avatar name={userEmail ?? "Demo User"} size="sm" />
              <div className="hidden leading-tight lg:block">
                <p className="max-w-[160px] truncate text-sm font-medium text-ink-900">
                  {userEmail ?? "Demo mode"}
                </p>
                <p className="text-xs text-ink-400">{userEmail ? "Clinic account" : "Not signed in"}</p>
              </div>
              <button
                onClick={signOut}
                title="Sign out"
                className="rounded-xl p-2 text-ink-500 hover:bg-ink-50"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        </header>
        <main className="w-full px-5 py-5">{children}</main>
        <Toaster />
      </div>
    </div>
  );
}
