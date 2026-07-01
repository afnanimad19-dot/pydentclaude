import Link from "next/link";
import { Sparkles } from "lucide-react";

// Shared shell for the public legal pages (Privacy, Terms, Data Deletion). Matches
// the dark landing-page theme so the pages look part of the product — Meta and
// Google reviewers open these directly, so they need to look real and consistent.

export const LEGAL_COMPANY = "Pydent";
export const LEGAL_CONTACT_EMAIL = "lhdmmarketing@gmail.com";
export const LEGAL_EFFECTIVE = "1 July 2026";

const LEGAL_LINKS: { href: string; label: string }[] = [
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/terms", label: "Terms of Service" },
  { href: "/data-deletion", label: "Data Deletion" },
];

export function LegalShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-night-950 text-slate-300 selection:bg-violet-500/40">
      <header className="sticky top-0 z-30 border-b border-white/5 bg-night-950/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-lg shadow-violet-500/25">
              <Sparkles className="h-5 w-5" />
            </div>
            <span className="text-lg font-semibold tracking-tight text-white">Pydent</span>
          </Link>
          <nav className="flex items-center gap-5 text-sm font-medium text-slate-400">
            {LEGAL_LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="hidden transition-colors hover:text-white sm:inline">{l.label}</Link>
            ))}
            <Link href="/" className="transition-colors hover:text-white">← Home</Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-14">
        <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">{title}</h1>
        <p className="mt-3 text-sm text-slate-400">{subtitle}</p>
        <p className="mt-1 text-xs text-slate-500">Effective {LEGAL_EFFECTIVE}</p>
        <div className="prose-legal mt-10 space-y-8 text-[15px] leading-relaxed text-slate-300">{children}</div>
      </main>

      <footer className="border-t border-white/5">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-4 px-6 py-8 text-sm text-slate-500">
          <span>© 2026 {LEGAL_COMPANY}. All rights reserved.</span>
          <div className="flex flex-wrap gap-4">
            {LEGAL_LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="hover:text-white">{l.label}</Link>
            ))}
          </div>
        </div>
      </footer>
    </div>
  );
}

// Small helpers so each page reads cleanly.
export function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold text-white">{heading}</h2>
      {children}
    </section>
  );
}

export function P({ children }: { children: React.ReactNode }) {
  return <p className="text-slate-300/90">{children}</p>;
}

export function List({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5 text-slate-300/90 marker:text-violet-400">
      {items.map((it, i) => <li key={i}>{it}</li>)}
    </ul>
  );
}
