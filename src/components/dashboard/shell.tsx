"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  LayoutDashboard,
  Inbox,
  MessageCircle,
  MessageSquare,
  PhoneCall,
  Camera,
  Megaphone,
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
  ChevronsUpDown,
  Check,
  Plus,
  Building2,
} from "lucide-react";
import { Avatar } from "@/components/ui";
import { ThemeToggle } from "@/components/theme";
import { Toaster, toast } from "@/components/toast";
import { Modal, Field, ModalFooter, inputCls } from "@/components/modal";
import { supabase } from "@/lib/supabase";
import {
  clearWorkspaceCache,
  fetchWorkspaceName,
  listWorkspaces,
  createWorkspace,
  switchWorkspace,
  seedInboundReceptionist,
  saveClinicSettings,
  type WorkspaceListItem,
} from "@/lib/db";
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
  { href: "/dashboard/team-ai", label: "AI Marketing", icon: Sparkles },
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
      { href: "/dashboard/agents/settings", label: "Voice Agent Settings" },
      { href: "/dashboard/agents/campaigns", label: "Outbound Campaigns" },
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
      { href: "/dashboard/settings/whatsapp", label: "Connection setup" },
    ],
  },
  {
    href: "/dashboard/social",
    label: "Social Media",
    icon: Camera,
    children: [
      { href: "/dashboard/social", label: "Overview" },
      { href: "/dashboard/instagram", label: "Content calendar" },
      { href: "/dashboard/social/brand", label: "Brand identity" },
    ],
  },
  {
    href: "/dashboard/meta",
    label: "Ads",
    icon: Megaphone,
    children: [
      { href: "/dashboard/meta", label: "Meta Ads" },
      { href: "/dashboard/ads/google", label: "Google Ads" },
      { href: "/dashboard/ads/tiktok", label: "TikTok Ads" },
    ],
  },
  // SMS and Email tabs are hidden for launch (the pages still exist at
  // /dashboard/sms and /dashboard/email if ever needed) — re-add here to restore.
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
    label: "Contacts",
    icon: Users,
    children: [
      { href: "/dashboard/patients", label: "All contacts" },
      { href: "/dashboard/patients#appointments", label: "Appointments" },
      { href: "/dashboard/patients#recall", label: "Recall due" },
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
      { href: "/dashboard/reports", label: "Overview" },
      { href: "/dashboard/reports#analytics", label: "Google Analytics" },
      { href: "/dashboard/reports#search", label: "Search Console" },
    ],
  },
  {
    href: "/dashboard/settings",
    label: "Settings",
    icon: Settings,
    children: [
      { href: "/dashboard/settings?tab=profile", label: "Profile" },
      { href: "/dashboard/settings?tab=team", label: "Users" },
      { href: "/dashboard/settings?tab=billing", label: "Billing" },
      { href: "/dashboard/settings?tab=connections", label: "Connections" },
      { href: "/dashboard/settings?tab=channels", label: "Channels" },
      { href: "/dashboard/settings?tab=whatsapp", label: "WhatsApp config" },
      { href: "/dashboard/settings?tab=tags", label: "Tags" },
    ],
  },
];

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [clinicName, setClinicName] = useState("");
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
        fetchWorkspaceName().then(setClinicName);
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
        <Link href="/" className={`flex items-center gap-2.5 pt-5 pb-2 ${open ? "px-5" : "justify-center px-2"}`}>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-white">
            <Sparkles className="h-5 w-5" />
          </div>
          {open && (
            <div className="leading-tight">
              <span className="block text-base font-semibold tracking-tight text-ink-900">Pydent</span>
            </div>
          )}
        </Link>
        {open && <WorkspaceSwitcher currentName={clinicName} />}

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

      </aside>

      {/* Main */}
      <div className={`min-h-screen bg-background transition-all duration-200 ${open ? "pl-60" : "pl-[68px]"}`}>
        <header className="sticky top-0 z-10 flex h-16 items-center justify-between gap-4 border-b border-ink-200 bg-surface px-6">
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

// ------------------------------------------------------- workspace switcher
// One account, many clinics: a dropdown on the sidebar to jump between
// workspaces or create a new one. Each workspace is fully isolated in the
// database (its own workspace_id — patients, WhatsApp, messages, stats,
// agents), so a new one starts genuinely empty. Creating a workspace can also
// seed a ready-made inbound voice receptionist (Laura) with a knowledge base
// imported from the clinic's website.
function WorkspaceSwitcher({ currentName }: { currentName: string }) {
  const [menu, setMenu] = useState(false);
  const [list, setList] = useState<WorkspaceListItem[] | null>(null);
  const [create, setCreate] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setMenu(false); }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function openMenu() {
    setMenu((m) => !m);
    if (!list) listWorkspaces().then(setList);
  }

  async function pick(w: WorkspaceListItem) {
    setMenu(false);
    if (w.active) return;
    const res = await switchWorkspace(w.id);
    if (!res.ok) { toast(res.message, "info"); return; }
    // Full reload so every page re-reads data under the new workspace id.
    window.location.assign("/dashboard");
  }

  const active = list?.find((w) => w.active)?.name || currentName || "Your clinic";

  return (
    <div className="relative px-3 pb-2" ref={ref}>
      {create && <CreateWorkspaceModal onClose={() => setCreate(false)} />}
      <button
        onClick={openMenu}
        className="flex w-full items-center gap-2 rounded-xl border border-ink-200 bg-surface px-2.5 py-2 text-left hover:border-brand-400"
        title="Switch workspace"
      >
        <Building2 className="h-4 w-4 shrink-0 text-brand-500" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-800">{active}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-ink-400" />
      </button>
      {menu && (
        <div className="absolute left-3 right-3 z-30 mt-1 rounded-xl border border-ink-200 bg-surface py-1 shadow-lg">
          {!list ? (
            <p className="px-3 py-2 text-xs text-ink-400">Loading…</p>
          ) : (
            list.map((w) => (
              <button
                key={w.id}
                onClick={() => void pick(w)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-700 hover:bg-ink-50"
              >
                <span className="min-w-0 flex-1 truncate">{w.name}</span>
                {w.active && <Check className="h-4 w-4 shrink-0 text-brand-500" />}
              </button>
            ))
          )}
          <div className="my-1 border-t border-ink-100" />
          <button
            onClick={() => { setMenu(false); setCreate(true); }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-brand-600 hover:bg-brand-50"
          >
            <Plus className="h-4 w-4" /> Create workspace
          </button>
        </div>
      )}
    </div>
  );
}

function CreateWorkspaceModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [seedAgent, setSeedAgent] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) { toast("Give the workspace a name (e.g. the clinic's name).", "info"); return; }
    setBusy("Creating workspace…");
    const res = await createWorkspace(name);
    if (!res.ok) { setBusy(null); toast(res.message, "info"); return; }
    // A real clinic workspace starts genuinely EMPTY: no demo/sample rows, and
    // its website saved so agent builders pre-fill "Fetch site" with it.
    await saveClinicSettings({ showSampleData: false, displayName: name.trim(), ...(website.trim() ? { website: website.trim() } : {}) }).catch(() => {});
    if (seedAgent) {
      setBusy(website.trim() ? "Reading the website & creating the voice agent…" : "Creating the voice agent…");
      const seed = await seedInboundReceptionist(name, website);
      toast(seed.message, seed.ok ? "success" : "info");
    } else {
      toast("Workspace created — you're in it now.", "success");
    }
    // Fresh load: the dashboard now shows the NEW (empty) workspace only.
    window.location.assign("/dashboard");
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Create workspace"
      subtitle="A separate clinic with its own patients, inbox, WhatsApp, agents and stats — completely isolated from your other workspaces."
    >
      <div className="space-y-4">
        <Field label="Workspace / clinic name">
          <input className={inputCls} placeholder="Example Clinic" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Clinic website (optional — used to build the agent's knowledge base)">
          <input className={inputCls} placeholder="https://example-clinic.com" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </Field>
        <label className="flex items-start gap-2 rounded-xl border border-ink-200 px-3 py-2.5 text-sm">
          <input type="checkbox" checked={seedAgent} onChange={(e) => setSeedAgent(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#7c3aed]" />
          <span>
            <span className="font-medium text-ink-800">Create a ready-made inbound voice agent (Laura)</span>
            <span className="block text-xs text-ink-400">A dental receptionist that answers calls, books, reschedules and cancels — knowledge base imported from the website above. English + Arabic.</span>
          </span>
        </label>
        {busy && <p className="text-xs font-medium text-brand-600">{busy}</p>}
      </div>
      <ModalFooter onClose={onClose} submitLabel={busy ? busy : "Create workspace"} onSubmit={busy ? () => {} : submit} />
    </Modal>
  );
}
