// Central Knowledge Base UI (Phase A6). The repository tests UI the same way it
// tests everything else: plain TypeScript logic under node --test (no browser
// / React renderer). So:
//   • knowledge-client.ts — behavioural: every request it builds, via an injected fetch;
//   • knowledge-ui.ts     — behavioural: every state / message the pages show;
//   • pages & components  — static checks of the source (wiring, controls, security).
// Synthetic data only; no network, database or provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const C = await import("@/lib/knowledge-client");
const U = await import("@/lib/knowledge-ui");
const K = await import("@/lib/knowledge");
const X = await import("@/lib/kb-extract");

const root = path.resolve(import.meta.dirname, "..");
const src = (p) => fs.readFileSync(path.join(root, p), "utf8");
const code = (p) => src(p).replace(/^\s*\/\/[^\n]*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

const LIST = "src/app/dashboard/knowledge/page.tsx";
const DETAIL = "src/app/dashboard/knowledge/[id]/page.tsx";
const SHARED = "src/components/dashboard/knowledge-shared.tsx";
const UI_FILES = [LIST, DETAIL, SHARED, "src/lib/knowledge-client.ts", "src/lib/knowledge-ui.ts", "src/app/knowledge/page.tsx"];

// ------------------------------------------------------------ client (fake fetch)

function fakeFetch(respond = () => ({ status: 200, body: { ok: true } })) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body });
    const r = respond(url, init);
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
  };
  return { calls, client: C.createKnowledgeClient(fetcher) };
}
const FORBIDDEN_KEYS = /workspace|agent|model|prompt|instruction|temperature|topk|maxcontext|content_version|created_by|status/i;

test("client: list builds the search / filter query (empty filters omitted)", async () => {
  const { calls, client } = fakeFetch(() => ({ status: 200, body: { ok: true, resources: [] } }));
  await client.list();
  await client.list({ q: "  whitening  ", type: "url", status: "ready" });
  await client.list({ q: "", type: "", status: "" });
  await client.list({ q: "a&b=c" });
  assert.deepEqual(calls.map((c) => c.url), [
    "/api/knowledge/resources",
    "/api/knowledge/resources?q=whitening&type=url&status=ready",
    "/api/knowledge/resources",
    "/api/knowledge/resources?q=a%26b%3Dc",
  ]);
  assert.ok(calls.every((c) => c.method === "GET"));
});

test("client: every mutation hits the approved endpoint with only the allowed fields", async () => {
  const { calls, client } = fakeFetch();
  const id = "11111111-1111-4111-8111-111111111111";
  const doc = "22222222-2222-4222-8222-222222222222";
  await client.create({ name: "Prices", description: "d", type: "file", workspace_id: "ws-b", status: "ready" });
  await client.update(id, { name: "N", description: "D", refreshEnabled: true, refreshIntervalHours: 24, type: "url", workspace_id: "x", content_version: 9, status: "ready" });
  await client.remove(id);
  await client.duplicate(id);
  await client.addUrl(id, "https://example.com");
  await client.refresh(id);
  await client.removeDocument(id, doc);
  await client.test([id], "How much?");
  const shown = calls.map((c) => [c.method, c.url, c.body ? JSON.parse(c.body) : null]);
  assert.deepEqual(shown, [
    ["POST", "/api/knowledge/resources", { name: "Prices", description: "d", type: "file" }],
    ["PATCH", `/api/knowledge/resources/${id}`, { name: "N", description: "D", refreshEnabled: true, refreshIntervalHours: 24 }],
    ["DELETE", `/api/knowledge/resources/${id}`, null],
    ["POST", `/api/knowledge/resources/${id}/duplicate`, null],
    ["POST", `/api/knowledge/resources/${id}/urls`, { url: "https://example.com" }],
    ["POST", `/api/knowledge/resources/${id}/refresh`, null],
    ["DELETE", `/api/knowledge/resources/${id}/documents/${doc}`, null],
    ["POST", "/api/knowledge/test", { resourceIds: [id], question: "How much?" }],
  ]);
  // No request body carries a workspace, agent, model, prompt, status or version.
  for (const c of calls) if (c.body) for (const k of Object.keys(JSON.parse(c.body))) assert.doesNotMatch(k, FORBIDDEN_KEYS, k);
  // Ids are path-encoded (no path injection).
  await client.detail("../../x");
  assert.equal(calls.at(-1).url, "/api/knowledge/resources/..%2F..%2Fx");
});

test("client: file upload sends the raw file as multipart `file` only — no extracted content, no workspace", async () => {
  const { calls, client } = fakeFetch(() => ({ status: 201, body: { ok: true, action: "inserted", documentId: "d", truncated: false, resource: {} } }));
  const file = new File(["%PDF-1.4 fake"], "prices.pdf", { type: "application/pdf" });
  const r = await client.uploadFile("11111111-1111-4111-8111-111111111111", file);
  assert.equal(r.ok, true);
  assert.equal(calls[0].url, "/api/knowledge/resources/11111111-1111-4111-8111-111111111111/files");
  assert.ok(calls[0].body instanceof FormData);
  assert.deepEqual([...calls[0].body.keys()], ["file"]);
  assert.equal(calls[0].body.get("file").name, "prices.pdf");
});

test("client: errors keep the server's stable code and body; network / non-JSON failures are safe", async () => {
  const cases = [
    [{ status: 503, body: { ok: false, code: "knowledge_migration_missing", error: "The Central Knowledge Base isn't installed yet (migration 0065)." } }, 503, "knowledge_migration_missing"],
    [{ status: 409, body: { ok: false, code: "resource_assigned", error: "x", agents: [{ agentId: "a", agentName: "Laura" }], count: 1 } }, 409, "resource_assigned"],
    [{ status: 403, body: { ok: false, code: "forbidden_role", error: "Only…" } }, 403, "forbidden_role"],
    [{ status: 502, body: "<html>Bad gateway</html>" }, 502, "request_failed"],
    [{ status: 401, body: "" }, 401, "unauthenticated"],
  ];
  for (const [resp, status, code] of cases) {
    const { client } = fakeFetch(() => resp);
    const r = await client.list();
    assert.equal(r.ok, false);
    assert.equal(r.status, status);
    assert.equal(r.code, code);
    assert.equal(typeof r.error, "string");
  }
  const { client } = fakeFetch(() => ({ status: 409, body: { ok: false, code: "resource_assigned", error: "x", agents: [{ agentName: "Laura" }], count: 1 } }));
  assert.deepEqual((await client.remove("x")).body.agents, [{ agentName: "Laura" }]);
  const net = await fakeFetch(() => new TypeError("Failed to fetch")).client.list();
  assert.deepEqual([net.ok, net.status, net.code], [false, 0, "network_error"]);
});

// ------------------------------------------------------------ page states

const err = (status, code, body = {}) => ({ ok: false, status, code, error: "server text", body });

test("list states: migration missing is its own page state (never empty / 404 / generic), plus every other failure", () => {
  assert.equal(U.pageStateFor(err(503, "knowledge_migration_missing")), "migration_missing");
  assert.equal(U.pageStateFor(err(503, "service_unavailable")), "unavailable");
  assert.equal(U.pageStateFor(err(401, "unauthenticated")), "signed_out");
  assert.equal(U.pageStateFor(err(403, "forbidden")), "no_access");
  assert.equal(U.pageStateFor(err(404, "resource_not_found")), "not_found");
  assert.equal(U.pageStateFor(err(500, "internal_error")), "error");
  assert.equal(U.pageStateFor(err(0, "network_error")), "error");
  const m = U.PAGE_STATE_COPY.migration_missing;
  assert.equal(m.title, "Knowledge Base isn't available in this environment yet.");
  assert.doesNotMatch(`${m.title} ${m.body}`, /migration|0065|sql|supabase|table|database/i, "no infrastructure details for users");
  assert.doesNotMatch(`${m.title} ${m.body}`, /no (knowledge )?resources/i, "not an empty-list message");
  assert.match(U.actionError(err(503, "knowledge_migration_missing")), /isn't available in this environment/);
  assert.match(U.actionError(err(500, "internal_error")), /Nothing was changed/);
  assert.equal(U.isForbiddenRole(err(403, "forbidden_role")), true);
  assert.equal(U.isForbiddenRole(err(403, "forbidden")), false);
});

test("labels: status filters are exactly the A4 resource statuses; type filters File / URL", () => {
  assert.deepEqual(U.STATUS_FILTERS.map((s) => s.value).filter(Boolean).sort(), [...K.RESOURCE_STATUSES].sort());
  assert.deepEqual(Object.keys(U.RESOURCE_STATUS_META).sort(), [...K.RESOURCE_STATUSES].sort());
  assert.deepEqual(Object.keys(U.DOCUMENT_STATUS_META).sort(), [...K.DOCUMENT_STATUSES].sort());
  assert.deepEqual(U.TYPE_FILTERS.map((t) => [t.value, t.label]), [["", "All types"], ["file", "File"], ["url", "URL"]]);
  assert.deepEqual(U.REFRESH_INTERVALS.map((r) => r.hours), [...K.REFRESH_INTERVAL_HOURS]);
  // Status is never conveyed by colour alone: every status has a text label.
  for (const m of Object.values(U.RESOURCE_STATUS_META)) assert.ok(m.label.length > 2);
  assert.equal(U.formatChars(0), "0 characters");
  assert.equal(U.formatChars(950), "950 characters");
  assert.equal(U.formatChars(12_345), "12k characters");
  assert.equal(U.formatDateTime(null), "—");
});

// ------------------------------------------------------------ files

const fdoc = (filename, extra = {}) => ({ id: filename, kind: "file", filename, sourceUrl: null, mime: null, chars: 10, status: "ready", error: null, position: 0, fetchedAt: null, updatedAt: "x", preview: "p", ...extra });

test("files: same-name replacement detected like the server (trimmed, case-insensitive); confirmation copy", () => {
  const docs = [fdoc("Prices.pdf"), fdoc("hours.docx")];
  assert.equal(U.sameNameDocument(docs, "  PRICES.PDF ").filename, "Prices.pdf");
  assert.equal(U.sameNameDocument(docs, "prices-2.pdf"), null);
  assert.equal(U.REPLACE_CONFIRM, "A file with this name already exists. Uploading will replace its knowledge content.");
  const shared = code(SHARED);
  assert.match(shared, /sameNameDocument\(documents, f\.name\)/);
  assert.match(shared, /title="Replace existing file\?"[\s\S]*?\{REPLACE_CONFIRM\}/);
});

test("files: only formats the A3 extractor reads are offered (no plain-text), 10 MB cap, empty refused", () => {
  for (const ext of U.ACCEPTED_FILE_EXTENSIONS) assert.notEqual(X.kindFromName(`a${ext}`), "unknown", ext);
  for (const ext of [".txt", ".md", ".csv", ".html", ".xlsx"]) {
    assert.equal(X.kindFromName(`a${ext}`), "unknown");
    assert.ok(!U.ACCEPTED_FILE_EXTENSIONS.includes(ext), `${ext} not advertised`);
  }
  assert.doesNotMatch(U.ACCEPTED_FILES_LABEL, /text|\.txt|csv|markdown/i);
  assert.equal(U.uploadPrecheck({ name: "a.pdf", size: 10 }), null);
  assert.match(U.uploadPrecheck({ name: "a.pdf", size: 0 }), /empty/);
  assert.match(U.uploadPrecheck({ name: "a.pdf", size: 10 * 1024 * 1024 + 1 }), /10 MB/);
  assert.match(U.uploadPrecheck({ name: "notes.txt", size: 10 }), /isn't a supported file type/);
  assert.equal(U.MAX_UPLOAD_BYTES, 10 * 1024 * 1024);
});

test("files: upload outcomes — added / replaced / unchanged / truncated / failed (new) / failed (previous kept)", () => {
  const ok = (action, truncated = false) => ({ ok: true, status: 200, data: { action, documentId: "d", truncated, resource: {} } });
  assert.deepEqual(U.uploadNotice("a.pdf", ok("inserted")), { tone: "success", text: '"a.pdf" added.' });
  assert.equal(U.uploadNotice("a.pdf", ok("replaced")).text, '"a.pdf" replaced with the new version.');
  assert.equal(U.uploadNotice("a.pdf", ok("unchanged")).tone, "info");
  assert.match(U.uploadNotice("a.pdf", ok("inserted", true)).text, /only the first 200,000 were kept/);
  const failNew = U.uploadNotice("scan.png", { ok: false, status: 422, code: "extraction_failed", error: "Couldn't read text from that image.", body: {} });
  assert.deepEqual(failNew, { tone: "error", text: '"scan.png": Couldn\'t read text from that image.' });
  const kept = U.uploadNotice("a.pdf", { ok: false, status: 422, code: "extraction_failed", error: "Bad file. The existing version was kept.", body: { kept: true } });
  assert.match(kept.text, /previous version of "a\.pdf" is still in use/);
  assert.equal(U.atCharacterLimit({ chars: 200_000 }), true);
  assert.equal(U.atCharacterLimit({ chars: 199_999 }), false);
});

// ------------------------------------------------------------ URLs

test("URLs: add outcomes, re-import detection, refresh messaging always says failed content is kept", () => {
  const ok = (action) => ({ ok: true, status: 200, data: { action, documentId: "d", truncated: false, resource: {} } });
  assert.equal(U.urlNotice("https://a.com/", ok("inserted")).text, "Imported https://a.com/.");
  assert.equal(U.urlNotice("https://a.com/", ok("unchanged")).tone, "info");
  assert.equal(U.urlNotice("http://10.0.0.1/", { ok: false, status: 400, code: "private_address", error: "That address is on a private or internal network and can't be imported.", body: {} }).text, "That address is on a private or internal network and can't be imported.");
  assert.match(U.urlNotice("https://a.com/", { ok: false, status: 502, code: "fetch_failed", error: "down", body: { kept: true } }).text, /previously imported content is still in use/);
  const docs = [{ ...fdoc(null), kind: "url", filename: null, sourceUrl: "https://example.com/" }];
  assert.ok(U.existingUrlDocument(docs, "EXAMPLE.com"));
  assert.equal(U.existingUrlDocument(docs, "https://other.com"), null);

  const rr = (data) => ({ ok: true, status: 200, data: { results: [], resource: {}, ...data } });
  assert.deepEqual(U.refreshNotice(rr({ refreshed: 2, failed: 0, changed: true })), { tone: "success", text: "Refreshed — new content was imported." });
  assert.deepEqual(U.refreshNotice(rr({ refreshed: 2, failed: 0, changed: false })), { tone: "success", text: "Refreshed — nothing changed since the last import." });
  const partial = U.refreshNotice(rr({ refreshed: 1, failed: 1, changed: true }));
  assert.equal(partial.tone, "info");
  assert.match(partial.text, /1 address couldn't be refreshed — their previous content is still in use/);
  const allFailed = U.refreshNotice(rr({ refreshed: 0, failed: 3, changed: false }));
  assert.equal(allFailed.tone, "error");
  assert.match(allFailed.text, /Refresh failed\. 3 addresses couldn't be refreshed — their previous content is still in use/);
  assert.match(U.refreshNotice({ ok: false, status: 500, code: "internal_error", error: "x", body: {} }).text, /previously imported content is still in use/);
  for (const o of ["replaced", "unchanged", "kept_previous", "skipped", "removed"]) assert.ok(U.REFRESH_OUTCOME_LABEL[o]);
  assert.match(U.REFRESH_OUTCOME_LABEL.kept_previous, /previous content kept/);
});

// ------------------------------------------------------------ delete

test("delete: 409 assigned → a blocking message naming the agents; other failures → null", () => {
  const e409 = (agents, count) => err(409, "resource_assigned", { agents: agents.map((n) => ({ agentId: n, agentName: n })), count: count ?? agents.length });
  assert.equal(U.deleteBlockedMessage(e409(["Laura", "Nova"]), "Prices"), '"Prices" can\'t be deleted because it is assigned to Laura and Nova.');
  assert.equal(U.deleteBlockedMessage(e409(["Laura", "Nova", "Tina"]), "Prices"), '"Prices" can\'t be deleted because it is assigned to Laura, Nova and Tina.');
  assert.equal(U.deleteBlockedMessage(e409(["Laura"]), "Prices"), '"Prices" can\'t be deleted because it is assigned to Laura.');
  assert.equal(U.deleteBlockedMessage(e409([], 2), "Prices"), '"Prices" can\'t be deleted because it is assigned to 2 agents.');
  assert.equal(U.deleteBlockedMessage(err(500, "internal_error"), "Prices"), null);
  assert.equal(U.deleteBlockedMessage(err(409, "name_taken"), "Prices"), null);
  for (const f of [LIST, DETAIL]) {
    const s = code(f);
    assert.match(s, /deleteBlockedMessage\(/, f);
    assert.match(s, /confirmDisabled=\{deleteBlocked\}/, `${f}: blocked delete can't be retried from the dialog`);
    assert.match(s, /title="Delete knowledge resource\?"/, `${f}: confirmation required`);
    assert.doesNotMatch(s, /unassign\(|removeAssignment|assignAgent|\/assignments/i, `${f}: no assignment controls`);
  }
  assert.match(code(DETAIL), /title="Delete document\?"[\s\S]*?Deleting this document removes its knowledge from this resource\./);
});

// ------------------------------------------------------------ tester

const chunk = (i, extra = {}) => ({ rank: i + 1, resourceId: "r", resourceName: "Pricing", documentId: `d${i}`, documentLabel: "prices.pdf", section: "prices.pdf", chunkIndex: i, score: 3.14159, chars: 500, preview: "x".repeat(200), ...extra });
const result = (over) => ({ question: "q", answer: null, answerStatus: "answered", generation: { status: "answered", model: "openai/gpt-4o-mini" }, resources: [], chunks: [chunk(0)], retrieval: {}, ...over });

test("tester: answered / not_found / retrieval_only (unavailable, failed, timeout) — retrieval-only keeps every source", () => {
  const a = U.testerView(result({ answer: "AED 300 [1].", answerStatus: "answered" }));
  assert.equal(a.heading, "Answer");
  assert.equal(a.answer, "AED 300 [1].");
  assert.equal(a.sources.length, 1);
  const nf = U.testerView(result({ answerStatus: "not_found", answer: "This isn't available in the selected knowledge resources.", generation: { status: "skipped_no_match", model: null }, chunks: [] }));
  assert.equal(nf.heading, "Not in the selected resources");
  assert.equal(nf.answer, "This isn't available in the selected knowledge resources.");
  assert.deepEqual(nf.sources, []);
  for (const [generation, why] of [
    [{ status: "unavailable", model: null, reason: "not_configured" }, /AI answers aren't set up/],
    [{ status: "failed", model: null, attemptedModel: "openai/gpt-4o-mini", reason: "provider_error" }, /AI service couldn't generate/],
    [{ status: "failed", model: null, attemptedModel: "openai/gpt-4o-mini", reason: "timeout" }, /took too long/],
  ]) {
    const v = U.testerView(result({ answerStatus: "retrieval_only", generation, chunks: [chunk(0), chunk(1)] }));
    assert.equal(v.tone, "warning");
    assert.equal(v.answer, null);
    assert.match(v.note, /Matching knowledge was found/);
    assert.match(v.note, why);
    assert.equal(v.sources.length, 2, "results not discarded");
  }
  const s = a.sources[0];
  assert.deepEqual({ ...s, preview: s.preview.length }, { key: "d0#0", rank: 1, resourceName: "Pricing", documentLabel: "prices.pdf", section: "prices.pdf", chunk: 1, score: "3.14", preview: 200, truncated: true });
  assert.equal(U.testerView(result({ chunks: [chunk(0, { chars: 50, preview: "y".repeat(50) })] })).sources[0].truncated, false);
});

test("tester: selection and question validated before sending; UI has no model / agent / prompt / limit controls", () => {
  assert.match(U.testerPrecheck([], "q"), /Select at least one/);
  assert.match(U.testerPrecheck(Array.from({ length: 11 }, (_, i) => `${i}`), "q"), /at most 10/);
  assert.match(U.testerPrecheck(["a"], "   "), /Type a question/);
  assert.match(U.testerPrecheck(["a"], "x".repeat(1001)), /1000 characters/);
  assert.equal(U.testerPrecheck(["a"], "How much?"), null);
  const s = code(SHARED);
  const tester = s.slice(s.indexOf("export function TesterModal"));
  assert.match(tester, /knowledgeClient\.test\(selected, question\.trim\(\)\)/, "only selection + question are sent");
  assert.match(tester, /type="checkbox" checked=\{selected\.includes\(r\.id\)\}/, "explicit multi-select");
  assert.match(tester, /useState<string\[\]>\(preselected\.filter/, "nothing auto-selected beyond the explicit preselection");
  // No control or field for a model, an agent, a prompt or retrieval limits (the subtitle may say "not an agent").
  assert.doesNotMatch(tester, /\bmodel\b|agentId|agent_id|selectedAgent|setAgent|prompt|temperature|topK|maxContext|instruction|systemPrompt/i);
  assert.equal([...tester.matchAll(/<select/g)].length, 0, "no selects (no model / agent picker)");
  assert.deepEqual([...tester.matchAll(/<(input|textarea)\b[^>]*>/g)].map((m) => (m[0].match(/type="(\w+)"/) ?? [, m[1]])[1]).sort(), ["checkbox", "textarea"].concat(tester.includes('id={`${ids}-filter`}') ? ["input"] : []).sort(), "only resource checkboxes, the resource filter and the question");
  // The full context / prompt never reaches the browser: sources show previews only.
  assert.doesNotMatch(tester, /\.text\b|context|dangerouslySetInnerHTML/);
  assert.match(tester, /\{s\.preview\}/);
});

// ------------------------------------------------------------ navigation & pages (static)

test("navigation: Knowledge Base → /dashboard/knowledge (BookOpen); /knowledge redirects there; existing nav untouched", () => {
  const shell = src("src/components/dashboard/shell.tsx");
  assert.match(shell, /\{ href: "\/dashboard\/knowledge", label: "Knowledge Base", icon: BookOpen \},/);
  assert.match(shell, /^\s+BookOpen,$/m);
  for (const item of ['label: "Voice Agents"', '{ href: "/dashboard/agents/settings", label: "Voice Agent Settings" }', 'label: "Chat Agents"']) assert.ok(shell.includes(item), item);
  const redirect = src("src/app/knowledge/page.tsx");
  assert.match(redirect, /import \{ redirect \} from "next\/navigation";/);
  assert.match(redirect, /redirect\("\/dashboard\/knowledge"\);/);
});

test("list page: header, actions, search/filters wired to the API, all states (loading / empty / filtered / failure)", () => {
  const s = code(LIST);
  assert.match(s, /title="Knowledge Base"/);
  assert.match(s, /subtitle="Manage reusable knowledge resources for your AI agents\."/);
  assert.match(s, /Test Knowledge/);
  assert.match(s, /\{!readOnly && \([\s\S]*?Add Resource/);
  assert.match(s, /knowledgeClient\.list\(\{ q: query, type, status \}\)/);
  assert.match(s, /setTimeout\(\(\) => setQuery\(q\), 300\)/, "search is debounced");
  assert.match(s, /<LoadingRows \/>/);
  assert.match(s, /No knowledge resources yet\./);
  assert.match(s, /No knowledge resources match your search or filters\./);
  assert.match(s, /setState\(pageStateFor\(r\)\)/);
  assert.match(s, /state !== "ready" \? \(\s*<PageStateCard/);
  assert.match(s, /setResources\(null\)/, "a failed load never renders as an empty list");
  // The empty state doesn't imply resources are connected to agents.
  const empty = s.slice(s.indexOf("No knowledge resources yet."), s.indexOf("No knowledge resources yet.") + 500);
  assert.doesNotMatch(empty, /agent/i);
  // Card shows the scan fields.
  for (const f of ["r.name", "r.description", "<TypeBadge", "<ResourceStatusBadge", "r.documentCount", "formatChars(r.charCount)", "r.assignedAgentCount", "formatDateTime(r.updatedAt)"]) assert.ok(s.includes(f), f);
  assert.match(s, /grid gap-3 sm:grid-cols-2 xl:grid-cols-3/, "responsive grid, single column on mobile");
});

test("create / edit: name, description, type (immutable after create); refresh settings for URL only; read-only roles see no mutation controls", () => {
  const s = code(SHARED);
  const form = s.slice(s.indexOf("export function ResourceFormModal"), s.indexOf("export function FileUploader"));
  assert.match(form, /knowledgeClient\.create\(\{ name, description, type \}\)/);
  assert.match(form, /resource!\.type === "url"\s*\?\s*\{ name, description, refreshEnabled, refreshIntervalHours: refreshEnabled \? interval : null \}\s*:\s*\{ name, description \}/);
  assert.match(form, /mode === "create" \? \(/, "type picker only when creating");
  assert.match(form, /The type can&apos;t be changed/);
  assert.match(form, /Automatic refresh isn&apos;t running yet/);
  assert.doesNotMatch(form, /status:|contentVersion|workspace|created_by|owner/);
  assert.match(form, /if \(!name\.trim\(\)\) \{\s*setError\("Give the resource a name\."\)/);
  for (const f of [LIST, DETAIL]) {
    const p = code(f);
    assert.match(p, /const forbidden = useCallback\(\(\) => \{\s*setReadOnly\(true\);/, `${f}: a forbidden_role reply switches to read-only`);
    assert.match(p, /\{!readOnly && \(/, `${f}: mutation controls hidden when read-only`);
    assert.match(p, /READ_ONLY_NOTE/);
  }
});

test("detail page: metadata, read-only assignments, documents with previews (plain text, collapsed), uploads / URLs / refresh", () => {
  const s = code(DETAIL);
  assert.match(s, /useParams<\{ id: string \}>\(\)/);
  assert.match(s, /knowledgeClient\.detail\(id\)/);
  for (const f of ["r.contentVersion", "r.documentCount", "formatChars(r.charCount)", "r.assignedAgentCount", "formatDateTime(r.updatedAt)", "formatDateTime(r.lastRefreshedAt)", "detail.assignedAgents.map((a) => a.name)"]) assert.ok(s.includes(f), f);
  assert.match(s, /<details className="mt-1\.5">\s*<summary[^>]*>Show preview<\/summary>/, "previews collapsed by default");
  assert.match(s, /\{d\.preview\}/);
  assert.match(s, /atCharacterLimit\(d\)/);
  assert.match(s, /d\.kind === "url" \? `Fetched \$\{formatDateTime\(d\.fetchedAt\)\}`/);
  assert.match(s, /<FileUploader resourceId=\{r\.id\}/);
  assert.match(s, /<UrlAdder resourceId=\{r\.id\}/);
  assert.match(s, /knowledgeClient\.refresh\(detail\.resource\.id\)/);
  assert.match(s, /The last refresh had problems — the previously imported content is still in use\./);
  assert.match(s, /knowledgeClient\.removeDocument\(detail\.resource\.id, docToDelete\.id\)/);
  assert.match(s, /className="mb-6 flex flex-col gap-4 lg:flex-row/, "header stacks on narrow screens");
});

test("duplicate: server endpoint, the returned resource is opened — no local copy, no assignment copying", () => {
  for (const f of [LIST, DETAIL]) {
    const s = code(f);
    const fn = s.slice(s.indexOf("async function duplicate"), s.indexOf("async function", s.indexOf("async function duplicate") + 10));
    assert.match(fn, /knowledgeClient\.duplicate\(/, f);
    assert.match(fn, /router\.push\(`\/dashboard\/knowledge\/\$\{(res|r)\.data\.resource\.id\}`\)/, `${f}: opens the server's duplicate`);
    assert.doesNotMatch(fn, /knowledgeClient\.(create|uploadFile|addUrl)|copyName|Copy\b.*name|assign/i, `${f}: no client-side duplication`);
    assert.match(fn, /if \(busy( \|\| !detail)?\) return;/, "no double submission");
  }
});

// ------------------------------------------------------------ A6.1 viewer capability (UI)

/** Every `{!readOnly && ( … )}` block in a component (parenthesis-matched). */
function readOnlyBlocks(s) {
  const out = [];
  let i = 0;
  while ((i = s.indexOf("{!readOnly && (", i)) >= 0) {
    let depth = 0;
    let j = s.indexOf("(", i);
    for (; j < s.length; j++) {
      if (s[j] === "(") depth++;
      else if (s[j] === ")" && --depth === 0) break;
    }
    out.push(s.slice(i, j + 1));
    i = j;
  }
  return out;
}
const outsideBlocks = (s) => readOnlyBlocks(s).reduce((acc, b) => acc.replace(b, ""), s);

test("UI capability: canManageFrom is true ONLY for viewer.canManage === true (least privilege otherwise)", () => {
  assert.equal(U.canManageFrom({ viewer: { canManage: true } }), true);
  for (const d of [{ viewer: { canManage: false } }, {}, null, undefined, { viewer: null }, { viewer: { canManage: "true" } }, { viewer: { canManage: 1 } }, { canManage: true }]) {
    assert.equal(U.canManageFrom(d), false, JSON.stringify(d));
  }
});

test("UI capability: pages start read-only and take the capability from the list / detail response", () => {
  for (const f of [LIST, DETAIL]) {
    const s = code(f);
    assert.match(s, /const \[readOnly, setReadOnly\] = useState\(true\);/, `${f}: no mutation control before the server answers`);
    assert.match(s, /setReadOnly\(!canManageFrom\(r\.data\)\);/, `${f}: capability from the server response`);
    // A later 403 still switches a manageable page to read-only.
    assert.match(s, /const forbidden = useCallback\(\(\) => \{\s*setReadOnly\(true\);\s*toast\(READ_ONLY_NOTE, "info"\);/, f);
    assert.ok((s.match(/isForbiddenRole\(/g) ?? []).length >= 2, `${f}: 403 forbidden_role handled`);
  }
  const client = code("src/lib/knowledge-client.ts");
  assert.match(client, /list: \(f: ListFilters = \{\}\) => call<\{ resources: KnowledgeResource\[\]; viewer\?: Viewer \}>/);
  // The client never sends a role / capability.
  const builders = client.slice(client.indexOf("export function createKnowledgeClient"));
  assert.doesNotMatch(builders, /canManage|role/i);
});

test("UI capability: every mutation control is inside a read-only gate; Test Knowledge and browsing are not", () => {
  const list = code(LIST);
  const listGated = readOnlyBlocks(list).join("\n");
  for (const m of ["Add Resource", "setEditing(r)", "void duplicate(r)", "void refresh(r)", "setDeleting(r)"]) {
    assert.ok(listGated.includes(m), `list: ${m} gated`);
    assert.ok(!outsideBlocks(list).includes(m), `list: ${m} never ungated`);
  }
  for (const m of ["Test Knowledge", "void openTester()", "href={`/dashboard/knowledge/${r.id}`}", "r.assignedAgents"]) assert.ok(outsideBlocks(list).includes(m), `list: ${m} available to every member`);

  const detail = code(DETAIL);
  const detailGated = readOnlyBlocks(detail).join("\n");
  for (const m of ["void refresh()", "setEditing(true)", "void duplicate()", "setDeleting(true)", "<FileUploader", "<UrlAdder", "setDocToDelete(d)"]) {
    assert.ok(detailGated.includes(m), `detail: ${m} gated`);
    assert.ok(!outsideBlocks(detail).includes(m), `detail: ${m} never ungated`);
  }
  for (const m of ["Test Knowledge", "void openTester()", "Show preview", "detail.assignedAgents.map((a) => a.name)"]) assert.ok(outsideBlocks(detail).includes(m), `detail: ${m} available to every member`);
});

// ------------------------------------------------------------ security / architecture (static)

test("security: UI never touches Supabase / server modules; all Central KB access is /api/knowledge via authFetch", () => {
  for (const f of UI_FILES) {
    const s = code(f);
    assert.doesNotMatch(s, /supabase|supabase-admin|knowledge-server|knowledge-service|knowledge-route|knowledge-tester|service_role|SUPABASE_SERVICE/i, f);
    assert.doesNotMatch(s, /knowledge_resources|knowledge_documents|agent_knowledge_resources/, `${f}: no table access`);
    assert.doesNotMatch(s, /dangerouslySetInnerHTML|innerHTML/, `${f}: no raw HTML`);
    assert.doesNotMatch(s, /\bfetch\(\s*["'`]/, `${f}: no direct fetch`);
  }
  const client = code("src/lib/knowledge-client.ts");
  assert.match(client, /\(await import\("@\/lib\/auth-fetch"\)\)\.authFetch\(input, init\)/);
  assert.match(client, /const BASE = "\/api\/knowledge";/);
  const builders = client.slice(client.indexOf("export function createKnowledgeClient"));
  // agentId became a legitimate request field in Phase 1A (assignment writer);
  // the workspace, model and prompt still never come from the browser.
  assert.doesNotMatch(builders, /workspace|\bmodel\b|prompt/i, "no request builder sends these");
  // Components call only the client (no raw URLs to the API).
  for (const f of [LIST, DETAIL, SHARED]) assert.doesNotMatch(code(f), /\/api\//, f);
  // No other browser code reads the Central KB tables.
  const browserFiles = fs.readdirSync(path.join(root, "src"), { recursive: true }).map(String).filter((p) => /\.(tsx?)$/.test(p) && !p.startsWith("app/api") && !p.startsWith("app\\api"));
  for (const p of browserFiles) {
    // The two SERVER-ONLY Central KB modules: the store (knowledge-server) and
    // the Phase 1B runtime reader (knowledge-runtime). Nothing else may name
    // the tables.
    if (p.endsWith("knowledge-server.ts") || p.endsWith("knowledge-runtime.ts")) continue;
    assert.doesNotMatch(src(path.join("src", p)), /from\(["']knowledge_(resources|documents)["']\)|from\(["']agent_knowledge_resources["']\)/, p);
  }
});

test("accessibility: labelled inputs, dialog semantics, Escape closes, status text not colour-only", () => {
  const modal = src("src/components/modal.tsx");
  assert.match(modal, /role="dialog"\s*aria-modal="true"\s*aria-label=\{title\}/);
  assert.match(modal, /aria-label="Close"/);
  const s = code(SHARED);
  assert.match(s, /export function useEscape/);
  for (const m of ["ConfirmModal", "ResourceFormModal", "TesterModal"]) {
    const body = s.slice(s.indexOf(`export function ${m}`));
    assert.match(body.slice(0, 2500), /useEscape\(onClose/, `${m} closes on Escape`);
  }
  for (const id of ["-name", "-desc", "-q", "-interval"]) assert.match(s, new RegExp(`htmlFor=\\{\`\\$\\{ids\\}${id}\`\\}`), id);
  assert.match(code(LIST), /htmlFor="kb-search"/);
  assert.match(code(LIST), /htmlFor="kb-type"/);
  assert.match(code(LIST), /htmlFor="kb-status"/);
  assert.match(s, /role=\{notice\.tone === "error" \? "alert" : "status"\}/);
  assert.match(s, /aria-live="polite"/);
});

test("no runtime integration / out-of-scope features: agents, LiveKit, Vapi, Builder, chat, WhatsApp, SMS untouched", () => {
  for (const f of [
    "src/lib/livekit.ts", "src/app/api/livekit/agent-config/route.ts", "src/lib/agent-tools-core.ts", "src/app/api/agents/tool-exec/route.ts",
    "livekit-agent/agent.py", "src/lib/builder-tools.ts", "src/app/api/vapi/assistants/route.ts", "src/lib/agent-reply.ts", "src/app/api/chat/route.ts",
    "src/app/api/whatsapp/webhook/route.ts", "src/app/api/sms/webhook/route.ts", "src/components/dashboard/agents-shared.tsx", "src/lib/db.ts",
  ]) {
    assert.doesNotMatch(src(f), /knowledge-client|knowledge-ui|knowledge-shared|\/dashboard\/knowledge|\/api\/knowledge/, f);
  }
  // assignAgent left this list in Phase 1A: assignment management is now an
  // approved UI feature. The runtime files above still never touch Central KB.
  for (const f of UI_FILES) assert.doesNotMatch(code(f), /effectiveKnowledge|embedding|pgvector|cron|setInterval\(/i, f);
});
