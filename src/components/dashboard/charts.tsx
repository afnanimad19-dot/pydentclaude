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
  PieChart,
  Pie,
  Cell,
} from "recharts";
import {
  weeklyConversations,
  monthlyRevenue,
  channelMeta,
  providerProduction,
  newPatientsTrend,
  appointmentMix,
  productionByChannel,
} from "@/lib/mock-data";

const tooltipStyle = {
  borderRadius: 12,
  border: "1px solid var(--ink-200)",
  background: "var(--surface)",
  color: "var(--foreground)",
  fontSize: 13,
} as const;

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
        <Area type="monotone" dataKey="fromPydental" name="Booked via Pydental" stroke="#8b5cf6" fill="url(#pyd)" strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function ProviderProductionChart() {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={providerProduction} layout="vertical" barCategoryGap="30%" margin={{ left: 24 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--chart-grid)" />
        <XAxis type="number" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "var(--chart-tick)" }} tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`} />
        <YAxis type="category" dataKey="provider" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "var(--chart-tick)" }} width={120} />
        <Tooltip cursor={{ fill: "var(--ink-50)" }} contentStyle={tooltipStyle} formatter={(v) => `$${Number(v).toLocaleString()}`} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="goal" name="Goal" fill="#cbd5e1" radius={[0, 6, 6, 0]} />
        <Bar dataKey="production" name="Production" fill="#8b5cf6" radius={[0, 6, 6, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function NewPatientsChart() {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={newPatientsTrend} barCategoryGap="28%">
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--chart-grid)" />
        <XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "var(--chart-tick)" }} />
        <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "var(--chart-tick)" }} width={32} />
        <Tooltip cursor={{ fill: "var(--ink-50)" }} contentStyle={tooltipStyle} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="newPatients" name="New patients" stackId="a" fill="#c4b5fd" />
        <Bar dataKey="fromAi" name="Acquired by AI" stackId="b" fill="#8b5cf6" radius={[6, 6, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function AppointmentMixChart() {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <PieChart>
        <Pie data={appointmentMix} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={64} outerRadius={104} paddingAngle={2}>
          {appointmentMix.map((d) => (
            <Cell key={d.name} fill={d.color} />
          ))}
        </Pie>
        <Tooltip contentStyle={tooltipStyle} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function ProductionByChannelChart() {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={productionByChannel} layout="vertical" barCategoryGap="28%" margin={{ left: 30 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--chart-grid)" />
        <XAxis type="number" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "var(--chart-tick)" }} tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`} />
        <YAxis type="category" dataKey="channel" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "var(--chart-tick)" }} width={130} />
        <Tooltip cursor={{ fill: "var(--ink-50)" }} contentStyle={tooltipStyle} formatter={(v) => `$${Number(v).toLocaleString()}`} />
        <Bar dataKey="value" name="Production" fill="#8b5cf6" radius={[0, 6, 6, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
