"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  LayoutDashboard,
  Inbox,
  MessageCircle,
  MessageSquareText,
  Mail,
  PhoneCall,
  KanbanSquare,
  Users,
  Settings,
  Sparkles,
  Search,
  Bell,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { Avatar } from "@/components/ui";
import { ThemeToggle } from "@/components/theme";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  children?: { href: string; label: string }[];
}

const nav: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/inbox", label: "Omnichannel Inbox", icon: Inbox },
  {
    href: "/dashboard/whatsapp",
    label: "WhatsApp",
    icon: MessageCircle,
    children: [
      { href: "/dashboard/whatsapp?tab=chats", label: "Chats" },
      { href: "/dashboard/whatsapp?tab=broadcasts", label: "Broadcasts" },
      { href: "/dashboard/whatsapp?tab=bots", label: "Chatbot builder" },
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
  {
    href: "/dashboard/voice",
    label: "Voice Agents",
    icon: PhoneCall,
    children: [
      { href: "/dashboard/voice#agents", label: "Agents" },
      { href: "/dashboard/voice#call-log", label: "Call log" },
    ],
  },
  { href: "/dashboard/pipeline", label: "Pipeline", icon: KanbanSquare },
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
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentTab = searchParams.get("tab");

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
              <span className="block text-base font-semibold tracking-tight text-ink-900">Pydental</span>
              <span className="block text-[11px] font-medium text-ink-400">Bright Smile Dental</span>
            </div>
          )}
        </Link>

        <nav className="mt-2 flex-1 space-y-0.5 overflow-y-auto px-3">
          {nav.map((item) => {
            const active =
              item.href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(item.href);
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
                      const subActive = subTab !== null && (currentTab ?? "chats") === subTab;
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
            <p className="text-xs font-semibold text-brand-800 dark:text-brand-300">Demo workspace</p>
            <p className="mt-1 text-xs leading-relaxed text-brand-700 dark:text-brand-400">
              Exploring with sample clinic data. Connect OpenDental to sync your real schedule.
            </p>
            <Link
              href="/dashboard/settings"
              className="mt-2.5 inline-block rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"
            >
              Connect OpenDental
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
              <Avatar name="Dana Reyes" size="sm" />
              <div className="hidden leading-tight lg:block">
                <p className="text-sm font-medium text-ink-900">Dana Reyes</p>
                <p className="text-xs text-ink-400">Office Manager</p>
              </div>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl p-6">{children}</main>
      </div>
    </div>
  );
}
