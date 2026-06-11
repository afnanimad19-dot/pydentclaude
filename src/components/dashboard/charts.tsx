"use client";

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
            <stop offset="0%" stopColor="#b6c2c9" stopOpacity={0.5} />
            <stop offset="100%" stopColor="#b6c2c9" stopOpacity={0.05} />
          </linearGradient>
          <linearGradient id="pyd" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#289ca0" stopOpacity={0.55} />
            <stop offset="100%" stopColor="#289ca0" stopOpacity={0.05} />
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
        <Area type="monotone" dataKey="production" name="Total production" stroke="#8fa0aa" fill="url(#prod)" strokeWidth={2} />
        <Area type="monotone" dataKey="fromPydental" name="Booked via Pydental" stroke="#289ca0" fill="url(#pyd)" strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
