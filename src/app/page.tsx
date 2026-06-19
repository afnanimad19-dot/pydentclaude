import Link from "next/link";
import {
  Sparkles,
  MessageCircle,
  PhoneCall,
  KanbanSquare,
  Database,
  Bot,
  ArrowRight,
  CheckCircle2,
  Inbox,
  Star,
  Zap,
  ShieldCheck,
  MessageSquareText,
} from "lucide-react";

function Glow({ className }: { className: string }) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute rounded-full blur-3xl ${className}`}
    />
  );
}

function SectionTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3.5 py-1.5 text-xs font-semibold text-violet-300">
      {children}
    </span>
  );
}

const features = [
  {
    icon: PhoneCall,
    title: "AI Voice Receptionists",
    body: "Agents that answer every call 24/7 — booking, rescheduling and verifying insurance in English and Spanish, straight into your schedule.",
  },
  {
    icon: MessageCircle,
    title: "WhatsApp Automation",
    body: "Two-way chats, recall broadcasts and a visual chatbot builder on the channel your patients already live in.",
  },
  {
    icon: Inbox,
    title: "One Calm Inbox",
    body: "WhatsApp, SMS, email and call summaries in a single queue. AI resolves the routine; your team sees only what needs a human.",
  },
  {
    icon: MessageSquareText,
    title: "Smart Reminders",
    body: "SMS confirmations and no-show recovery that patients actually answer — every reply lands back in the same inbox.",
  },
  {
    icon: KanbanSquare,
    title: "Revenue Pipeline",
    body: "Every lead and unscheduled treatment plan on one board, from first message to accepted treatment.",
  },
  {
    icon: Database,
    title: "Built-in Practice Management",
    body: "Patients, schedule, treatment plans, documents, insurance and payments — your own complete system, with OpenDental import coming for clinics that want it.",
  },
];

const benefits = [
  { title: "Innovative by default", body: "AI agents handle recall, reminders, FAQs and no-show recovery out of the box — no setup marathon." },
  { title: "Effective personalization", body: "Every message merges live chart data: names, slots, balances, benefits remaining." },
  { title: "Continual improvement", body: "Booking rates, response times and revenue attribution per channel and per agent." },
  { title: "Sweet efficiency", body: "74% of conversations resolved without a human, with an 8-second average first response." },
  { title: "Actionable insights", body: "See exactly which campaign, channel or agent produced each booked appointment." },
  { title: "Safe with your data", body: "Your patient data lives in your own database, encrypted in transit and at rest — and exportable anytime." },
];

const testimonials = [
  {
    quote:
      "Our front desk used to drown in callbacks. Now Ava answers everything after hours and we walk in to a full schedule. We recovered 31 overdue hygiene patients in the first campaign.",
    name: "Dr. S. Patel",
    role: "Bright Smile Dental — Miami, FL",
  },
  {
    quote:
      "The WhatsApp recall flow paid for the software in week one. Patients reply to WhatsApp like they never replied to phone calls.",
    name: "Dana R.",
    role: "Office Manager, 3-location group",
  },
  {
    quote:
      "We kept OpenDental, which is what sold us. Pydental is just a much nicer face on our own data — plus the agents that actually talk to patients.",
    name: "Dr. L. Gomez",
    role: "Coral Gables Dentistry",
  },
];

const plans = [
  {
    name: "Starter",
    price: "$99",
    period: "/mo per location",
    blurb: "For solo practices getting off voicemail.",
    features: ["Omnichannel inbox", "SMS reminders & confirmations", "Email campaigns", "Built-in patient management", "1 user seat"],
    cta: "Start free trial",
    featured: false,
  },
  {
    name: "Growth",
    price: "$249",
    period: "/mo per location",
    blurb: "The full conversation layer, agents included.",
    features: [
      "Everything in Starter",
      "WhatsApp Business + chatbot builder",
      "1 AI voice agent (24/7 phone line)",
      "Revenue pipeline & attribution",
      "Unlimited seats",
    ],
    cta: "Start free trial",
    featured: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "multi-location groups",
    blurb: "DSOs and groups with custom workflows.",
    features: ["Everything in Growth", "Multiple voice agents", "Custom integrations & SLA", "Dedicated onboarding"],
    cta: "Contact us",
    featured: false,
  },
];

export default function Home() {
  return (
    <div className="min-h-screen overflow-x-clip bg-night-950 text-slate-200 selection:bg-violet-500/40">
      {/* Nav */}
      <header className="sticky top-0 z-30 border-b border-white/5 bg-night-950/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-lg shadow-violet-500/25">
              <Sparkles className="h-5 w-5" />
            </div>
            <span className="text-lg font-semibold tracking-tight text-white">Pydental</span>
          </Link>
          <nav className="hidden items-center gap-8 text-sm font-medium text-slate-400 md:flex">
            <a href="#features" className="transition-colors hover:text-white">Features</a>
            <a href="#platform" className="transition-colors hover:text-white">Platform</a>
            <a href="#testimonials" className="transition-colors hover:text-white">Customers</a>
            <a href="#pricing" className="transition-colors hover:text-white">Pricing</a>
          </nav>
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="rounded-xl px-4 py-2 text-sm font-semibold text-slate-300 transition-colors hover:text-white"
            >
              Log in
            </Link>
            <Link
              href="/signup"
              className="rounded-xl bg-gradient-to-r from-violet-500 to-indigo-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-violet-600/30 transition-opacity hover:opacity-90"
            >
              Get started
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative">
        <Glow className="-top-40 left-1/2 h-[480px] w-[900px] -translate-x-1/2 bg-violet-600/25" />
        <Glow className="top-40 -left-40 h-[380px] w-[380px] bg-indigo-600/20" />
        <Glow className="top-60 -right-40 h-[380px] w-[380px] bg-fuchsia-600/15" />
        <div className="grid-floor pointer-events-none absolute inset-x-0 top-0 h-[640px]" aria-hidden />

        {/* Floating 3D orbs */}
        <div className="orb-3d animate-float-slow pointer-events-none absolute left-[6%] top-44 hidden h-24 w-24 lg:block" aria-hidden />
        <div className="orb-3d-teal animate-float-slower pointer-events-none absolute right-[8%] top-32 hidden h-16 w-16 rounded-full lg:block" aria-hidden />
        <div className="orb-3d animate-float-slower pointer-events-none absolute right-[16%] top-[430px] hidden h-10 w-10 lg:block" aria-hidden />
        <div className="orb-3d-teal animate-float-slow pointer-events-none absolute left-[14%] top-[480px] hidden h-12 w-12 rounded-full lg:block" aria-hidden />

        <div className="relative mx-auto max-w-6xl px-6 pt-20 text-center md:pt-28">
          <SectionTag>
            <Bot className="h-3.5 w-3.5" /> AI-powered workspace for dental clinics
          </SectionTag>
          <h1 className="mx-auto mt-6 max-w-4xl text-4xl font-semibold leading-tight tracking-tight text-white md:text-6xl">
            Transform your clinic with{" "}
            <span className="bg-gradient-to-r from-violet-400 via-fuchsia-400 to-indigo-400 bg-clip-text text-transparent">
              AI-powered conversations
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-slate-400">
            Voice agents, WhatsApp, SMS, email and pipeline in one calm workspace. Your team ships
            faster, your patients feel heard, and revenue compounds — without stitching tools
            together.
          </p>

          <div className="mx-auto mt-9 flex max-w-md items-center gap-2 rounded-2xl border border-white/10 bg-white/5 p-1.5 backdrop-blur">
            <input
              placeholder="Your clinic email address"
              className="w-full bg-transparent px-3.5 py-2.5 text-sm text-white outline-none placeholder:text-slate-500"
            />
            <Link
              href="/signup"
              className="shrink-0 rounded-xl bg-gradient-to-r from-violet-500 to-indigo-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-violet-600/30 transition-opacity hover:opacity-90"
            >
              Get started
            </Link>
          </div>

          {/* Product preview — 3D perspective tilt */}
          <div className="preview-3d relative mx-auto mt-16 max-w-4xl">
            <div className="absolute -inset-1 rounded-3xl bg-gradient-to-r from-violet-600/40 via-fuchsia-500/30 to-indigo-600/40 blur-xl" />
            <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-night-900 shadow-2xl">
              <div className="flex items-center gap-1.5 border-b border-white/5 px-5 py-3.5">
                <span className="h-2.5 w-2.5 rounded-full bg-rose-500/70" />
                <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
                <span className="ml-3 text-xs text-slate-500">app.pydental.ai — Bright Smile Dental</span>
              </div>
              <div className="grid gap-4 p-6 text-left md:grid-cols-3">
                {[
                  { label: "Conversations today", value: "96", sub: "71 handled by AI", icon: Inbox },
                  { label: "Appointments booked", value: "14", sub: "3 no-shows recovered", icon: Zap },
                  { label: "Avg first response", value: "8s", sub: "across all channels", icon: PhoneCall },
                ].map((s) => (
                  <div key={s.label} className="rounded-2xl border border-white/5 bg-white/[0.03] p-4">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-slate-400">{s.label}</p>
                      <s.icon className="h-4 w-4 text-violet-400" />
                    </div>
                    <p className="mt-2 text-3xl font-semibold text-white">{s.value}</p>
                    <p className="mt-1 text-xs text-slate-500">{s.sub}</p>
                  </div>
                ))}
                <div className="rounded-2xl border border-white/5 bg-white/[0.03] p-4 md:col-span-2">
                  <p className="mb-3 text-xs font-medium text-slate-400">Live conversation — WhatsApp</p>
                  <div className="space-y-2.5 text-sm">
                    <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-white/5 bg-white/5 px-3.5 py-2 text-slate-300">
                      Hi! Do you have anything open this Friday for a cleaning?
                    </div>
                    <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-gradient-to-r from-violet-600 to-indigo-600 px-3.5 py-2 text-white">
                      We do! Dr. Patel has Friday 9:00 AM or 2:30 PM — want me to book one? 🦷
                    </div>
                    <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-white/5 bg-white/5 px-3.5 py-2 text-slate-300">
                      9 AM works!
                    </div>
                  </div>
                </div>
                <div className="flex flex-col justify-between rounded-2xl border border-white/5 bg-white/[0.03] p-4">
                  <div>
                    <p className="text-xs font-medium text-slate-400">Voice agent — Ava</p>
                    <p className="mt-2 text-sm leading-relaxed text-slate-300">
                      📞 Inbound call · 3m 12s
                      <br /> New patient booked Jun 12, 4:00 PM
                    </p>
                  </div>
                  <span className="mt-3 inline-flex w-fit items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Booked
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Mission strip */}
          <p className="mx-auto mt-16 max-w-2xl text-balance text-xl font-medium leading-relaxed text-slate-300">
            We&apos;re a team obsessed with using AI to streamline patient communication. We believe
            every clinic deserves a front desk that never sleeps.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm text-slate-500">
            {["WhatsApp Business", "Vapi", "Twilio", "Google Calendar", "OpenRouter", "Supabase"].map((l) => (
              <span key={l} className="font-semibold tracking-wide">{l}</span>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="relative py-24">
        <Glow className="left-1/2 top-20 h-[400px] w-[700px] -translate-x-1/2 bg-indigo-600/10" />
        <div className="relative mx-auto max-w-6xl px-6">
          <div className="text-center">
            <SectionTag><Zap className="h-3.5 w-3.5" /> Features</SectionTag>
            <h2 className="mt-5 text-3xl font-semibold tracking-tight text-white md:text-4xl">
              Unlock new possibilities, AI-powered
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-slate-400">
              Every patient conversation — answered, booked and attributed in one workspace.
            </p>
          </div>
          <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {features.map((f) => (
              <div
                key={f.title}
                className="group rounded-2xl border border-white/10 bg-white/[0.03] p-6 transition-colors hover:border-violet-500/40 hover:bg-white/[0.05]"
              >
                <div className="inline-flex rounded-xl bg-gradient-to-br from-violet-500/20 to-indigo-500/20 p-2.5 text-violet-300">
                  <f.icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 text-lg font-semibold text-white">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Platform */}
      <section id="platform" className="relative py-24">
        <div className="orb-3d animate-float-slow pointer-events-none absolute right-[4%] top-12 hidden h-16 w-16 lg:block" aria-hidden />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-6 lg:grid-cols-2">
          <div>
            <SectionTag><Database className="h-3.5 w-3.5" /> Complete practice platform</SectionTag>
            <h2 className="mt-5 text-3xl font-semibold tracking-tight text-white">
              Your whole practice, in one system you own
            </h2>
            <p className="mt-4 leading-relaxed text-slate-400">
              Pydental isn&apos;t just the conversation layer — it&apos;s a full patient system.
              Charts, schedule, treatment plans, documents, insurance and payments live in your own
              database, and every AI agent works directly on that data.
            </p>
            <ul className="mt-6 space-y-3">
              {[
                "Patient charts with treatment plans, documents, X-rays, insurance and payments",
                "Booking calendar that mirrors to Google Calendar automatically",
                "AI agents read the chart, so every reply and call is personalized",
                "Already on OpenDental? One-click import is coming — no risk to your live setup",
              ].map((t) => (
                <li key={t} className="flex items-start gap-2.5 text-sm text-slate-300">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-violet-400" /> {t}
                </li>
              ))}
            </ul>
          </div>
          <div className="relative">
            <div className="absolute -inset-1 rounded-3xl bg-gradient-to-r from-violet-600/30 to-indigo-600/30 blur-xl" />
            <div className="relative space-y-3 rounded-2xl border border-white/10 bg-night-900 p-6 shadow-2xl">
              {[
                ["Patient chart", "Robert Kim · Implant #30 · plan presented", "violet"],
                ["Schedule", "Fri Jun 12 · 9:00 Maria H. · 16:00 Emily T. (new)", "indigo"],
                ["Insurance", "Delta Dental PPO · $1,260 benefits remaining", "fuchsia"],
                ["Payments", "$1,180 financing · 12-month plan active", "emerald"],
                ["AI agent Mila", "“Booked Aisha's crown seat for Tue 3:00 PM ✓”", "violet"],
              ].map(([title, sub], i) => (
                <div
                  key={title as string}
                  className="animate-float-slow rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 backdrop-blur transition-colors hover:border-violet-500/40"
                  style={{ animationDelay: `${i * 0.8}s`, animationDuration: "11s" }}
                >
                  <p className="text-sm font-semibold text-white">{title}</p>
                  <p className="mt-0.5 text-xs text-slate-400">{sub}</p>
                </div>
              ))}
              <p className="flex items-center gap-2 pt-1 text-xs text-emerald-400">
                <ShieldCheck className="h-4 w-4" /> Your data, your database — exportable anytime
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Benefits */}
      <section className="relative py-24">
        <Glow className="right-0 top-0 h-[300px] w-[500px] bg-fuchsia-600/10" />
        <div className="relative mx-auto max-w-6xl px-6">
          <div className="text-center">
            <SectionTag><Star className="h-3.5 w-3.5" /> Benefits</SectionTag>
            <h2 className="mt-5 text-3xl font-semibold tracking-tight text-white md:text-4xl">Your benefits</h2>
          </div>
          <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {benefits.map((b) => (
              <div key={b.title} className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
                <h3 className="font-semibold text-white">{b.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">{b.body}</p>
              </div>
            ))}
          </div>

          {/* Stats */}
          <div className="mt-20 grid grid-cols-2 gap-8 text-center md:grid-cols-4">
            {[
              ["8 sec", "average first response"],
              ["74%", "conversations handled by AI"],
              ["+31", "recalls booked per campaign"],
              ["24/7", "phones answered"],
            ].map(([v, l]) => (
              <div key={l}>
                <p className="bg-gradient-to-r from-violet-400 to-indigo-400 bg-clip-text text-4xl font-semibold tracking-tight text-transparent md:text-5xl">
                  {v}
                </p>
                <p className="mt-2 text-sm text-slate-400">{l}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Testimonials */}
      <section id="testimonials" className="relative py-24">
        <div className="relative mx-auto max-w-6xl px-6">
          <div className="text-center">
            <SectionTag><Star className="h-3.5 w-3.5" /> Customers</SectionTag>
            <h2 className="mt-5 text-3xl font-semibold tracking-tight text-white md:text-4xl">
              Clinics love using Pydental
            </h2>
          </div>
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {testimonials.map((t) => (
              <figure key={t.name} className="flex flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-6">
                <div className="flex gap-1 text-amber-400">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star key={i} className="h-4 w-4 fill-current" />
                  ))}
                </div>
                <blockquote className="mt-4 flex-1 text-sm leading-relaxed text-slate-300">
                  &ldquo;{t.quote}&rdquo;
                </blockquote>
                <figcaption className="mt-5">
                  <p className="text-sm font-semibold text-white">{t.name}</p>
                  <p className="text-xs text-slate-500">{t.role}</p>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      {/* Easy to use */}
      <section className="relative py-24">
        <Glow className="left-0 top-20 h-[300px] w-[500px] bg-violet-600/10" />
        <div className="relative mx-auto max-w-4xl px-6 text-center">
          <SectionTag><Zap className="h-3.5 w-3.5" /> Easy to use</SectionTag>
          <h2 className="mt-5 text-3xl font-semibold tracking-tight text-white md:text-4xl">
            Live in an afternoon
          </h2>
          <div className="mt-12 grid gap-5 text-left md:grid-cols-3">
            {[
              ["01", "Create your workspace", "Sign up, add your team, and your patient system is ready — schedule, charts and channels included."],
              ["02", "Turn on your agents", "Pick ready-made recall, reminder and FAQ flows, or build your own. Assign a voice agent to your line."],
              ["03", "Watch revenue compound", "Bookings, recovered no-shows and accepted treatment — attributed to the agent that earned them."],
            ].map(([n, title, body]) => (
              <div key={n} className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
                <span className="text-sm font-semibold text-violet-400">{n}</span>
                <h3 className="mt-3 font-semibold text-white">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="relative py-24">
        <Glow className="left-1/2 top-10 h-[400px] w-[800px] -translate-x-1/2 bg-indigo-600/15" />
        <div className="relative mx-auto max-w-6xl px-6">
          <div className="text-center">
            <SectionTag><Sparkles className="h-3.5 w-3.5" /> Pricing</SectionTag>
            <h2 className="mt-5 text-3xl font-semibold tracking-tight text-white md:text-4xl">Get your package</h2>
            <p className="mx-auto mt-3 max-w-xl text-slate-400">
              Create your clinic workspace free. Upgrade when you connect your channels.
            </p>
          </div>
          <div className="mt-12 grid items-stretch gap-5 lg:grid-cols-3">
            {plans.map((p) => (
              <div
                key={p.name}
                className={`relative flex flex-col rounded-3xl border p-7 ${
                  p.featured
                    ? "border-violet-500/50 bg-gradient-to-b from-violet-600/15 to-night-900 shadow-2xl shadow-violet-600/20"
                    : "border-white/10 bg-white/[0.03]"
                }`}
              >
                {p.featured && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-gradient-to-r from-violet-500 to-indigo-500 px-3.5 py-1 text-xs font-semibold text-white">
                    Most popular
                  </span>
                )}
                <h3 className="font-semibold text-white">{p.name}</h3>
                <p className="mt-1 text-sm text-slate-400">{p.blurb}</p>
                <p className="mt-5 text-4xl font-semibold tracking-tight text-white">
                  {p.price}
                  <span className="ml-1 text-sm font-normal text-slate-500">{p.period}</span>
                </p>
                <ul className="mt-6 flex-1 space-y-2.5">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5 text-sm text-slate-300">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-violet-400" /> {f}
                    </li>
                  ))}
                </ul>
                <Link
                  href="/signup"
                  className={`mt-7 rounded-xl px-5 py-3 text-center text-sm font-semibold transition-opacity hover:opacity-90 ${
                    p.featured
                      ? "bg-gradient-to-r from-violet-500 to-indigo-500 text-white shadow-lg shadow-violet-600/30"
                      : "border border-white/15 text-white hover:bg-white/5"
                  }`}
                >
                  {p.cta}
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="relative py-24">
        <div className="relative mx-auto max-w-4xl px-6 text-center">
          <Glow className="left-1/2 top-0 h-[300px] w-[600px] -translate-x-1/2 bg-violet-600/20" />
          <h2 className="relative text-3xl font-semibold tracking-tight text-white md:text-5xl">
            Make your clinic more efficient.
            <br />
            <span className="bg-gradient-to-r from-violet-400 to-indigo-400 bg-clip-text text-transparent">
              From this moment.
            </span>
          </h2>
          <Link
            href="/signup"
            className="relative mt-9 inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-500 to-indigo-500 px-7 py-3.5 text-sm font-semibold text-white shadow-xl shadow-violet-600/30 transition-opacity hover:opacity-90"
          >
            Create your workspace <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative border-t border-white/5 pt-14">
        <div className="mx-auto max-w-6xl px-6">
          <div className="flex flex-wrap items-start justify-between gap-8 pb-12">
            <div className="max-w-xs">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 text-white">
                  <Sparkles className="h-4 w-4" />
                </div>
                <span className="font-semibold text-white">Pydental</span>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-slate-500">
                The calm workspace for dental clinics — voice, WhatsApp, SMS, email and pipeline in one place.
              </p>
            </div>
            <div className="flex gap-16 text-sm">
              <div>
                <p className="font-semibold text-white">Product</p>
                <ul className="mt-3 space-y-2 text-slate-500">
                  <li><a href="#features" className="hover:text-white">Features</a></li>
                  <li><a href="#pricing" className="hover:text-white">Pricing</a></li>
                  <li><Link href="/signup" className="hover:text-white">Get started</Link></li>
                </ul>
              </div>
              <div>
                <p className="font-semibold text-white">Integrations</p>
                <ul className="mt-3 space-y-2 text-slate-500">
                  <li>Vapi · OpenRouter</li>
                  <li>WhatsApp Business</li>
                  <li>Twilio · Retell AI · Stripe</li>
                </ul>
              </div>
            </div>
          </div>
          <p className="pb-6 text-xs text-slate-600">© 2026 Pydental. All rights reserved.</p>
        </div>
        <div
          aria-hidden
          className="select-none overflow-hidden bg-gradient-to-b from-white/10 to-transparent bg-clip-text text-center text-[18vw] font-bold leading-[0.8] tracking-tighter text-transparent"
        >
          pydental
        </div>
      </footer>
    </div>
  );
}
