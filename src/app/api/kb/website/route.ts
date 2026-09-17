import { NextRequest, NextResponse } from "next/server";
import { getHfxCreds, hfxCall, hfxConfigured } from "@/lib/hyperfx";

// Fetches a clinic's web page and returns its readable text, so an agent can learn
// from the website (hours, services, pricing, FAQs). Server-side to avoid CORS.
// Order of attempts: Firecrawl whole-site crawl (if configured) → plain fetch →
// the marketing engine's web_fetch_page (renders JavaScript sites properly), so
// "Fetch site" works on modern JS-built clinic websites too.

export const runtime = "nodejs";
export const maxDuration = 60;

// Read the page through the engine's browser-grade fetcher. Returns null when
// the engine isn't configured or came back empty, so callers keep their error.
/* eslint-disable @typescript-eslint/no-explicit-any */
async function fetchViaEngine(url: string, ws: string | null): Promise<string | null> {
  try {
    const creds = await getHfxCreds(ws);
    if (!hfxConfigured(creds)) return null;
    const r = await hfxCall("web_fetch_page", { url }, creds);
    if (!r.ok) return null;
    const chunks: string[] = [];
    const push = (v: unknown) => {
      if (typeof v === "string" && v.trim()) chunks.push(v);
    };
    push(r.data);
    const d: any = r.data;
    if (d && typeof d === "object") {
      push(d.text);
      push(d.content);
      push(d.markdown);
      push(d.page_text);
      push(d.result);
    }
    for (const c of r.content ?? []) push((c as any)?.text);
    const text = chunks.join("\n").trim();
    return text.length >= 40 ? text : null;
  } catch {
    return null;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Bounded same-domain crawl ────────────────────────────────────────────────
// The old importer stored ONLY the homepage, so facts living on subpages
// (doctor profiles, treatment pages) were never in the knowledge base at all.
// This crawl keeps it useful and polite:
//   * discovery via sitemap.xml when present (WordPress sitemap indexes
//     included), else same-domain links found on the homepage;
//   * clinic-relevant pages first (team/doctors, services/treatments, sleep,
//     about, contact, FAQ, prices), hard cap MAX_PAGES;
//   * admin/login/feed/media/parameter URLs excluded;
//   * every page stored under a "--- Website page: <url> ---" marker so a
//     retrieved fact traces back to its page;
//   * nav/footer boilerplate that repeats on most pages is stripped once.
const MAX_PAGES = 30;
const PAGE_TIMEOUT = 12_000;
const EXCLUDE = /(wp-admin|wp-login|wp-json|\/login|\/cart|\/checkout|\/feed|\/tag\/|\/category\/|\/author\/|\/search|\/wp-content\/|attachment|sample-page|privacy|terms|\.(jpe?g|png|gif|webp|svg|pdf|css|js|xml|ico|mp4|zip)(\?|$)|[?#])/i;

// What a clinic chatbot actually needs, most valuable first. Doctor/team and
// service/treatment pages beat blog posts — a slug like
// "sleep-apnea-and-diabetes" is an article, not the clinic's sleep-apnea page.
function pageScore(u: URL): number {
  const segs = u.pathname.toLowerCase().split("/").filter(Boolean);
  // Segment-anchored, not substring: a blog slug like
  // "can-a-dentist-diagnose-sleep-apnea" must NOT match the team tier.
  const hasSeg = (...names: string[]) => segs.some((x) => names.includes(x));
  if (hasSeg("our-team", "team", "doctors", "doctor", "dentists", "staff") || segs.some((x) => x.startsWith("dr-"))) return 5;
  if (hasSeg("our-services", "services", "service", "treatments", "treatment", "ortho-center")) return 4;
  if (hasSeg("about", "about-us", "contact", "contact-us", "location", "locations", "faq", "faqs", "pricing", "prices", "fees", "insurance", "sleep-apnea", "hours", "opening-hours")) return 3;
  // Root-level long-slug pages are almost always blog posts — last.
  if (segs.length === 1 && (segs[0].match(/-/g)?.length ?? 0) >= 3) return 0;
  return 1;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "PydentBot/1.0 (+knowledge-import)" },
      redirect: "follow",
      signal: AbortSignal.timeout(PAGE_TIMEOUT),
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

function sameSite(url: string, origin: URL): boolean {
  try {
    const u = new URL(url, origin);
    return u.host.replace(/^www\./, "") === origin.host.replace(/^www\./, "");
  } catch {
    return false;
  }
}

/** Page URLs from sitemap.xml (one level of sitemap-index supported). */
async function urlsFromSitemap(origin: URL): Promise<string[]> {
  const xml = await fetchText(new URL("/sitemap.xml", origin).href);
  if (!xml) return [];
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
  if (!locs.length) return [];
  // Sitemap index → read the child sitemaps. page-sitemap (real site pages)
  // first; post-sitemap (blog articles) last so pages win the candidate order.
  if (/<sitemapindex/i.test(xml)) {
    const rank = (l: string) => (/page/i.test(l) ? 0 : /post/i.test(l) ? 2 : 1);
    const children = locs.filter((l) => sameSite(l, origin)).sort((a, b) => rank(a) - rank(b)).slice(0, 4);
    const all: string[] = [];
    for (const c of children) {
      const child = await fetchText(c);
      if (child) all.push(...[...child.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]));
    }
    return all;
  }
  return locs;
}

/** Same-domain <a href> targets found in a page's HTML. */
function urlsFromLinks(html: string, origin: URL): string[] {
  return [...html.matchAll(/href=["']([^"'#]+)["']/gi)]
    .map((m) => { try { return new URL(m[1], origin).href; } catch { return ""; } })
    .filter(Boolean);
}

/** Pick the pages worth importing: scored by clinic value, capped, deduped. */
function selectPages(candidates: string[], origin: URL): string[] {
  const seen = new Set<string>([origin.href.replace(/\/$/, "")]);
  const scored: { url: string; score: number; order: number }[] = [];
  for (const raw of candidates) {
    if (!sameSite(raw, origin) || EXCLUDE.test(raw)) continue;
    const norm = raw.replace(/\/$/, "");
    if (seen.has(norm)) continue;
    seen.add(norm);
    try {
      scored.push({ url: raw, score: pageScore(new URL(raw, origin)), order: scored.length });
    } catch { /* unparsable href */ }
  }
  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, MAX_PAGES)
    .map((x) => x.url);
}

/** Drop nav/footer lines that repeat on most pages (menu spam in every chunk). */
function stripBoilerplate(pages: { url: string; text: string }[]): { url: string; text: string }[] {
  if (pages.length < 3) return pages;
  const lineCount = new Map<string, number>();
  for (const p of pages) {
    for (const line of new Set(p.text.split("\n").map((l) => l.trim()).filter((l) => l.length > 2))) {
      lineCount.set(line, (lineCount.get(line) ?? 0) + 1);
    }
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.6));
  return pages.map((p) => ({
    url: p.url,
    text: p.text.split("\n").filter((l) => (lineCount.get(l.trim()) ?? 0) < threshold).join("\n").replace(/\n{3,}/g, "\n\n").trim(),
  }));
}

export async function POST(req: NextRequest) {
  const { url, ws } = await req.json().catch(() => ({}));
  if (!url || typeof url !== "string") {
    return NextResponse.json({ error: "Provide a website URL." }, { status: 400 });
  }
  let target = url.trim();
  if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
  try {
    const u = new URL(target);
    if (!/^https?:$/.test(u.protocol)) throw new Error("bad protocol");
  } catch {
    return NextResponse.json({ error: "That doesn't look like a valid URL." }, { status: 400 });
  }

  // When Firecrawl is configured, import the WHOLE site (much richer knowledge).
  if (process.env.FIRECRAWL_API_KEY) {
    const { firecrawlCrawl } = await import("@/lib/firecrawl");
    const text = await firecrawlCrawl(target, 20);
    if (text && !/^Couldn't|^Crawl of/.test(text)) {
      return NextResponse.json({ ok: true, title: target, text: text.slice(0, 200_000) });
    }
    // else fall through to single-page fetch
  }

  try {
    const origin = new URL(target);
    const homeHtml = await fetchText(target);
    if (homeHtml) {
      const titleMatch = homeHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? htmlToText(titleMatch[1]).slice(0, 200) : target;
      const homeText = htmlToText(homeHtml);
      if (homeText.length >= 40) {
        // Discover internal pages: sitemap first, homepage links as fallback.
        let candidates = await urlsFromSitemap(origin);
        if (!candidates.length) candidates = urlsFromLinks(homeHtml, origin);
        const pages: { url: string; text: string }[] = [{ url: target, text: homeText }];
        const picked = selectPages(candidates, origin);
        for (let i = 0; i < picked.length; i += 6) {
          const batch = await Promise.all(
            picked.slice(i, i + 6).map(async (pageUrl) => {
              const html = await fetchText(pageUrl);
              return html ? { url: pageUrl, text: htmlToText(html) } : null;
            })
          );
          for (const pg of batch) if (pg && pg.text.length >= 200) pages.push(pg);
        }
        const cleaned = stripBoilerplate(pages);
        // Provenance markers let retrieval report WHICH page a fact came from.
        let combined = cleaned.map((p) => `--- Website page: ${p.url} ---\n${p.text}`).join("\n\n");
        combined = combined.slice(0, 200_000);
        return NextResponse.json({ ok: true, title, text: combined, pages: cleaned.map((p) => p.url) });
      }
    }
    // Thin or blocked page (usually a JavaScript-rendered site) → let the
    // engine's browser-grade fetcher render it.
    const rendered = await fetchViaEngine(target, ws ?? null);
    if (rendered) return NextResponse.json({ ok: true, title: target, text: rendered.slice(0, 200_000) });
    return NextResponse.json(
      { error: homeHtml ? "The page had little readable text (it may be JavaScript-rendered, and the marketing engine couldn't read it either)." : "Could not load the page." },
      { status: homeHtml ? 422 : 502 }
    );
  } catch (e) {
    // Network failure on the direct fetch — the engine may still reach it.
    const rendered = await fetchViaEngine(target, ws ?? null);
    if (rendered) return NextResponse.json({ ok: true, title: target, text: rendered.slice(0, 200_000) });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to fetch the website." },
      { status: 500 }
    );
  }
}
