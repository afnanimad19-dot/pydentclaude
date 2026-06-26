import { NextRequest, NextResponse } from "next/server";

// Fetches a clinic's web page and returns its readable text, so an agent can learn
// from the website (hours, services, pricing, FAQs). Server-side to avoid CORS.

export const runtime = "nodejs";
export const maxDuration = 30;

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
  const { url } = await req.json().catch(() => ({}));
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
    if (!res.ok) {
      return NextResponse.json({ error: `Could not load the page (${res.status}).` }, { status: 502 });
    }
    const html = await res.text();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? htmlToText(titleMatch[1]).slice(0, 200) : target;
    const text = htmlToText(html);
    if (text.length < 40) {
      return NextResponse.json({ error: "The page had little readable text (it may be JavaScript-rendered)." }, { status: 422 });
    }
    return NextResponse.json({ ok: true, title, text: text.slice(0, 200_000) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to fetch the website." },
      { status: 500 }
    );
  }
}
