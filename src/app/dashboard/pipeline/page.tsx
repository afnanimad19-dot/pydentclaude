import { Plus, TrendingUp, CircleDollarSign, Hourglass } from "lucide-react";
import { PageHeader, DemoBanner, ChannelBadge, StatCard } from "@/components/ui";
import { pipeline, formatMoney } from "@/lib/mock-data";

export default function PipelinePage() {
  const allDeals = pipeline.flatMap((s) => s.deals);
  const totalValue = allDeals.reduce((sum, d) => sum + d.value, 0);

  return (
    <>
      <DemoBanner context="Pipeline is filled from sample leads and unscheduled treatment plans." />
      <PageHeader
        title="Pipeline"
        subtitle="Every lead and unscheduled treatment plan, from first message to accepted treatment."
        actions={
          <button className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
            <Plus className="h-4 w-4" /> Add deal
          </button>
        }
      />

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <StatCard icon={CircleDollarSign} label="Pipeline value" value={formatMoney(totalValue)} hint={`${allDeals.length} open opportunities`} accent="brand" />
        <StatCard icon={TrendingUp} label="Accepted this month" value="$23,400" hint="61% case acceptance" accent="green" />
        <StatCard icon={Hourglass} label="Avg time to schedule" value="4.2 days" hint="from first contact" accent="amber" />
      </div>

      <div className="flex gap-4 overflow-x-auto pb-4">
        {pipeline.map((stage) => {
          const stageValue = stage.deals.reduce((sum, d) => sum + d.value, 0);
          return (
            <div key={stage.id} className="w-72 shrink-0">
              <div className="mb-3 flex items-center justify-between px-1">
                <h2 className="text-sm font-semibold text-ink-900">
                  {stage.name}{" "}
                  <span className="ml-1 rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-500">
                    {stage.deals.length}
                  </span>
                </h2>
                <span className="text-xs font-medium text-ink-400">{formatMoney(stageValue)}</span>
              </div>
              <div className="space-y-3 rounded-2xl bg-ink-100/60 p-3">
                {stage.deals.map((deal) => (
                  <div key={deal.id} className="cursor-grab rounded-xl border border-ink-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-semibold text-ink-900">{deal.patientName}</p>
                      <span className="text-sm font-semibold text-brand-700">{formatMoney(deal.value)}</span>
                    </div>
                    <p className="mt-1 text-xs text-ink-500">{deal.treatment}</p>
                    <div className="mt-3 flex items-center justify-between">
                      {deal.source === "walk-in" || deal.source === "referral" ? (
                        <span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-600 capitalize">{deal.source}</span>
                      ) : (
                        <ChannelBadge channel={deal.source} />
                      )}
                      <span className="text-[11px] text-ink-400">
                        {deal.owner} · {deal.daysInStage}d
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
