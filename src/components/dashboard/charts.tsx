"use client";

import { useRef, useState } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  AreaChart,
  Area,
  CartesianGrid,
} from "recharts";
import { weeklyConversations, monthlyRevenue, channelMeta } from "@/lib/mock-data";

export function ConversationsChart() {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={weeklyConversations} barCategoryGap="28%">
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--chart-grid)" />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "var(--chart-tick)" }} />
        <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "var(--chart-tick)" }} width={32} />
        <Tooltip cursor={{ fill: "var(--ink-50)" }} contentStyle={{ borderRadius: 12, border: "1px solid var(--ink-200)", background: "var(--surface)", color: "var(--foreground)", fontSize: 13 }} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="whatsapp" name="WhatsApp" stackId="a" fill={channelMeta.whatsapp.color} radius={[0, 0, 0, 0]} />
        <Bar dataKey="sms" name="SMS" stackId="a" fill={channelMeta.sms.color} />
        <Bar dataKey="email" name="Email" stackId="a" fill={channelMeta.email.color} />
        <Bar dataKey="voice" name="Voice" stackId="a" fill={channelMeta.voice.color} radius={[6, 6, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function RevenueChart() {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={monthlyRevenue}>
        <defs>
          <linearGradient id="prod" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#bcb9d0" stopOpacity={0.5} />
            <stop offset="100%" stopColor="#bcb9d0" stopOpacity={0.05} />
          </linearGradient>
          <linearGradient id="pyd" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.55} />
            <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--chart-grid)" />
        <XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "var(--chart-tick)" }} />
        <YAxis
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 12, fill: "var(--chart-tick)" }}
          width={48}
          tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`}
        />
        <Tooltip
          contentStyle={{ borderRadius: 12, border: "1px solid var(--ink-200)", background: "var(--surface)", color: "var(--foreground)", fontSize: 13 }}
          formatter={(v) => `$${Number(v).toLocaleString()}`}
        />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
        <Area type="monotone" dataKey="production" name="Total production" stroke="#9692b0" fill="url(#prod)" strokeWidth={2} />
        <Area type="monotone" dataKey="fromPydent" name="Booked via Pydent" stroke="#8b5cf6" fill="url(#pyd)" strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/* ---------------------------------------------------------------------------
 * Report charts (GA / Search Console) — matched to the app's SpendChart style:
 * thin 2px marks, ink-token grid/axes, currentColor theming (light & dark), a
 * hover layer, and category identity via a fixed accent order (never
 * color-alone — legends/labels accompany).
 * ------------------------------------------------------------------------- */

export interface Point { date: string; value: number }
export interface Cat { label: string; value: number }

const nf = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
const CAT_STROKE = ["stroke-brand-500", "stroke-emerald-500", "stroke-violet-500", "stroke-amber-500", "stroke-rose-500", "stroke-sky-500"];
const CAT_BG = ["bg-brand-500", "bg-emerald-500", "bg-violet-500", "bg-amber-500", "bg-rose-500", "bg-sky-500"];

// Single-series line over time — magnitude / change, with crosshair + tooltip.
export function LineChart({ data, label, format = nf, tone = "text-brand-600 dark:text-brand-300" }: { data: Point[]; label: string; format?: (n: number) => string; tone?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  if (data.length < 2) return <p className="rounded-xl border border-dashed border-ink-200 px-4 py-8 text-center text-sm text-ink-400">Not enough data to chart yet.</p>;
  const W = 640, H = 180, PAD_L = 8, PAD_R = 8, PAD_T = 12, PAD_B = 22;
  const max = Math.max(...data.map((d) => d.value), 0.01);
  const x = (i: number) => PAD_L + (i / (data.length - 1)) * (W - PAD_L - PAD_R);
  const y = (v: number) => PAD_T + (1 - v / max) * (H - PAD_T - PAD_B);
  const line = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(data.length - 1).toFixed(1)},${H - PAD_B} L${x(0).toFixed(1)},${H - PAD_B} Z`;
  const maxIdx = data.reduce((mi, d, i) => (d.value > data[mi].value ? i : mi), 0);
  function onMove(e: React.MouseEvent) {
    const el = ref.current; if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD_L) / (W - PAD_L - PAD_R)) * (data.length - 1));
    setHover(Math.max(0, Math.min(data.length - 1, i)));
  }
  const h = hover != null ? data[hover] : null;
  return (
    <div ref={ref} className="relative" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} className={`w-full ${tone}`} role="img" aria-label={`${label} over time`}>
        {[0.25, 0.5, 0.75].map((f) => <line key={f} x1={PAD_L} x2={W - PAD_R} y1={PAD_T + f * (H - PAD_T - PAD_B)} y2={PAD_T + f * (H - PAD_T - PAD_B)} className="stroke-ink-100" strokeWidth="1" />)}
        <line x1={PAD_L} x2={W - PAD_R} y1={H - PAD_B} y2={H - PAD_B} className="stroke-ink-200" strokeWidth="1" />
        <path d={area} fill="currentColor" opacity="0.08" />
        <path d={line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(maxIdx)} cy={y(data[maxIdx].value)} r="3" fill="currentColor" />
        <text x={x(maxIdx)} y={y(data[maxIdx].value) - 6} textAnchor="middle" className="fill-ink-500" fontSize="10">{format(data[maxIdx].value)}</text>
        <text x={PAD_L} y={H - 6} className="fill-ink-400" fontSize="10">{data[0].date.slice(5)}</text>
        <text x={W - PAD_R} y={H - 6} textAnchor="end" className="fill-ink-400" fontSize="10">{data[data.length - 1].date.slice(5)}</text>
        {h && hover != null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={H - PAD_B} className="stroke-ink-300" strokeWidth="1" strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(h.value)} r="4" fill="currentColor" className="stroke-surface" strokeWidth="2" />
          </>
        )}
      </svg>
      {h && hover != null && (
        <div className="pointer-events-none absolute -top-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs shadow-lg" style={{ left: `${(x(hover) / W) * 100}%`, transform: `translateX(${hover > data.length / 2 ? "-105%" : "5%"})` }}>
          <p className="font-semibold text-ink-900">{h.date}</p>
          <p className="text-ink-600">{format(h.value)} {label.toLowerCase()}</p>
        </div>
      )}
    </div>
  );
}

// Horizontal bar list — magnitude by category (top queries, countries, pages…).
export function BarList({ data, format = nf, emptyText = "No data yet." }: { data: Cat[]; format?: (n: number) => string; emptyText?: string }) {
  if (data.length === 0) return <p className="rounded-xl border border-dashed border-ink-200 px-4 py-6 text-center text-sm text-ink-400">{emptyText}</p>;
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="space-y-2">
      {data.map((d, i) => (
        <div key={`${d.label}-${i}`} className="flex items-center gap-3">
          <span className="w-28 shrink-0 truncate text-xs text-ink-600" title={d.label}>{d.label || "—"}</span>
          <div className="h-4 flex-1 overflow-hidden rounded-full bg-ink-100">
            <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.max(2, (d.value / max) * 100)}%` }} />
          </div>
          <span className="w-14 shrink-0 text-right text-xs font-medium text-ink-800">{format(d.value)}</span>
        </div>
      ))}
    </div>
  );
}

// Donut — categorical share (device split, etc.); legend + % so identity is
// never color-alone.
export function Donut({ data, format = nf }: { data: Cat[]; format?: (n: number) => string }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total <= 0) return <p className="rounded-xl border border-dashed border-ink-200 px-4 py-6 text-center text-sm text-ink-400">No data yet.</p>;
  const R = 52, C = 60, SW = 20, circ = 2 * Math.PI * R;
  const slice = data.slice(0, 6);
  const dashes = slice.map((d) => (d.value / total) * circ);
  const segs = slice.map((d, i) => ({ d, i, frac: d.value / total, dash: dashes[i], off: dashes.slice(0, i).reduce((a, b) => a + b, 0) }));
  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg viewBox="0 0 120 120" className="h-32 w-32 shrink-0 -rotate-90" role="img" aria-label="Category share">
        <circle cx={C} cy={C} r={R} fill="none" className="stroke-ink-100" strokeWidth={SW} />
        {segs.map((s) => (
          <circle key={s.i} cx={C} cy={C} r={R} fill="none" className={CAT_STROKE[s.i % CAT_STROKE.length]} strokeWidth={SW} strokeDasharray={`${s.dash} ${circ - s.dash}`} strokeDashoffset={-s.off} />
        ))}
      </svg>
      <ul className="space-y-1.5 text-sm">
        {segs.map((s) => (
          <li key={s.i} className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${CAT_BG[s.i % CAT_BG.length]}`} />
            <span className="text-ink-700">{s.d.label || "—"}</span>
            <span className="text-ink-400">· {format(s.d.value)} ({Math.round(s.frac * 100)}%)</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
