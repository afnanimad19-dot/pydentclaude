import { Users, CalendarClock, BellRing, Database } from "lucide-react";
import { Card, PageHeader, DemoBanner, StatCard, StatusBadge, Avatar } from "@/components/ui";
import { patients, appointments } from "@/lib/mock-data";

const aptTone = { Confirmed: "green", Scheduled: "blue", Unconfirmed: "amber", Completed: "gray", Broken: "red" } as const;

export default function PatientsPage() {
  const recallDue = patients.filter((p) => p.recallDue);

  return (
    <>
      <DemoBanner context="This is a sample patient roster shaped like an OpenDental sync (PatNum, recalls, balances)." />
      <PageHeader
        title="Patients"
        subtitle="Your OpenDental roster, recall lists and schedule — in a UI the front desk will love."
        actions={
          <span className="flex items-center gap-2 rounded-xl border border-ink-200 bg-white px-3.5 py-2 text-xs font-medium text-ink-500">
            <Database className="h-4 w-4 text-brand-600" /> Last sync: demo data
          </span>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard icon={Users} label="Active patients" value="1,240" hint="38 new this month" accent="brand" />
        <StatCard icon={BellRing} label="Recall due" value="214" hint="auto-enrolled in recall flow" accent="amber" />
        <StatCard icon={CalendarClock} label="Unscheduled treatment" value="$86,200" hint="47 open treatment plans" accent="violet" />
      </div>

      <Card className="mt-6 overflow-hidden">
        <div className="border-b border-ink-200 px-5 py-4">
          <h2 className="font-semibold text-ink-900">Patient roster</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink-200 bg-ink-50 text-xs font-semibold uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-5 py-3">Patient</th>
                <th className="px-4 py-3">Contact</th>
                <th className="px-4 py-3">Insurance</th>
                <th className="px-4 py-3">Last visit</th>
                <th className="px-4 py-3">Next appt</th>
                <th className="px-4 py-3 text-right">Balance</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {patients.map((p) => (
                <tr key={p.id} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/60">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <Avatar name={p.name} size="sm" />
                      <div>
                        <p className="font-medium text-ink-900">{p.name}</p>
                        <p className="text-xs text-ink-400">PatNum {p.patNum}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3.5">
                    <p className="text-ink-700">{p.phone}</p>
                    <p className="text-xs text-ink-400">{p.email}</p>
                  </td>
                  <td className="px-4 py-3.5 text-ink-700">{p.insurance}</td>
                  <td className="px-4 py-3.5 text-ink-700">{p.lastVisit}</td>
                  <td className="px-4 py-3.5">
                    {p.nextAppointment ? (
                      <span className="text-ink-700">{p.nextAppointment}</span>
                    ) : p.recallDue ? (
                      <StatusBadge status="Recall due" tone="amber" />
                    ) : (
                      <span className="text-ink-400">—</span>
                    )}
                  </td>
                  <td className={`px-4 py-3.5 text-right font-medium ${p.balance > 0 ? "text-rose-600" : "text-ink-700"}`}>
                    ${p.balance.toFixed(2)}
                  </td>
                  <td className="px-4 py-3.5">
                    <StatusBadge status={p.status} tone={p.status === "Active" ? "green" : p.status === "New" ? "blue" : "gray"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-6 grid gap-4 xl:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-4 font-semibold text-ink-900">Upcoming appointments</h2>
          <ul className="space-y-2.5">
            {appointments.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 rounded-xl border border-ink-100 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink-900">
                    {a.patientName} <span className="font-normal text-ink-400">· AptNum {a.aptNum}</span>
                  </p>
                  <p className="text-xs text-ink-500">
                    {a.procedure} · {a.date} {a.time} · {a.provider} · {a.operatory}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {a.confirmedVia && (
                    <span className="text-[11px] text-ink-400">confirmed via {a.confirmedVia}</span>
                  )}
                  <StatusBadge status={a.status} tone={aptTone[a.status]} />
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-5">
          <h2 className="mb-1 font-semibold text-ink-900">Recall worklist</h2>
          <p className="mb-4 text-sm text-ink-500">
            Patients overdue for hygiene — automatically enrolled in the WhatsApp recall flow.
          </p>
          <ul className="space-y-2.5">
            {recallDue.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 rounded-xl border border-amber-100 bg-amber-50/50 px-4 py-3">
                <div className="flex items-center gap-3">
                  <Avatar name={p.name} size="sm" />
                  <div>
                    <p className="text-sm font-medium text-ink-900">{p.name}</p>
                    <p className="text-xs text-ink-500">Last visit {p.lastVisit} · {p.phone}</p>
                  </div>
                </div>
                <button className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700">
                  Send recall
                </button>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
