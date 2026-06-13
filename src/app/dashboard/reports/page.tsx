import {
  CircleDollarSign,
  Users,
  CalendarCheck2,
  TrendingUp,
  Bot,
  Percent,
  BellRing,
  Receipt,
} from "lucide-react";
import { Card, PageHeader, DemoBanner, StatCard } from "@/components/ui";
import {
  ProviderProductionChart,
  NewPatientsChart,
  AppointmentMixChart,
  ProductionByChannelChart,
} from "@/components/dashboard/charts";
import {
  insuranceClaims,
  providerProduction,
  appointmentMix,
  formatMoney,
} from "@/lib/mock-data";

export default function ReportsPage() {
  const totalProduction = providerProduction.reduce((s, p) => s + p.production, 0);
  const totalGoal = providerProduction.reduce((s, p) => s + p.goal, 0);
  const completed = appointmentMix.find((a) => a.name === "Completed")?.value ?? 0;
  const broken = appointmentMix.find((a) => a.name === "Broken / no-show")?.value ?? 0;
  const totalApts = appointmentMix.reduce((s, a) => s + a.value, 0);
  const claimsOutstanding = insuranceClaims
    .filter((c) => c.status !== "Paid" && c.status !== "Denied")
    .reduce((s, c) => s + (c.estimated - c.paid), 0);

  return (
    <>
      <DemoBanner context="Practice analytics for Bright Smile Dental — production, patients, schedule and AI performance. Connect OpenDental to report on live clinic data." />
      <PageHeader
        title="Reports & Analytics"
        subtitle="The numbers that run the practice — production, new patients, schedule health and how much your AI is driving."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={CircleDollarSign} label="Production (MTD)" value={formatMoney(totalProduction)} hint={`${Math.round((totalProduction / totalGoal) * 100)}% of $${Math.round(totalGoal / 1000)}k goal`} accent="brand" />
        <StatCard icon={Users} label="New patients (Jun)" value="24" hint="17 acquired by AI agents" accent="violet" />
        <StatCard icon={Percent} label="Case acceptance" value="61%" hint="+4 pts vs last month" accent="green" />
        <StatCard icon={CalendarCheck2} label="Schedule utilization" value={`${Math.round((completed / totalApts) * 100)}%`} hint={`${broken} no-shows recovered`} accent="amber" />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-1 flex items-center gap-2 font-semibold text-ink-900">
            <TrendingUp className="h-5 w-5 text-brand-500" /> Production by provider
          </h2>
          <p className="mb-4 text-sm text-ink-500">Month-to-date production against each provider&apos;s goal.</p>
          <ProviderProductionChart />
        </Card>

        <Card className="p-5">
          <h2 className="mb-1 flex items-center gap-2 font-semibold text-ink-900">
            <Bot className="h-5 w-5 text-brand-500" /> New patients & AI acquisition
          </h2>
          <p className="mb-4 text-sm text-ink-500">How many new patients arrived each month, and how many your agents booked.</p>
          <NewPatientsChart />
        </Card>

        <Card className="p-5">
          <h2 className="mb-1 flex items-center gap-2 font-semibold text-ink-900">
            <CalendarCheck2 className="h-5 w-5 text-brand-500" /> Appointment mix
          </h2>
          <p className="mb-4 text-sm text-ink-500">Where appointments land — completed, booked, unconfirmed and no-shows.</p>
          <AppointmentMixChart />
        </Card>

        <Card className="p-5">
          <h2 className="mb-1 flex items-center gap-2 font-semibold text-ink-900">
            <CircleDollarSign className="h-5 w-5 text-brand-500" /> Production by source
          </h2>
          <p className="mb-4 text-sm text-ink-500">Which channels are actually producing treatment revenue.</p>
          <ProductionByChannelChart />
        </Card>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <StatCard icon={Receipt} label="Outstanding insurance" value={formatMoney(claimsOutstanding)} hint={`${insuranceClaims.filter((c) => c.status !== "Paid" && c.status !== "Denied").length} claims in flight`} accent="amber" />
        <StatCard icon={BellRing} label="Recall due" value="3" hint="auto-enrolled in recall flow" accent="violet" />
        <StatCard icon={TrendingUp} label="Avg. time to schedule" value="4.2 days" hint="from first contact" accent="green" />
      </div>
    </>
  );
}
