// A3 — /api/kb/website refactor equivalence. The import moved verbatim to
// lib/kb-website.ts. These tests drive it through the REAL Phase 0 SSRF
// primitives (assertSafeUrl + safeFetchText via fetchPageSafely) with an
// injected DNS table and a fake network — no external request is ever made.
// Expected messages / statuses / bodies are those of the Phase 0 route.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const W = await import("@/lib/kb-website");
const { assertSafeUrl, UnsafeUrlError } = await import("@/lib/safe-url");
const root = path.resolve(import.meta.dirname, "..");
const src = (p) => fs.readFileSync(path.join(root, p), "utf8");

const DNS = {
  "clinic.example.com": ["93.184.215.14"],
  "www.clinic.example.com": ["93.184.215.14"],
  "other.example.org": ["93.184.215.15"],
  "evil.example.com": ["10.0.0.7"],
  "rebind.example.com": ["93.184.215.14", "169.254.169.254"],
};
const resolve = async (h) => {
  if (!(h in DNS)) throw new Error("ENOTFOUND");
  return DNS[h];
};

const page = (title, body) => `<html><head><title>${title}</title><style>.x{}</style></head><body><nav>Home | About | Contact</nav><p>${body}</p><script>var a=1</script><footer>© Clinic footer line</footer></body></html>`;
const filler = (s) => `${s} `.repeat(30);

function harness(site, { firecrawl = null, engine = null } = {}) {
  const requested = [];
  const engineCalls = [];
  const firecrawlCalls = [];
  const requestOnce = async (url) => {
    requested.push(url.href);
    const r = site[url.href];
    if (!r) return { status: 404, location: null, body: "" };
    if (r.throws) throw new Error(r.throws);
    return { status: r.status ?? 200, location: r.location ?? null, body: r.body ?? "" };
  };
  const deps = {
    assertSafe: (u) => assertSafeUrl(u, resolve),
    fetchPage: (u) => W.fetchPageSafely(u, { resolve, requestOnce }),
    firecrawl: firecrawl ? async (u, limit) => { firecrawlCalls.push([u, limit]); return typeof firecrawl === "function" ? firecrawl(u) : firecrawl; } : null,
    engineFetch: async (u) => { engineCalls.push(u); return engine; },
  };
  return { deps, requested, engineCalls, firecrawlCalls };
}
const call = async (url, h) => W.websiteResponse(await W.importWebsite(url, h.deps));

// ------------------------------------------------------------ input

test("missing / non-string URL → 400 'Provide a website URL.'", async () => {
  for (const url of [undefined, null, "", 42, {}]) {
    assert.deepEqual(await call(url, harness({})), { status: 400, body: { error: "Provide a website URL." } }, String(url));
  }
});

test("malformed URL → 400 'That doesn't look like a valid URL.'", async () => {
  for (const url of ["http://", "https://exa mple.com", "https://[bad"]) {
    assert.deepEqual(await call(url, harness({})), { status: 400, body: { error: "That doesn't look like a valid URL." } }, url);
  }
});

test("a scheme-less address is treated as https:// (unchanged normalization)", async () => {
  const h = harness({ "https://clinic.example.com/": { body: page("Clinic", filler("Welcome to our dental clinic")) } });
  const r = await call("  clinic.example.com  ", h);
  assert.equal(r.status, 200);
  assert.equal(h.requested[0], "https://clinic.example.com/");
});

// ------------------------------------------------------------ SSRF (Phase 0 boundary, reused)

test("private / loopback / localhost / link-local / metadata / internal targets → 400 with code; nothing fetched", async () => {
  for (const url of [
    "http://10.1.2.3/", "http://192.168.0.10/", "http://172.20.0.1/", "http://127.0.0.1/", "http://[::1]/", "http://localhost/",
    "http://169.254.169.254/latest/meta-data/", "http://metadata.google.internal/", "http://db.internal/", "https://evil.example.com/",
    "https://rebind.example.com/", "http://clinic.example.com:8080/",
  ]) {
    const h = harness({}, { firecrawl: "whole site", engine: "engine text that is long enough to count as content" });
    const r = await call(url, h);
    assert.equal(r.status, 400, url);
    assert.equal(typeof r.body.code, "string", url);
    assert.deepEqual(Object.keys(r.body), ["error", "code"], url);
    assert.deepEqual(h.requested, [], `${url}: no request was made`);
    assert.deepEqual(h.firecrawlCalls, [], `${url}: not handed to Firecrawl`);
    assert.deepEqual(h.engineCalls, [], `${url}: not handed to the engine`);
  }
});

test("a redirect of the target into a private network → 400; the engine is NOT tried", async () => {
  const h = harness({ "https://clinic.example.com/": { status: 302, location: "http://169.254.169.254/latest/meta-data/" } }, { engine: "x".repeat(100) });
  const r = await call("https://clinic.example.com/", h);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "private_address");
  assert.deepEqual(h.requested, ["https://clinic.example.com/"], "the internal hop was never requested");
  assert.deepEqual(h.engineCalls, []);
});

test("a crawled sub-page redirecting into a private network is skipped, not fatal", async () => {
  const links = `<a href="/team">Team</a><a href="/services">Services</a>`;
  const h = harness({
    "https://clinic.example.com/": { body: page("Clinic", filler("Welcome to our clinic")) + links },
    "https://clinic.example.com/team": { status: 301, location: "http://10.0.0.9/admin" },
    "https://clinic.example.com/services": { body: page("Services", filler("We offer cleaning and whitening")) },
  });
  const r = await call("https://clinic.example.com/", h);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.pages, ["https://clinic.example.com/", "https://clinic.example.com/services"]);
  assert.ok(!h.requested.some((u) => u.includes("10.0.0.9")));
});

test("a non-SSRF error from the safety check propagates (route → 500 as before)", async () => {
  const h = harness({});
  h.deps.assertSafe = async () => { throw new Error("resolver exploded"); };
  await assert.rejects(W.importWebsite("https://clinic.example.com/", h.deps), /resolver exploded/);
});

// ------------------------------------------------------------ crawl

test("bounded crawl: sitemap first, exclusions, same-site only, clinic pages first, 30-page cap, markers", async () => {
  const site = { "https://clinic.example.com/": { body: page("Smile Clinic &amp; Co", filler("Welcome to Smile Clinic")) } };
  const locs = [];
  for (let i = 0; i < 40; i++) {
    const u = `https://clinic.example.com/blog/post-${i}`;
    locs.push(u);
    site[u] = { body: page(`Post ${i}`, filler(`Blog post number ${i} about teeth`)) };
  }
  locs.push("https://clinic.example.com/our-team", "https://clinic.example.com/wp-admin/x", "https://clinic.example.com/page?x=1", "https://other.example.org/team", "https://clinic.example.com/");
  site["https://clinic.example.com/our-team"] = { body: page("Team", filler("Dr. Example is our orthodontist")) };
  site["https://clinic.example.com/sitemap.xml"] = { body: `<urlset>${locs.map((l) => `<url><loc> ${l} </loc></url>`).join("")}</urlset>` };
  const h = harness(site);
  const r = await call("https://clinic.example.com/", h);
  assert.equal(r.status, 200);
  assert.equal(JSON.stringify(Object.keys(r.body)), JSON.stringify(["ok", "title", "text", "pages"]));
  assert.equal(r.body.title, "Smile Clinic & Co");
  const crawled = h.requested.filter((u) => u !== "https://clinic.example.com/" && !u.endsWith("sitemap.xml"));
  assert.equal(crawled.length, 30, "MAX_PAGES = 30");
  assert.equal(crawled[0], "https://clinic.example.com/our-team", "team page ranked first");
  assert.ok(!h.requested.some((u) => /wp-admin|\?x=1|other\.example\.org/.test(u)), "excluded / off-site never fetched");
  assert.equal(r.body.pages.length, 31, "home + 30");
  assert.ok(r.body.text.startsWith("--- Website page: https://clinic.example.com/ ---\n"));
  // htmlToText keeps inline nav on the same line as the body (unchanged behavior).
  assert.match(r.body.text, /--- Website page: https:\/\/clinic\.example\.com\/our-team ---\nTeam Home \| About \| Contact Dr\. Example is our orthodontist/);
  assert.doesNotMatch(r.body.text, /var a=1|\.x\{\}/, "scripts and styles removed");
  assert.doesNotMatch(r.body.text, /Clinic footer line/, "a line repeated on most pages is stripped as boilerplate");
});

test("sitemap index → child sitemaps; no sitemap → homepage links; short pages (<200 chars) dropped", async () => {
  const site = {
    "https://clinic.example.com/": { body: page("Clinic", filler("Welcome")) },
    "https://clinic.example.com/sitemap.xml": { body: "<sitemapindex><sitemap><loc>https://clinic.example.com/post-sitemap.xml</loc></sitemap><sitemap><loc>https://clinic.example.com/page-sitemap.xml</loc></sitemap></sitemapindex>" },
    "https://clinic.example.com/page-sitemap.xml": { body: "<urlset><url><loc>https://clinic.example.com/services</loc></url><url><loc>https://clinic.example.com/tiny</loc></url></urlset>" },
    "https://clinic.example.com/post-sitemap.xml": { body: "<urlset></urlset>" },
    "https://clinic.example.com/services": { body: page("S", filler("Cleaning and whitening services")) },
    "https://clinic.example.com/tiny": { body: page("T", "short") },
  };
  const r = await call("https://clinic.example.com/", harness(site));
  assert.deepEqual(r.body.pages, ["https://clinic.example.com/", "https://clinic.example.com/services"]);
  const links = harness({
    "https://clinic.example.com/": { body: page("C", filler("Welcome")) + `<a href="/contact">c</a><a href='https://other.example.org/x'>o</a>` },
    "https://clinic.example.com/contact": { body: page("Contact", filler("Call us on the phone")) },
  });
  assert.deepEqual((await call("https://clinic.example.com/", links)).body.pages, ["https://clinic.example.com/", "https://clinic.example.com/contact"]);
});

test("combined text is capped at 200,000 characters", async () => {
  const site = { "https://clinic.example.com/": { body: page("C", filler("Welcome")) + Array.from({ length: 30 }, (_, i) => `<a href="/p${i}">x</a>`).join("") } };
  for (let i = 0; i < 30; i++) site[`https://clinic.example.com/p${i}`] = { body: page("P", `Unique page ${i} ` + `content-${i} `.repeat(1500)) };
  const r = await call("https://clinic.example.com/", harness(site));
  assert.equal(r.status, 200);
  assert.equal(r.body.text.length, 200_000);
});

// ------------------------------------------------------------ Firecrawl and the engine fallback

test("Firecrawl configured: whole-site text with title = target, limit 20, no direct crawl", async () => {
  const h = harness({}, { firecrawl: "F".repeat(250_000) });
  const r = await call("clinic.example.com", h);
  assert.equal(JSON.stringify(Object.keys(r.body)), JSON.stringify(["ok", "title", "text"]));
  assert.equal(r.body.title, "https://clinic.example.com");
  assert.equal(r.body.text.length, 200_000);
  assert.deepEqual(h.firecrawlCalls, [["https://clinic.example.com", 20]]);
  assert.deepEqual(h.requested, []);
});

test("Firecrawl 'Couldn't…' / 'Crawl of…' / empty → falls through to the direct crawl", async () => {
  for (const fc of ["Couldn't crawl", "Crawl of x failed", ""]) {
    const h = harness({ "https://clinic.example.com/": { body: page("C", filler("Welcome")) } }, { firecrawl: fc });
    const r = await call("https://clinic.example.com/", h);
    assert.equal(r.status, 200, fc);
    assert.ok(r.body.pages, fc);
  }
});

test("thin page → engine; engine empty → 422; page not loaded → engine or 502", async () => {
  const thin = { "https://clinic.example.com/": { body: "<html><body>Hi</body></html>" } };
  const withEngine = harness(thin, { engine: "Rendered by the engine with plenty of words" });
  const ok = await call("https://clinic.example.com/", withEngine);
  assert.equal(JSON.stringify(ok), JSON.stringify({ status: 200, body: { ok: true, title: "https://clinic.example.com/", text: "Rendered by the engine with plenty of words" } }));
  assert.deepEqual(withEngine.engineCalls, ["https://clinic.example.com/"]);
  assert.deepEqual(await call("https://clinic.example.com/", harness(thin)), {
    status: 422,
    body: { error: "The page had little readable text (it may be JavaScript-rendered, and the marketing engine couldn't read it either)." },
  });
  assert.deepEqual(await call("https://clinic.example.com/", harness({})), { status: 502, body: { error: "Could not load the page." } }, "404 → 502");
  assert.deepEqual(await call("https://clinic.example.com/", harness({ "https://clinic.example.com/": { throws: "ECONNRESET" } })), { status: 502, body: { error: "Could not load the page." } }, "network error → null → 502");
});

test("a fetch that throws a non-SSRF error → engine, else 500 with the message", async () => {
  const h = harness({}, { engine: null });
  h.deps.fetchPage = async () => { throw new Error("socket hang up"); };
  assert.deepEqual(await call("https://clinic.example.com/", h), { status: 500, body: { error: "socket hang up" } });
  const h2 = harness({}, { engine: "Engine rescued this page content fine" });
  h2.deps.fetchPage = async () => { throw new Error("socket hang up"); };
  assert.equal((await call("https://clinic.example.com/", h2)).status, 200);
});

// ------------------------------------------------------------ route + isolation

test("route: still authenticated, body `url` only, session workspace for the engine, delegates to the library", () => {
  const route = src("src/app/api/kb/website/route.ts").replace(/\/\/[^\n]*/g, "");
  assert.match(route, /return withKbAuth\(\(\) => authorizeRequest\(req\), \(\{ workspaceId \}\) => handle\(req, workspaceId\)\);/);
  assert.match(route, /const \{ url \} = await req\.json\(\)\.catch\(\(\) => \(\{\}\)\);/);
  assert.match(route, /websiteResponse\(await importWebsite\(url, defaultWebsiteDeps\(engineFetchForWorkspace\(ws\)\)\)\)/);
  assert.match(route, /export const runtime = "nodejs";/);
  assert.match(route, /export const maxDuration = 60;/);
  assert.doesNotMatch(route, /hyperfx|firecrawl|safe-url|safe-fetch|htmlToText|console\./i, "no crawl / SSRF / engine code left in the route");
});

test("library reuses the Phase 0 SSRF primitives and does not re-implement them", () => {
  const libFull = src("src/lib/kb-website.ts");
  const lib = libFull.replace(/^\s*\/\/[^\n]*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(lib, /^import \{ assertSafeUrl, UnsafeUrlError \} from "@\/lib\/safe-url";$/m);
  assert.match(lib, /^import \{ safeFetchText, type SafeFetchDeps \} from "@\/lib\/safe-fetch";$/m);
  assert.doesNotMatch(lib, /BlockList|node:net|node:dns|isPublicIp|169\.254|127\.0\.0/, "no second SSRF implementation");
  assert.doesNotMatch(lib, /authorize|supabase|console\./i);
  assert.match(lib, /firecrawl: process\.env\.FIRECRAWL_API_KEY/, "Firecrawl still read per call from the environment");
  assert.equal(W.MAX_PAGES, 30);
  assert.equal(W.PAGE_TIMEOUT, 12_000);
  assert.equal(W.FIRECRAWL_PAGE_LIMIT, 20);
  assert.equal(W.WEBSITE_MAX_CHARS, 200_000);
  assert.ok(UnsafeUrlError);
});

test("A3 adds no Central KB runtime integration: runtime files don't reference the new libraries", () => {
  for (const f of [
    "src/lib/livekit.ts", "src/app/api/livekit/agent-config/route.ts", "src/lib/agent-tools-core.ts", "src/app/api/agents/tool-exec/route.ts",
    "livekit-agent/agent.py", "src/lib/builder-tools.ts", "src/app/api/builder-tools/[agentId]/[tool]/route.ts", "src/app/api/vapi/assistants/route.ts",
    "src/lib/agent-reply.ts", "src/app/api/chat/route.ts", "src/app/api/whatsapp/webhook/route.ts", "src/app/api/sms/webhook/route.ts",
    "src/components/dashboard/agents-shared.tsx", "src/lib/db.ts", "src/lib/agent-management.ts", "src/lib/kb-retrieval.ts",
  ]) {
    const s = src(f);
    assert.doesNotMatch(s, /kb-extract|kb-website|@\/lib\/knowledge"|knowledge_resources|knowledge_documents|agent_knowledge_resources/, f);
  }
});
