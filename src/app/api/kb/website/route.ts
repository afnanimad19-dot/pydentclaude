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
    const res = await fetch(target, {
      headers: { "User-Agent": "PydentBot/1.0 (+knowledge-import)" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      const html = await res.text();
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? htmlToText(titleMatch[1]).slice(0, 200) : target;
      const text = htmlToText(html);
      if (text.length >= 40) {
        return NextResponse.json({ ok: true, title, text: text.slice(0, 200_000) });
      }
    }
    // Thin or blocked page (usually a JavaScript-rendered site) → let the
    // engine's browser-grade fetcher render it.
    const rendered = await fetchViaEngine(target, ws ?? null);
    if (rendered) return NextResponse.json({ ok: true, title: target, text: rendered.slice(0, 200_000) });
    return NextResponse.json(
      { error: res.ok ? "The page had little readable text (it may be JavaScript-rendered, and the marketing engine couldn't read it either)." : `Could not load the page (${res.status}).` },
      { status: res.ok ? 422 : 502 }
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
