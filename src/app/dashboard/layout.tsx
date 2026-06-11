import { Sidebar } from "@/components/dashboard/sidebar";
import { Search, Bell } from "lucide-react";
import { Avatar } from "@/components/ui";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <div className="pl-60">
        <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b border-ink-200 bg-white/80 px-6 backdrop-blur">
          <div className="flex w-full max-w-md items-center gap-2 rounded-xl border border-ink-200 bg-ink-50 px-3 py-2">
            <Search className="h-4 w-4 text-ink-400" />
            <input
              placeholder="Search patients, conversations, appointments…"
              className="w-full bg-transparent text-sm text-ink-800 outline-none placeholder:text-ink-400"
            />
          </div>
          <div className="flex items-center gap-4">
            <button className="relative rounded-xl p-2 text-ink-500 hover:bg-ink-50">
              <Bell className="h-5 w-5" />
              <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-brand-500" />
            </button>
            <div className="flex items-center gap-2.5">
              <Avatar name="Dana Reyes" size="sm" />
              <div className="leading-tight">
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
