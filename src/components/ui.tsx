import type { LucideIcon } from "lucide-react";
import { channelMeta, type Channel } from "@/lib/mock-data";

export function Card({
  children,
  className = "",
  id,
}: {
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <div id={id} className={`rounded-2xl border border-ink-200 bg-surface shadow-[0_1px_2px_rgba(15,31,36,0.04)] ${className}`}>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  accent = "brand",
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  accent?: "brand" | "green" | "amber" | "violet";
}) {
  const accents = {
    brand: "bg-brand-500/15 text-brand-500",
    green: "bg-emerald-500/15 text-emerald-600",
    amber: "bg-amber-500/15 text-amber-600",
    violet: "bg-violet-500/15 text-violet-500",
  };
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-ink-500">{label}</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-ink-900">{value}</p>
          {hint && <p className="mt-1 text-xs text-ink-400">{hint}</p>}
        </div>
        <div className={`rounded-xl p-2.5 ${accents[accent]}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </Card>
  );
}

export function ChannelBadge({ channel }: { channel: Channel }) {
  const meta = channelMeta[channel];
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ color: meta.color, backgroundColor: meta.bg }}
    >
      {meta.label}
    </span>
  );
}

export function StatusBadge({
  status,
  tone,
}: {
  status: string;
  tone: "green" | "amber" | "red" | "gray" | "blue" | "violet";
}) {
  const tones = {
    green: "bg-emerald-500/15 text-emerald-600",
    amber: "bg-amber-500/15 text-amber-600",
    red: "bg-red-500/15 text-red-600",
    gray: "bg-ink-100 text-ink-600",
    blue: "bg-blue-500/15 text-blue-600",
    violet: "bg-violet-500/15 text-violet-500",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {status}
    </span>
  );
}

export function DemoBanner({ context }: { context: string }) {
  return (
    <div className="mb-6 flex items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2.5 text-sm text-brand-800 dark:text-brand-300">
      <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-brand-500" />
      <span>
        <strong className="font-semibold">Demo mode</strong> — {context}
      </span>
    </div>
  );
}

// Green "this is live, reading/writing your real database" banner.
export function LiveBanner({ context }: { context: string }) {
  return (
    <div className="mb-6 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-600">
      <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500" />
      <span><strong className="font-semibold">Live</strong> — {context}</span>
    </div>
  );
}

export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const sizes = { sm: "h-8 w-8 text-xs", md: "h-10 w-10 text-sm", lg: "h-12 w-12 text-base" };
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-700 ${sizes[size]}`}
    >
      {initials}
    </div>
  );
}
