"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
} from "lucide-react";

const nav = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/inbox", label: "Omnichannel Inbox", icon: Inbox },
  { href: "/dashboard/whatsapp", label: "WhatsApp", icon: MessageCircle },
  { href: "/dashboard/sms", label: "SMS", icon: MessageSquareText },
  { href: "/dashboard/email", label: "Email", icon: Mail },
  { href: "/dashboard/voice", label: "Voice Agents", icon: PhoneCall },
  { href: "/dashboard/pipeline", label: "Pipeline", icon: KanbanSquare },
  { href: "/dashboard/patients", label: "Patients", icon: Users },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="fixed inset-y-0 left-0 z-20 flex w-60 flex-col border-r border-ink-200 bg-white">
      <Link href="/" className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-white">
          <Sparkles className="h-5 w-5" />
        </div>
        <div className="leading-tight">
          <span className="block text-base font-semibold tracking-tight text-ink-900">Pydental</span>
          <span className="block text-[11px] font-medium text-ink-400">Bright Smile Dental</span>
        </div>
      </Link>

      <nav className="mt-2 flex-1 space-y-0.5 overflow-y-auto px-3">
        {nav.map((item) => {
          const active =
            item.href === "/dashboard"
              ? pathname === "/dashboard"
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-brand-50 text-brand-700"
                  : "text-ink-600 hover:bg-ink-50 hover:text-ink-900"
              }`}
            >
              <item.icon className={`h-[18px] w-[18px] ${active ? "text-brand-600" : "text-ink-400"}`} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="m-3 rounded-xl border border-brand-200 bg-brand-50 p-3.5">
        <p className="text-xs font-semibold text-brand-800">Demo workspace</p>
        <p className="mt-1 text-xs leading-relaxed text-brand-700">
          Exploring with sample clinic data. Connect OpenDental to sync your real schedule.
        </p>
        <Link
          href="/dashboard/settings"
          className="mt-2.5 inline-block rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"
        >
          Connect OpenDental
        </Link>
      </div>
    </aside>
  );
}
