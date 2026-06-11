import Link from "next/link";
import {
  Sparkles,
  MessageCircle,
  MessageSquareText,
  Mail,
  PhoneCall,
  KanbanSquare,
  Database,
  Bot,
  ShieldCheck,
  ArrowRight,
  CheckCircle2,
  Inbox,
} from "lucide-react";

const channels = [
  {
    icon: PhoneCall,
    title: "AI Voice Agents",
    body: "Receptionists that never miss a call. They answer, book, reschedule and verify insurance in English and Spanish — 24/7, straight into your schedule.",
  },
  {
    icon: MessageCircle,
    title: "WhatsApp",
    body: "Two-way conversations, recall broadcasts and a visual chatbot builder on the channel your patients already live in.",
  },
  {
    icon: MessageSquareText,
    title: "SMS",
    body: "Reminders, confirmations and no-show recovery that patients actually reply to — with every reply landing in one inbox.",
  },
  {
    icon: Mail,
    title: "Email",
    body: "Newsletters, treatment-plan follow-ups and review requests that run themselves and report bookings, not just opens.",
  },
  {
    icon: KanbanSquare,
    title: "Pipeline",
    body: "Every lead and unscheduled treatment plan on one board, from first message to accepted treatment — owned by a human or an AI agent.",
  },
  {
    icon: Inbox,
    title: "Omnichannel Inbox",
    body: "One calm queue for every channel. AI handles the routine; your team sees only what genuinely needs a human.",
  },
];

const steps = [
  {
    n: "01",
    title: "Connect OpenDental",
    body: "Paste your OpenDental API key. Patients, schedule, recalls and treatment plans sync into a clean, modern UI — read-only first, zero risk to your database.",
  },
  {
    n: "02",
    title: "Turn on your agents",
    body: "Pick from ready-made recall, reminder, FAQ and no-show flows — or build your own with the visual builder. Assign a voice agent to your phone line.",
  },
  {
    n: "03",
    title: "Watch revenue compound",
    body: "Booked appointments, recovered no-shows and accepted treatment show up on one dashboard, attributed to the channel and agent that earned them.",
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-white text-ink-900">
      {/* Nav */}
      <header className="sticky top-0 z-30 border-b border-ink-100 bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-white">
              <Sparkles className="h-5 w-5" />
            </div>
            <span className="text-lg font-semibold tracking-tight">Pydental</span>
          </Link>
          <nav className="hidden items-center gap-8 text-sm font-medium text-ink-600 md:flex">
            <a href="#channels" className="hover:text-ink-900">Channels</a>
            <a href="#opendental" className="hover:text-ink-900">OpenDental</a>
            <a href="#how" className="hover:text-ink-900">How it works</a>
          </nav>
          <Link
            href="/dashboard"
            className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
          >
            Open live demo
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(60% 50% at 50% 0%, #d6f3f2 0%, rgba(214,243,242,0) 70%)",
          }}
        />
        <div className="relative mx-auto max-w-6xl px-6 pb-20 pt-20 text-center md:pt-28">
          <span className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50 px-3.5 py-1.5 text-xs font-semibold text-brand-700">
            <Bot className="h-3.5 w-3.5" /> Built for dental clinics on OpenDental
          </span>
          <h1 className="mx-auto mt-6 max-w-3xl text-4xl font-semibold leading-tight tracking-tight md:text-6xl">
            Voice agents, WhatsApp, SMS, email and pipeline —{" "}
            <span className="text-brand-600">one calm workspace.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-ink-500">
            Your team ships faster, your patients feel heard, and revenue compounds — without
            stitching tools together. Pydental plugs into OpenDental and handles the conversations
            that fill your chairs.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
            >
              Explore the demo workspace <ArrowRight className="h-4 w-4" />
            </Link>
            <a
              href="#opendental"
              className="inline-flex items-center gap-2 rounded-xl border border-ink-200 px-6 py-3 text-sm font-semibold text-ink-700 transition-colors hover:bg-ink-50"
            >
              <Database className="h-4 w-4 text-brand-600" /> See the OpenDental sync
            </a>
          </div>
          <div className="mx-auto mt-12 grid max-w-3xl grid-cols-2 gap-6 md:grid-cols-4">
            {[
              ["8 sec", "avg first response"],
              ["74%", "conversations handled by AI"],
              ["+31", "recalls booked per campaign"],
              ["24/7", "phones answered"],
            ].map(([v, l]) => (
              <div key={l}>
                <p className="text-3xl font-semibold tracking-tight text-ink-900">{v}</p>
                <p className="mt-1 text-sm text-ink-500">{l}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Channels */}
      <section id="channels" className="border-t border-ink-100 bg-ink-50/60 py-20">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="text-center text-3xl font-semibold tracking-tight">
            Every patient conversation, one workspace
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-center text-ink-500">
            Stop juggling a phone system, a texting app, an email tool and a spreadsheet of leads.
          </p>
          <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {channels.map((c) => (
              <div
                key={c.title}
                className="rounded-2xl border border-ink-200 bg-white p-6 transition-shadow hover:shadow-md"
              >
                <div className="inline-flex rounded-xl bg-brand-50 p-2.5 text-brand-600">
                  <c.icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 text-lg font-semibold">{c.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-500">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* OpenDental */}
      <section id="opendental" className="py-20">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 lg:grid-cols-2">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-ink-200 px-3.5 py-1.5 text-xs font-semibold text-ink-600">
              <Database className="h-3.5 w-3.5 text-brand-600" /> Native OpenDental integration
            </span>
            <h2 className="mt-5 text-3xl font-semibold tracking-tight">
              Your OpenDental data, a UI your team will love
            </h2>
            <p className="mt-4 leading-relaxed text-ink-500">
              Clinics connect their own OpenDental API key and Pydental syncs patients,
              appointments, recall lists and unscheduled treatment plans into modern screens built
              for the front desk — while OpenDental stays the system of record.
            </p>
            <ul className="mt-6 space-y-3">
              {[
                "Read-only first: explore everything with zero risk to your live database",
                "Write actions (booking, confirmations, commlogs) are an explicit per-clinic opt-in",
                "Recall and treatment-plan lists automatically feed campaigns and the pipeline",
                "You keep OpenDental — Pydental is the conversation layer on top",
              ].map((t) => (
                <li key={t} className="flex items-start gap-2.5 text-sm text-ink-700">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" /> {t}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl border border-ink-200 bg-ink-900 p-6 font-mono text-sm leading-relaxed text-ink-200 shadow-xl">
            <p className="text-ink-400"># Connect once in Settings → Integrations</p>
            <p className="mt-3"><span className="text-brand-300">GET</span> /api/v1/patients</p>
            <p><span className="text-brand-300">GET</span> /api/v1/appointments</p>
            <p><span className="text-brand-300">GET</span> /api/v1/recalls</p>
            <p><span className="text-brand-300">GET</span> /api/v1/treatplans</p>
            <p className="mt-3 text-ink-400"># Opt-in write actions, when you’re ready</p>
            <p><span className="text-amber-300">POST</span> /api/v1/appointments</p>
            <p><span className="text-amber-300">PUT</span> /api/v1/appointments/&#123;AptNum&#125;/Confirm</p>
            <p><span className="text-amber-300">POST</span> /api/v1/commlogs</p>
            <p className="mt-4 flex items-center gap-2 text-xs text-emerald-300">
              <ShieldCheck className="h-4 w-4" /> Demo mode on — no live writes possible
            </p>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="border-t border-ink-100 bg-ink-50/60 py-20">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="text-center text-3xl font-semibold tracking-tight">Live in an afternoon</h2>
          <div className="mt-12 grid gap-8 md:grid-cols-3">
            {steps.map((s) => (
              <div key={s.n} className="rounded-2xl border border-ink-200 bg-white p-6">
                <span className="text-sm font-semibold text-brand-600">{s.n}</span>
                <h3 className="mt-3 text-lg font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-500">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20">
        <div className="mx-auto max-w-4xl rounded-3xl bg-brand-600 px-8 py-14 text-center text-white">
          <h2 className="text-3xl font-semibold tracking-tight">See it with a sample clinic, today</h2>
          <p className="mx-auto mt-3 max-w-xl text-brand-100">
            The full workspace runs in demo mode with realistic data — inbox, broadcasts, voice
            calls, pipeline and all. No signup, no OpenDental key needed.
          </p>
          <Link
            href="/dashboard"
            className="mt-8 inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3 text-sm font-semibold text-brand-700 transition-colors hover:bg-brand-50"
          >
            Open the demo workspace <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <footer className="border-t border-ink-100 py-10">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 text-sm text-ink-400">
          <span>© 2026 Pydental — the calm workspace for dental clinics.</span>
          <span>Works with OpenDental · WhatsApp Business · Twilio · Retell AI</span>
        </div>
      </footer>
    </div>
  );
}
