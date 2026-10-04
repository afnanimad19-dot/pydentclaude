import { assertSafeUrl, UnsafeUrlError } from "@/lib/safe-url";
import { safeFetchText, type SafeFetchDeps } from "@/lib/safe-fetch";

// Website knowledge import — shared by the legacy /api/kb/website route and
// (later) Central Knowledge Base URL ingestion / refresh. Moved verbatim from
// src/app/api/kb/website/route.ts: same order of attempts (Firecrawl whole-site
// crawl if configured → bounded same-domain crawl → the marketing engine's
// browser-grade fetcher), same limits, same page markers, same messages and
// statuses.
//
// Security: the Phase 0 SSRF boundary is reused, never re-implemented —
// assertSafeUrl (lib/safe-url.ts) validates the target BEFORE any fetch or
// hand-off to Firecrawl / the engine, and every URL Pydent itself fetches (the
// target, sitemap, crawled pages, every redirect hop) goes through safeFetchText
// (lib/safe-fetch.ts). No authorization here — that stays in the routes. The
// library never takes a workspace from a request: the only workspace-bound
// step (the engine fallback's credentials) is injected by the caller, which
// builds it from the authenticated session (engineFetchForWorkspace).

export const MAX_PAGES = 30;
export const PAGE_TIMEOUT = 12_000;
export const FIRECRAWL_PAGE_LIMIT = 20;
export const WEBSITE_MAX_CHARS = 200_000;
const EXCLUDE = /(wp-admin|wp-login|wp-json|\/login|\/cart|\/checkout|\/feed|\/tag\/|\/category\/|\/author\/|\/search|\/wp-content\/|attachment|sample-page|privacy|terms|\.(jpe?g|png|gif|webp|svg|pdf|css|js|xml|ico|mp4|zip)(\?|$)|[?#])/i;

export type WebsiteSource = "firecrawl" | "crawl" | "engine";

export type WebsiteResult =
  | { ok: true; source: WebsiteSource; title: string; text: string; pages?: string[] }
  | { ok: false; status: 400 | 422 | 500 | 502; error: string; code?: string };

export interface WebsiteDeps {
  /** SSRF validation of the target (throws UnsafeUrlError). */
  assertSafe: (url: string) => Promise<unknown>;
  /** One page through the SSRF-safe fetcher: text, or null on an HTTP/network failure; throws UnsafeUrlError on an unsafe hop. */
  fetchPage: (url: string) => Promise<string | null>;
  /** Firecrawl whole-site crawl when configured, else null. */
  firecrawl: ((url: string, limit: number) => Promise<string>) | null;
  /** The engine's browser-grade fetcher (never throws; null when unavailable). */
  engineFetch: (url: string) => Promise<string | null>;
}

/**
 * The SSRF-safe page fetch the legacy route has always used. `transport` is
 * only for tests (fake DNS + network through the REAL safeFetchText); production
 * passes nothing and gets safeFetchText's own defaults.
 */
export async function fetchPageSafely(url: string, transport?: SafeFetchDeps): Promise<string | null> {
  try {
    const opts = { timeoutMs: PAGE_TIMEOUT, headers: { "User-Agent": "PydentBot/1.0 (+knowledge-import)" } };
    const res = transport ? await safeFetchText(url, opts, transport) : await safeFetchText(url, opts);
    return res.ok ? res.text : null;
  } catch (e) {
    // A blocked hop (private address / unsafe redirect) is surfaced to the caller.
    if (e instanceof UnsafeUrlError) throw e;
    return null;
  }
}

// Read the page through the engine's browser-grade fetcher. Returns null when
// the engine isn't configured or came back empty, so callers keep their error.
// `workspaceId` MUST come from the authenticated session (it selects the
// workspace's engine credentials) — never from a request body.
/* eslint-disable @typescript-eslint/no-explicit-any */
export function engineFetchForWorkspace(workspaceId: string | null): (url: string) => Promise<string | null> {
  return async (url: string) => {
    try {
      const { getHfxCreds, hfxCall, hfxConfigured } = await import("@/lib/hyperfx");
      const creds = await getHfxCreds(workspaceId);
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
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Production dependencies. FIRECRAWL_API_KEY is read per call, as the route always did. */
export function defaultWebsiteDeps(engineFetch: (url: string) => Promise<string | null>): WebsiteDeps {
  return {
    assertSafe: (url) => assertSafeUrl(url),
    fetchPage: (url) => fetchPageSafely(url),
    firecrawl: process.env.FIRECRAWL_API_KEY
      ? async (url, limit) => {
          const { firecrawlCrawl } = await import("@/lib/firecrawl");
          return firecrawlCrawl(url, limit);
        }
      : null,
    engineFetch,
  };
}

export function htmlToText(html: string): string {
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

// What a clinic chatbot actually needs, most valuable first. Doctor/team and
// service/treatment pages beat blog posts — a slug like
// "sleep-apnea-and-diabetes" is an article, not the clinic's sleep-apnea page.
export function pageScore(u: URL): number {
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

export function sameSite(url: string, origin: URL): boolean {
  try {
    const u = new URL(url, origin);
    return u.host.replace(/^www\./, "") === origin.host.replace(/^www\./, "");
  } catch {
    return false;
  }
}

/** Sitemap entries and crawled sub-pages: an unsafe hop just skips that page. */
async function fetchOptional(deps: WebsiteDeps, url: string): Promise<string | null> {
  try {
    return await deps.fetchPage(url);
  } catch {
    return null;
  }
}

/** Page URLs from sitemap.xml (one level of sitemap-index supported). */
async function urlsFromSitemap(deps: WebsiteDeps, origin: URL): Promise<string[]> {
  const xml = await fetchOptional(deps, new URL("/sitemap.xml", origin).href);
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
      const child = await fetchOptional(deps, c);
      if (child) all.push(...[...child.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]));
    }
    return all;
  }
  return locs;
}

/** Same-domain <a href> targets found in a page's HTML. */
export function urlsFromLinks(html: string, origin: URL): string[] {
  return [...html.matchAll(/href=["']([^"'#]+)["']/gi)]
    .map((m) => { try { return new URL(m[1], origin).href; } catch { return ""; } })
    .filter(Boolean);
}

/** Pick the pages worth importing: scored by clinic value, capped, deduped. */
export function selectPages(candidates: string[], origin: URL): string[] {
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
export function stripBoilerplate(pages: { url: string; text: string }[]): { url: string; text: string }[] {
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

/**
 * Import a website's readable text. `rawUrl` is the caller's `url` value as
 * received. A non-UnsafeUrlError thrown by the SSRF check or by Firecrawl
 * propagates, exactly as it did from the legacy route.
 */
export async function importWebsite(rawUrl: unknown, deps: WebsiteDeps): Promise<WebsiteResult> {
  if (!rawUrl || typeof rawUrl !== "string") {
    return { ok: false, status: 400, error: "Provide a website URL." };
  }
  let target = rawUrl.trim();
  if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
  try {
    const u = new URL(target);
    if (!/^https?:$/.test(u.protocol)) throw new Error("bad protocol");
  } catch {
    return { ok: false, status: 400, error: "That doesn't look like a valid URL." };
  }
  // SSRF: refuse private / internal / metadata targets before ANY fetch or
  // hand-off to Firecrawl / the engine.
  try {
    await deps.assertSafe(target);
  } catch (e) {
    if (e instanceof UnsafeUrlError) return { ok: false, status: 400, error: e.message, code: e.code };
    throw e;
  }

  // When Firecrawl is configured, import the WHOLE site (much richer knowledge).
  if (deps.firecrawl) {
    const text = await deps.firecrawl(target, FIRECRAWL_PAGE_LIMIT);
    if (text && !/^Couldn't|^Crawl of/.test(text)) {
      return { ok: true, source: "firecrawl", title: target, text: text.slice(0, WEBSITE_MAX_CHARS) };
    }
    // else fall through to single-page fetch
  }

  try {
    const origin = new URL(target);
    const homeHtml = await deps.fetchPage(target);
    if (homeHtml) {
      const titleMatch = homeHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? htmlToText(titleMatch[1]).slice(0, 200) : target;
      const homeText = htmlToText(homeHtml);
      if (homeText.length >= 40) {
        // Discover internal pages: sitemap first, homepage links as fallback.
        let candidates = await urlsFromSitemap(deps, origin);
        if (!candidates.length) candidates = urlsFromLinks(homeHtml, origin);
        const pages: { url: string; text: string }[] = [{ url: target, text: homeText }];
        const picked = selectPages(candidates, origin);
        for (let i = 0; i < picked.length; i += 6) {
          const batch = await Promise.all(
            picked.slice(i, i + 6).map(async (pageUrl) => {
              const html = await fetchOptional(deps, pageUrl);
              return html ? { url: pageUrl, text: htmlToText(html) } : null;
            })
          );
          for (const pg of batch) if (pg && pg.text.length >= 200) pages.push(pg);
        }
        const cleaned = stripBoilerplate(pages);
        // Provenance markers let retrieval report WHICH page a fact came from.
        let combined = cleaned.map((p) => `--- Website page: ${p.url} ---\n${p.text}`).join("\n\n");
        combined = combined.slice(0, WEBSITE_MAX_CHARS);
        return { ok: true, source: "crawl", title, text: combined, pages: cleaned.map((p) => p.url) };
      }
    }
    // Thin or blocked page (usually a JavaScript-rendered site) → let the
    // engine's browser-grade fetcher render it.
    const rendered = await deps.engineFetch(target);
    if (rendered) return { ok: true, source: "engine", title: target, text: rendered.slice(0, WEBSITE_MAX_CHARS) };
    return homeHtml
      ? { ok: false, status: 422, error: "The page had little readable text (it may be JavaScript-rendered, and the marketing engine couldn't read it either)." }
      : { ok: false, status: 502, error: "Could not load the page." };
  } catch (e) {
    // A redirect / crawled page that resolves into a private network: refuse, and
    // don't hand the same target to the engine either.
    if (e instanceof UnsafeUrlError) return { ok: false, status: 400, error: e.message, code: e.code };
    // Network failure on the direct fetch — the engine may still reach it.
    const rendered = await deps.engineFetch(target);
    if (rendered) return { ok: true, source: "engine", title: target, text: rendered.slice(0, WEBSITE_MAX_CHARS) };
    return { ok: false, status: 500, error: e instanceof Error ? e.message : "Failed to fetch the website." };
  }
}

/** The legacy route's exact HTTP response for a result (body keys and order preserved). */
export function websiteResponse(r: WebsiteResult): { status: number; body: Record<string, unknown> } {
  if (!r.ok) return { status: r.status, body: r.code !== undefined ? { error: r.error, code: r.code } : { error: r.error } };
  return { status: 200, body: r.pages ? { ok: true, title: r.title, text: r.text, pages: r.pages } : { ok: true, title: r.title, text: r.text } };
}
