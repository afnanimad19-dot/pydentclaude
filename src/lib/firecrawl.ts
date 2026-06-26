// Firecrawl — turns web pages / whole sites into clean text for the agents
// (deeper website + competitor research than a plain fetch). Set FIRECRAWL_API_KEY.
// Falls back to a plain HTML→text fetch when no key is set.

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function norm(url: string): string {
  let u = String(url || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

// Single page → markdown/text.
export async function firecrawlScrape(url: string): Promise<string> {
  const target = norm(url);
  if (!target) return "Give me a URL.";
  const key = process.env.FIRECRAWL_API_KEY;
  if (key) {
    try {
      const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url: target, formats: ["markdown"], onlyMainContent: true }),
        signal: AbortSignal.timeout(45000),
      });
      const j = await res.json();
      if (res.ok && j?.data?.markdown) return `Content of ${target}:\n\n${String(j.data.markdown).slice(0, 12000)}`;
    } catch { /* fall through */ }
  }
  // Fallback: plain fetch.
  try {
    const res = await fetch(target, { headers: { "User-Agent": "PydentBot/1.0" }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return `Couldn't load ${target} (${res.status}).`;
    return `Content of ${target} (basic extraction${process.env.FIRECRAWL_API_KEY ? "" : " — add FIRECRAWL_API_KEY for full crawls"}):\n\n${htmlToText(await res.text()).slice(0, 10000)}`;
  } catch (e) {
    return `Couldn't read ${target}: ${e instanceof Error ? e.message : "error"}`;
  }
}

// Whole site → combined text (Firecrawl crawl, polled). Capped pages.
export async function firecrawlCrawl(url: string, limit = 15): Promise<string> {
  const target = norm(url);
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return firecrawlScrape(target); // no key → just the one page
  try {
    const start = await fetch("https://api.firecrawl.dev/v1/crawl", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: target, limit, scrapeOptions: { formats: ["markdown"], onlyMainContent: true } }),
      signal: AbortSignal.timeout(20000),
    });
    const sj = await start.json();
    const id = sj?.id;
    if (!start.ok || !id) return firecrawlScrape(target);
    // Poll up to ~50s.
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const poll = await fetch(`https://api.firecrawl.dev/v1/crawl/${id}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
      const pj = await poll.json();
      if (pj?.status === "completed") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pages = (pj.data ?? []).map((d: any) => `# ${d.metadata?.title ?? d.metadata?.sourceURL ?? ""}\n${d.markdown ?? ""}`).join("\n\n---\n\n");
        return `Crawled ${pj.data?.length ?? 0} pages of ${target}:\n\n${pages.slice(0, 18000)}`;
      }
      if (pj?.status === "failed") break;
    }
    return `Crawl of ${target} is taking a while — try a single page (scrape) or a smaller site.`;
  } catch {
    return firecrawlScrape(target);
  }
}
