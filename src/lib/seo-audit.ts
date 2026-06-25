// Fetches a web page and audits its on-page SEO — title, meta description,
// headings, word count, image alts, canonical and FAQ schema — then returns a
// plain-language report with recommendations. No external API needed.

export async function auditPageSeo(url: string): Promise<string> {
  let target = String(url || "").trim();
  if (!target) return "Give me the page URL to audit.";
  if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
  let html: string;
  try {
    const res = await fetch(target, { headers: { "User-Agent": "PydentBot/1.0 (SEO audit)" }, redirect: "follow", signal: AbortSignal.timeout(20000) });
    if (!res.ok) return `Couldn't load ${target} (HTTP ${res.status}).`;
    html = await res.text();
  } catch (e) {
    return `Couldn't load ${target}: ${e instanceof Error ? e.message : "error"}`;
  }

  const pick = (re: RegExp) => (html.match(re)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDesc = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || pick(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => m[1].replace(/<[^>]+>/g, "").trim()).filter(Boolean);
  const h2Count = (html.match(/<h2[^>]*>/gi) || []).length;
  const canonical = pick(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i);
  const imgTags = html.match(/<img\b[^>]*>/gi) || [];
  const imgsNoAlt = imgTags.filter((t) => !/\balt\s*=/.test(t)).length;
  const hasFaqSchema = /"@type"\s*:\s*"FAQPage"/i.test(html);
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const words = text ? text.split(" ").length : 0;

  const recs: string[] = [];
  if (!title) recs.push("Add a <title> tag.");
  else if (title.length < 30 || title.length > 60) recs.push(`Title is ${title.length} chars — aim for 30–60 and include the treatment + city (e.g. “Teeth Whitening in <City> | <Clinic>”).`);
  if (!metaDesc) recs.push("Add a meta description (140–160 chars) with a call to action.");
  else if (metaDesc.length < 120 || metaDesc.length > 165) recs.push(`Meta description is ${metaDesc.length} chars — aim for 140–160.`);
  if (h1s.length === 0) recs.push("Add exactly one <h1> with the main keyword.");
  else if (h1s.length > 1) recs.push(`There are ${h1s.length} H1s — use only one.`);
  if (h2Count < 2) recs.push("Add more H2 subheadings to structure the content.");
  if (words < 600) recs.push(`Only ~${words} words — add depth (FAQ, what to expect, pricing guidance) to rank for treatment terms.`);
  if (imgsNoAlt > 0) recs.push(`${imgsNoAlt} image(s) missing alt text — add descriptive alts (helps SEO + accessibility).`);
  if (!canonical) recs.push("Add a canonical tag.");
  if (!hasFaqSchema) recs.push("Add FAQPage schema (JSON-LD) so AI search engines and Google can cite your answers.");

  return [
    `SEO audit — ${target}`,
    `• Title (${title.length}): ${title || "—"}`,
    `• Meta description (${metaDesc.length}): ${metaDesc || "—"}`,
    `• H1: ${h1s[0] ?? "—"}${h1s.length > 1 ? ` (+${h1s.length - 1} more)` : ""} · H2s: ${h2Count}`,
    `• Words: ~${words} · Images without alt: ${imgsNoAlt} · Canonical: ${canonical ? "yes" : "no"} · FAQ schema: ${hasFaqSchema ? "yes" : "no"}`,
    "",
    recs.length ? `Recommendations:\n${recs.map((r) => `  • ${r}`).join("\n")}` : "Looks solid — no major on-page issues found.",
  ].join("\n");
}
