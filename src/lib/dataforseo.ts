// Real SEO data for Sam via DataForSEO (the same provider the open-seo project
// uses). Set DATAFORSEO_API_KEY in Netlify to the base64 of "login:password"
// (Authorization: Basic <key>) — identical to open-seo's convention.
//
// Keyword research, competitor discovery, what a domain ranks for, backlinks,
// and live SERP checks — so Sam grounds advice in real numbers, not guesses.

const API = "https://api.dataforseo.com";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function dfs(path: string, task: Record<string, any>): Promise<any | string> {
  const key = process.env.DATAFORSEO_API_KEY;
  if (!key) return "DataForSEO isn't configured (add DATAFORSEO_API_KEY in Netlify — the base64 of your login:password).";
  try {
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { Authorization: `Basic ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify([task]),
      signal: AbortSignal.timeout(60_000),
    });
    const json = await res.json();
    if (!res.ok) return `DataForSEO error (${res.status}): ${JSON.stringify(json).slice(0, 200)}`;
    const t = json?.tasks?.[0];
    if (t?.status_code && t.status_code !== 20000) return `DataForSEO: ${t.status_message ?? "task failed"}.`;
    return t?.result ?? [];
  } catch (e) {
    return `DataForSEO request failed: ${e instanceof Error ? e.message : "error"}`;
  }
}

const domainOf = (s: string) => String(s || "").replace(/^https?:\/\//i, "").replace(/\/.*$/, "").trim();

// 1) Keyword ideas with search volume / competition / CPC for a seed term.
export async function keywordResearch(seed: string, locationCode = 2840, language = "en"): Promise<string> {
  const r = await dfs("/v3/dataforseo_labs/google/keyword_ideas/live", { keywords: [seed], location_code: locationCode, language_code: language, limit: 12, order_by: ["keyword_info.search_volume,desc"] });
  if (typeof r === "string") return r;
  const items = r?.[0]?.items ?? [];
  if (!items.length) return `No keyword ideas found for "${seed}".`;
  const rows = items.slice(0, 12).map((it: any) => {
    const k = it.keyword; const ki = it.keyword_info ?? {};
    return `  • ${k} — vol ${ki.search_volume ?? "?"}/mo, competition ${ki.competition_level ?? ki.competition ?? "?"}, CPC $${ki.cpc ?? "?"}`;
  }).join("\n");
  return `Keyword ideas for "${seed}":\n${rows}`;
}

// 2) Competing domains for a target site.
export async function findCompetitors(target: string, locationCode = 2840, language = "en"): Promise<string> {
  const r = await dfs("/v3/dataforseo_labs/google/competitors_domain/live", { target: domainOf(target), location_code: locationCode, language_code: language, limit: 10 });
  if (typeof r === "string") return r;
  const items = r?.[0]?.items ?? [];
  if (!items.length) return `No competitors found for ${domainOf(target)}.`;
  const rows = items.slice(0, 10).map((it: any) => `  • ${it.domain} — ${it.metrics?.organic?.count ?? it.full_domain_metrics?.organic?.count ?? "?"} ranking keywords`).join("\n");
  return `Top organic competitors of ${domainOf(target)}:\n${rows}`;
}

// 3) What keywords a domain already ranks for (the clinic or a competitor).
export async function rankedKeywords(target: string, locationCode = 2840, language = "en"): Promise<string> {
  const r = await dfs("/v3/dataforseo_labs/google/ranked_keywords/live", { target: domainOf(target), location_code: locationCode, language_code: language, limit: 15, order_by: ["ranked_serp_element.serp_item.rank_group,asc"] });
  if (typeof r === "string") return r;
  const items = r?.[0]?.items ?? [];
  if (!items.length) return `No ranking keywords found for ${domainOf(target)}.`;
  const rows = items.slice(0, 15).map((it: any) => {
    const kw = it.keyword_data?.keyword; const pos = it.ranked_serp_element?.serp_item?.rank_group; const vol = it.keyword_data?.keyword_info?.search_volume;
    return `  • #${pos ?? "?"} — ${kw} (vol ${vol ?? "?"})`;
  }).join("\n");
  return `${domainOf(target)} ranks for:\n${rows}`;
}

// 4) Backlink profile summary.
export async function backlinksSummary(target: string): Promise<string> {
  const r = await dfs("/v3/backlinks/summary/live", { target: domainOf(target), internal_list_limit: 1, backlinks_status_type: "live" });
  if (typeof r === "string") return r;
  const s = r?.[0];
  if (!s) return `No backlink data for ${domainOf(target)}.`;
  return `Backlinks for ${domainOf(target)}: ${s.backlinks ?? "?"} backlinks from ${s.referring_domains ?? "?"} referring domains. Domain rank: ${s.rank ?? "?"}.`;
}

// 5) Live SERP — who ranks for a keyword right now (top 10).
export async function serpCheck(keyword: string, locationCode = 2840, language = "en"): Promise<string> {
  const r = await dfs("/v3/serp/google/organic/live/advanced", { keyword, location_code: locationCode, language_code: language, depth: 10 });
  if (typeof r === "string") return r;
  const items = (r?.[0]?.items ?? []).filter((i: any) => i.type === "organic");
  if (!items.length) return `No SERP results for "${keyword}".`;
  const rows = items.slice(0, 10).map((it: any) => `  ${it.rank_group}. ${it.domain} — ${(it.title ?? "").slice(0, 70)}`).join("\n");
  return `Google top results for "${keyword}":\n${rows}`;
}
