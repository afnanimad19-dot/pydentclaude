// Central Knowledge Base — pure domain logic (Phase A2). No DB, network or AI.
// Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const K = await import("@/lib/knowledge");
const root = path.resolve(import.meta.dirname, "..");

const fileRes = { id: "r-file", name: "Pricing", description: "", type: "file", refreshEnabled: false, refreshIntervalHours: null };
const urlRes = { id: "r-url", name: "Website", description: "", type: "url", refreshEnabled: false, refreshIntervalHours: null };
const doc = (o) => ({ id: "d1", resourceId: "r-file", kind: "file", filename: "prices.pdf", sourceUrl: null, mime: null, content: "x", contentHash: null, position: 0, status: "ready", ...o });

// ------------------------------------------------------------ resources

test("valid resource is normalized", () => {
  const r = K.validateNewResource({ name: "  LHDM   Services  ", description: "  Doctors & services ", type: "url", refreshEnabled: true, refreshIntervalHours: 24 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { name: "LHDM Services", description: "Doctors & services", type: "url", refreshEnabled: true, refreshIntervalHours: 24 });
  const f = K.validateNewResource({ name: "Pricing", type: "file" });
  assert.deepEqual(f.value, { name: "Pricing", description: "", type: "file", refreshEnabled: false, refreshIntervalHours: null });
});

test("empty / whitespace / non-string / control-character names are refused", () => {
  for (const name of ["", "   ", undefined, null, 42]) assert.equal(K.validateNewResource({ name, type: "file" }).code, "name_required", String(name));
  assert.equal(K.validateNewResource({ name: "bad\u0007", type: "file" }).code, "name_invalid");
});

test("name length: 80 accepted, 81 refused", () => {
  assert.equal(K.validateNewResource({ name: "x".repeat(80), type: "file" }).ok, true);
  const r = K.validateNewResource({ name: "x".repeat(81), type: "file" });
  assert.equal(r.code, "name_too_long");
  assert.equal(r.field, "name");
});

test("unsupported resource types are refused, never coerced", () => {
  for (const type of ["text", "FILE", "", undefined, null, "pdf", 1]) assert.equal(K.validateNewResource({ name: "A", type }).code, "type_invalid", String(type));
});

test("name uniqueness is case-insensitive and whitespace-insensitive", () => {
  assert.equal(K.validateNewResource({ name: "pricing", type: "file" }, ["Pricing"]).code, "name_taken");
  assert.equal(K.validateNewResource({ name: " PRICING  ", type: "file" }, ["pricing"]).code, "name_taken");
  assert.equal(K.validateNewResource({ name: "Pricing 2", type: "file" }, ["Pricing"]).ok, true);
});

test("refresh settings: URL only, intervals 6/12/24/168, enabling requires an interval", () => {
  for (const h of [6, 12, 24, 168, "24"]) assert.equal(K.validateNewResource({ name: "W", type: "url", refreshEnabled: true, refreshIntervalHours: h }).ok, true, String(h));
  for (const h of [0, 1, 48, 7, -6, 24.5, "daily", "1e3"]) {
    assert.equal(K.validateNewResource({ name: "W", type: "url", refreshIntervalHours: h }).code, "refresh_interval_invalid", String(h));
  }
  assert.equal(K.validateNewResource({ name: "W", type: "url", refreshEnabled: true }).code, "refresh_interval_required");
  assert.equal(K.validateNewResource({ name: "F", type: "file", refreshEnabled: true, refreshIntervalHours: 24 }).code, "refresh_not_supported");
  assert.equal(K.validateNewResource({ name: "F", type: "file", refreshIntervalHours: 24 }).code, "refresh_not_supported");
  assert.equal(K.validateNewResource({ name: "W", type: "url", refreshEnabled: "yes" }).code, "refresh_invalid");
  // An interval may be stored while automatic refresh is off.
  assert.deepEqual(K.validateNewResource({ name: "W", type: "url", refreshIntervalHours: 12 }).value.refreshIntervalHours, 12);
});

test("description: optional, trimmed, max 1000, must be text", () => {
  assert.equal(K.validateNewResource({ name: "A", type: "file", description: "d".repeat(1000) }).ok, true);
  assert.equal(K.validateNewResource({ name: "A", type: "file", description: "d".repeat(1001) }).code, "description_too_long");
  assert.equal(K.validateNewResource({ name: "A", type: "file", description: 5 }).code, "description_invalid");
});

test("update: type is immutable, name stays unique (own name allowed), refresh validated against the existing type", () => {
  assert.equal(K.validateResourceUpdate(fileRes, { type: "url" }).code, "type_immutable");
  assert.deepEqual(K.validateResourceUpdate(fileRes, { type: "file", name: "pricing " }, ["Pricing", "Other"]).value, { name: "pricing" }, "re-casing own name is fine");
  assert.equal(K.validateResourceUpdate(fileRes, { name: "other" }, ["Pricing", "Other"]).code, "name_taken");
  assert.equal(K.validateResourceUpdate(fileRes, { refreshEnabled: true, refreshIntervalHours: 6 }).code, "refresh_not_supported");
  const u = K.validateResourceUpdate(urlRes, { refreshEnabled: true, refreshIntervalHours: 168 });
  assert.deepEqual(u.value, { refreshEnabled: true, refreshIntervalHours: 168 });
  assert.equal(K.validateResourceUpdate(urlRes, { refreshEnabled: true }).code, "refresh_interval_required", "existing null interval");
  assert.deepEqual(K.validateResourceUpdate(urlRes, {}).value, {});
});

test("status validation", () => {
  for (const s of ["empty", "processing", "ready", "error"]) assert.equal(K.validateResourceStatus(s).ok, true);
  assert.equal(K.validateResourceStatus("done").code, "status_invalid");
  for (const s of ["processing", "ready", "error"]) assert.equal(K.validateDocumentStatus(s).ok, true);
  assert.equal(K.validateDocumentStatus("empty").code, "status_invalid");
  assert.equal(K.deriveResourceStatus([]), "empty");
  assert.equal(K.deriveResourceStatus([{ status: "ready" }, { status: "processing" }]), "processing");
  assert.equal(K.deriveResourceStatus([{ status: "ready" }, { status: "error" }]), "ready");
  assert.equal(K.deriveResourceStatus([{ status: "error" }]), "error");
});

// ------------------------------------------------------------ documents

test("valid file document", () => {
  const r = K.validateDocument({ kind: "file", filename: " prices (2).pdf ", content: "Cleaning AED 300", position: 3, mime: "application/pdf" }, "file");
  assert.deepEqual(r.value, { kind: "file", filename: "prices (2).pdf", sourceUrl: null, mime: "application/pdf", content: "Cleaning AED 300", position: 3 });
});

test("file without a filename is refused", () => {
  for (const filename of [undefined, "", "   ", null, 7, "a\nb", "x".repeat(256)]) {
    assert.equal(K.validateDocument({ kind: "file", filename, content: "x" }, "file").code, "filename_required", String(filename));
  }
});

test("valid URL document (canonicalized)", () => {
  const r = K.validateDocument({ kind: "url", sourceUrl: "example.com/our-team#top", content: "Team" }, "url");
  assert.equal(r.value.sourceUrl, "https://example.com/our-team");
  assert.equal(r.value.filename, null);
});

test("URL without a valid source URL is refused", () => {
  for (const sourceUrl of [undefined, "", "   ", "ftp://example.com", "FTP://example.com/x", "javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "mailto:a@b.com", "http://user:pw@example.com/", 5]) {
    assert.equal(K.validateDocument({ kind: "url", sourceUrl, content: "x" }, "url").code, "source_url_required", String(sourceUrl));
  }
});

test("type mismatch: no masquerading between file and URL", () => {
  assert.equal(K.validateDocument({ kind: "url", sourceUrl: "https://example.com", content: "x" }, "file").code, "type_mismatch");
  assert.equal(K.validateDocument({ kind: "file", filename: "a.pdf", content: "x" }, "url").code, "type_mismatch");
  assert.equal(K.validateDocument({ kind: "file", filename: "a.pdf", sourceUrl: "https://example.com", content: "x" }, "file").code, "type_mismatch");
  assert.equal(K.validateDocument({ kind: "url", sourceUrl: "https://example.com", filename: "a.pdf", content: "x" }, "url").code, "type_mismatch");
  assert.equal(K.validateDocument({ kind: "text", content: "x" }, "file").code, "kind_invalid");
});

test("document content limit: 200,000 accepted, 200,001 refused", () => {
  assert.equal(K.validateDocument({ kind: "file", filename: "a.txt", content: "a".repeat(200_000) }, "file").ok, true);
  assert.equal(K.validateDocument({ kind: "file", filename: "a.txt", content: "a".repeat(200_001) }, "file").code, "content_too_large");
  assert.equal(K.validateDocument({ kind: "file", filename: "a.txt", content: 5 }, "file").code, "content_invalid");
  assert.deepEqual(K.clipContent("a".repeat(200_005)).truncated, true);
  assert.equal(K.clipContent("a".repeat(200_005)).content.length, 200_000);
});

test("negative / fractional position refused; default 0", () => {
  for (const position of [-1, 1.5, "2", NaN]) assert.equal(K.validateDocument({ kind: "file", filename: "a", content: "x", position }, "file").code, "position_invalid", String(position));
  assert.equal(K.validateDocument({ kind: "file", filename: "a", content: "x" }, "file").value.position, 0);
});

test("50-document limit: 49 existing → may add the 50th; 50 existing → the 51st is refused", () => {
  assert.equal(K.canAddDocument(49).ok, true);
  assert.equal(K.canAddDocument(49).value.remaining, 0);
  const r = K.canAddDocument(50);
  assert.equal(r.code, "document_limit");
  assert.equal(K.canAddDocument(0).value.remaining, 49);
});

// ------------------------------------------------------------ hashing

test("hashing is deterministic SHA-256 and detects changes", async () => {
  const a = await K.contentHash("The fee is AED 111.");
  assert.equal(a, await K.contentHash("The fee is AED 111."));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(await K.contentHash(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "known SHA-256 of empty input");
  assert.notEqual(a, await K.contentHash("The fee is AED 222."));
  assert.equal(K.sameContent(a, a), true);
  assert.equal(K.sameContent(a, await K.contentHash("other")), false);
  assert.equal(K.sameContent(null, null), false, "unknown hashes are never 'same'");
});

// ------------------------------------------------------------ file replacement

test("same filename (case-insensitive) is a REPLACE that keeps the document id and position", async () => {
  const docs = [doc({ id: "keep-me", filename: "Prices.PDF", contentHash: await K.contentHash("old"), position: 4 }), doc({ id: "other", filename: "faq.md", position: 5 })];
  const plan = await K.planFileUpload({ resourceType: "file", documents: docs, filename: " prices.pdf ", extraction: { ok: true, content: "new prices" } });
  assert.equal(plan.action, "replace");
  assert.equal(plan.documentId, "keep-me");
  assert.equal(plan.write.position, 4);
  assert.equal(plan.write.filename, "Prices.PDF", "stored name keeps its original casing");
  assert.equal(plan.write.contentHash, await K.contentHash("new prices"));
  assert.equal(plan.bumpVersion, true);
});

test("identical re-upload is unchanged (no content_version bump)", async () => {
  const docs = [doc({ id: "d1", filename: "a.txt", contentHash: await K.contentHash("same") })];
  const plan = await K.planFileUpload({ resourceType: "file", documents: docs, filename: "A.TXT", extraction: { ok: true, content: "same" } });
  assert.deepEqual(plan, { action: "unchanged", documentId: "d1", bumpVersion: false });
});

test("failed or empty extraction never touches existing content", async () => {
  const docs = [doc({ id: "d1", filename: "a.pdf", contentHash: "h" })];
  const failed = await K.planFileUpload({ resourceType: "file", documents: docs, filename: "a.pdf", extraction: { ok: false, error: "parse error" } });
  assert.deepEqual(failed, { action: "keep_existing", documentId: "d1", error: "parse error", bumpVersion: false });
  const empty = await K.planFileUpload({ resourceType: "file", documents: docs, filename: "a.pdf", extraction: { ok: true, content: "   " } });
  assert.equal(empty.action, "keep_existing");
  // No existing document → nothing to keep, the upload is rejected (nothing written).
  assert.equal((await K.planFileUpload({ resourceType: "file", documents: [], filename: "new.pdf", extraction: { ok: false, error: "x" } })).action, "reject");
});

test("new file inserts at the end; the 51st file is refused; wrong resource type refused", async () => {
  const docs = Array.from({ length: 3 }, (_, i) => doc({ id: `d${i}`, filename: `f${i}.txt`, position: i * 2 }));
  const plan = await K.planFileUpload({ resourceType: "file", documents: docs, filename: "new.txt", extraction: { ok: true, content: "hello" } });
  assert.equal(plan.action, "insert");
  assert.equal(plan.write.position, 5);
  const full = Array.from({ length: 50 }, (_, i) => doc({ id: `d${i}`, filename: `f${i}.txt`, position: i }));
  const r = await K.planFileUpload({ resourceType: "file", documents: full, filename: "f51.txt", extraction: { ok: true, content: "x" } });
  assert.equal(r.code, "document_limit");
  // Replacing inside a FULL resource is still allowed (no new row).
  assert.equal((await K.planFileUpload({ resourceType: "file", documents: full, filename: "F3.TXT", extraction: { ok: true, content: "changed" } })).action, "replace");
  assert.equal((await K.planFileUpload({ resourceType: "url", documents: [], filename: "a.txt", extraction: { ok: true, content: "x" } })).code, "type_mismatch");
});

test("oversized extraction is clipped to 200,000 and flagged", async () => {
  const plan = await K.planFileUpload({ resourceType: "file", documents: [], filename: "big.txt", extraction: { ok: true, content: "a".repeat(250_000) } });
  assert.equal(plan.write.content.length, 200_000);
  assert.equal(plan.write.truncated, true);
});

// ------------------------------------------------------------ URL refresh

const urlDoc = async (content) => ({ id: "u1", resourceId: "r-url", kind: "url", filename: null, sourceUrl: "https://example.com/", mime: "text/plain", content, contentHash: await K.contentHash(content), position: 2, status: "ready" });

test("URL refresh with unchanged content: no version bump", async () => {
  const d = await urlDoc("same page");
  assert.deepEqual(await K.planUrlRefresh({ document: d, fetch: { ok: true, content: "same page" } }), { action: "unchanged", documentId: "u1", bumpVersion: false });
});

test("URL refresh with changed content: replace in place and bump the version", async () => {
  const d = await urlDoc("old page");
  const plan = await K.planUrlRefresh({ document: d, fetch: { ok: true, content: "new page" } });
  assert.equal(plan.action, "replace");
  assert.equal(plan.documentId, "u1");
  assert.equal(plan.write.position, 2);
  assert.equal(plan.write.sourceUrl, "https://example.com/");
  assert.equal(plan.bumpVersion, true);
});

test("failed URL refresh keeps the last good content", async () => {
  const d = await urlDoc("good page");
  assert.deepEqual(await K.planUrlRefresh({ document: d, fetch: { ok: false, error: "timeout" } }), { action: "keep_existing", documentId: "u1", error: "timeout", bumpVersion: false });
  assert.equal((await K.planUrlRefresh({ document: d, fetch: { ok: true, content: "  " } })).action, "keep_existing");
});

test("adding a URL: new → insert; the same URL again → refresh of the existing document", async () => {
  const d = await urlDoc("v1");
  const again = await K.planUrlIngest({ resourceType: "url", documents: [d], sourceUrl: "https://EXAMPLE.com/#frag", fetch: { ok: true, content: "v2" } });
  assert.equal(again.action, "replace");
  assert.equal(again.documentId, "u1");
  const fresh = await K.planUrlIngest({ resourceType: "url", documents: [d], sourceUrl: "https://example.com/team", fetch: { ok: true, content: "team" } });
  assert.equal(fresh.action, "insert");
  assert.equal(fresh.write.position, 3);
  assert.equal((await K.planUrlIngest({ resourceType: "url", documents: [], sourceUrl: "https://example.com/x", fetch: { ok: false, error: "blocked" } })).action, "reject");
  assert.equal((await K.planUrlIngest({ resourceType: "file", documents: [], sourceUrl: "https://example.com/", fetch: { ok: true, content: "x" } })).code, "type_mismatch");
  assert.equal((await K.planUrlRefresh({ document: doc({}), fetch: { ok: true, content: "x" } })).code, "type_mismatch");
});

// ------------------------------------------------------------ duplicate

test("copy names: Copy, Copy 2, Copy 3 … case-insensitively", () => {
  assert.equal(K.copyName("Pricing", ["Pricing"]), "Pricing Copy");
  assert.equal(K.copyName("Pricing", ["Pricing", "pricing copy"]), "Pricing Copy 2");
  assert.equal(K.copyName("Pricing", ["Pricing", "Pricing Copy", "PRICING COPY 2"]), "Pricing Copy 3");
  assert.equal(K.copyName("Pricing Copy", ["Pricing", "Pricing Copy"]), "Pricing Copy 2", "duplicating a copy continues the sequence");
  assert.equal(K.copyName("Pricing Copy 2", ["Pricing", "Pricing Copy", "Pricing Copy 2"]), "Pricing Copy 3");
});

test("copy names never exceed 80 characters, even with long suffixes", () => {
  const long = "L".repeat(80);
  const first = K.copyName(long, [long]);
  assert.equal(first.length, 80);
  assert.ok(first.endsWith(" Copy"));
  const taken = [long, first];
  for (let i = 2; i <= 12; i++) {
    const next = K.copyName(long, taken);
    assert.ok(next.length <= 80, next);
    assert.ok(next.endsWith(` Copy ${i}`), next);
    taken.push(next);
  }
  assert.equal(K.normalizeResourceName(first).ok, true);
});

test("duplicate plan copies documents logically, never assignments, and leaves the source untouched", async () => {
  const docs = [doc({ id: "b", filename: "b.txt", position: 7, contentHash: "hb", content: "B" }), doc({ id: "a", filename: "a.txt", position: 1, contentHash: null, content: "A" })];
  const source = { ...fileRes };
  const before = JSON.stringify({ source, docs });
  const r = K.planDuplicate({ source, documents: docs, existingNames: ["Pricing"] });
  assert.equal(r.ok, true);
  assert.equal(r.value.resource.name, "Pricing Copy");
  assert.equal(r.value.resource.type, "file");
  assert.deepEqual(r.value.assignments, []);
  assert.deepEqual(r.value.documents.map((d) => [d.filename, d.position, d.content, d.contentHash]), [["a.txt", 0, "A", null], ["b.txt", 1, "B", "hb"]]);
  assert.ok(r.value.documents.every((d) => !("id" in d) && !("resourceId" in d)), "no ids — persistence assigns new ones");
  assert.equal(JSON.stringify({ source, docs }), before, "source not mutated");
});

// ------------------------------------------------------------ delete

test("delete allowed when unassigned", () => {
  assert.deepEqual(K.planDelete([]), { allowed: true });
});

test("delete blocked with one assignment, with agent details", () => {
  const p = K.planDelete([{ agentId: "a1", agentName: "Laura" }]);
  assert.equal(p.allowed, false);
  assert.equal(p.code, "resource_assigned");
  assert.equal(p.count, 1);
  assert.deepEqual(p.agents, [{ agentId: "a1", agentName: "Laura" }]);
  assert.match(p.message, /used by 1 agent \(Laura\)\. Unassign it from that agent first\./);
});

test("delete blocked with multiple assignments: deduplicated, sorted, summarized", () => {
  const p = K.planDelete([
    { agentId: "a3", agentName: "Tina" }, { agentId: "a1", agentName: "Laura" }, { agentId: "a3", agentName: "Tina" },
    { agentId: "a4", agentName: "Nova" }, { agentId: "a5", agentName: "" },
  ]);
  assert.equal(p.allowed, false);
  assert.equal(p.count, 4);
  assert.deepEqual(p.agents.map((a) => a.agentId), ["a1", "a4", "a3", "a5"]);
  assert.match(p.message, /used by 4 agents \(Laura, Nova, Tina and 1 more\)\. Unassign it from those agents first\./);
});

// ------------------------------------------------------------ tester

const tRes = [{ id: "rA", name: "Pricing" }, { id: "rB", name: "Doctors" }, { id: "rC", name: "Other clinic" }];
const tDocs = [
  { id: "dA", resourceId: "rA", kind: "file", filename: "prices.pdf", sourceUrl: null, content: "Invisalign costs AED 12,000.\n\nTeeth cleaning costs AED 300." },
  { id: "dB", resourceId: "rB", kind: "url", filename: null, sourceUrl: "https://example.com/", content: "--- Website page: https://example.com/team ---\nDr. Example is an orthodontist specialising in Invisalign." },
  { id: "dC", resourceId: "rC", kind: "file", filename: "secret.txt", sourceUrl: null, content: "Invisalign promo AED 1 secret of another resource." },
];

test("Tester ranks chunks across the selected resources with Central KB metadata", () => {
  const r = K.prepareTester({ question: "How much is Invisalign?", selectedResourceIds: ["rA", "rB"], resources: tRes, documents: tDocs });
  assert.equal(r.ok, true);
  assert.equal(r.value.found, true);
  const top = r.value.chunks[0];
  assert.equal(top.resourceId, "rA");
  assert.equal(top.resourceName, "Pricing");
  assert.equal(top.documentId, "dA");
  assert.equal(top.documentLabel, "prices.pdf");
  assert.equal(top.chunkIndex, 0);
  assert.ok(top.score > 0);
  assert.ok(top.preview.length <= 200);
  const web = r.value.chunks.find((c) => c.resourceId === "rB");
  assert.equal(web.section, "Website page: https://example.com/team", "URL page markers become the section");
  assert.equal(web.documentLabel, "https://example.com/");
  assert.match(r.value.context, /^\[1\] Pricing · prices\.pdf\n/);
});

test("Tester isolation: only selected AND known resources; unknown ids refused", () => {
  const r = K.prepareTester({ question: "Invisalign price", selectedResourceIds: ["rA"], resources: tRes, documents: tDocs });
  assert.ok(r.value.chunks.every((c) => c.resourceId === "rA"));
  assert.ok(!r.value.context.includes("secret"), "unselected resource never reaches the context");
  // An id outside the caller's resource list (another workspace) → refused.
  assert.equal(K.prepareTester({ question: "x", selectedResourceIds: ["rA", "foreign"], resources: tRes, documents: tDocs }).code, "resource_not_found");
  // A document claiming a selected id but not backed by a known resource is ignored.
  const sneaky = [...tDocs, { id: "dX", resourceId: "rZ", kind: "file", filename: "x", sourceUrl: null, content: "Invisalign injected" }];
  const s = K.prepareTester({ question: "Invisalign", selectedResourceIds: ["rA"], resources: tRes, documents: sneaky });
  assert.ok(!s.value.context.includes("injected"));
  assert.equal(K.prepareTester({ question: "x", selectedResourceIds: [], resources: tRes, documents: tDocs }).code, "selection_required");
  assert.equal(K.prepareTester({ question: "  ", selectedResourceIds: ["rA"], resources: tRes, documents: tDocs }).code, "question_required");
  assert.equal(K.prepareTester({ question: "q".repeat(1001), selectedResourceIds: ["rA"], resources: tRes, documents: tDocs }).code, "question_too_long");
});

test("Tester context is capped at 12,000 characters of best-ranked content", () => {
  const para = (i) => `Invisalign fact number ${i}. ` + "Detailed clear aligner pricing information. ".repeat(30);
  const big = Array.from({ length: 30 }, (_, i) => ({ id: `d${i}`, resourceId: "rA", kind: "file", filename: `f${i}.txt`, sourceUrl: null, content: para(i) }));
  const r = K.prepareTester({ question: "Invisalign aligner pricing", selectedResourceIds: ["rA"], resources: tRes, documents: big, topK: 50 });
  assert.ok(r.value.contextChars <= 12_000, String(r.value.contextChars));
  assert.ok(r.value.chunks.length > 1);
  assert.equal(r.value.contextChars, r.value.chunks.reduce((n, c) => n + c.chars, 0));
  // A caller can lower the cap but never raise it above 12,000.
  const lifted = K.prepareTester({ question: "Invisalign", selectedResourceIds: ["rA"], resources: tRes, documents: big, topK: 50, maxContextChars: 999_999 });
  assert.ok(lifted.value.contextChars <= 12_000);
});

test("Tester: nothing relevant → found=false, empty context (no model, no fallback text)", () => {
  const r = K.prepareTester({ question: "parking validation hours", selectedResourceIds: ["rA"], resources: tRes, documents: tDocs });
  assert.equal(r.value.found, false);
  assert.equal(r.value.context, "");
});

// ------------------------------------------------------------ isolation & consistency

test("no Voice Agent Prompt Configuration / runtime / IO dependency", () => {
  const full = fs.readFileSync(path.join(root, "src/lib/knowledge.ts"), "utf8");
  // Code only — comments may legitimately name what the module does NOT touch.
  const s = full.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const imports = [...s.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["@/lib/kb-retrieval"], "only the pure retrieval primitives");
  assert.doesNotMatch(s, /agent-reply|agent-config|livekit|vapi|builder-tools|supabase|fetch\(|process\.env|node:|agent_identity|first_message|firstMessage|instructions/i);
  assert.doesNotMatch(s, /\bany\b/, "no `any` types");
  const kb = fs.readFileSync(path.join(root, "src/lib/kb-retrieval.ts"), "utf8");
  assert.doesNotMatch(kb, /^import /m, "kb-retrieval stays dependency-free");
});

test("application limits match migration 0065", () => {
  const sql = fs.readFileSync(path.join(root, "supabase/migrations/0065_central_knowledge.sql"), "utf8").replace(/--[^\n]*/g, "");
  assert.match(sql, new RegExp(`between 1 and ${K.MAX_RESOURCE_NAME}\\)`));
  assert.match(sql, new RegExp(`char_length\\(content\\) <= ${K.MAX_DOCUMENT_CHARS}\\)`));
  assert.match(sql, new RegExp(`>= ${K.MAX_DOCUMENTS_PER_RESOURCE} then`));
  assert.match(sql, new RegExp(`refresh_interval_hours in \\(${K.REFRESH_INTERVAL_HOURS.join(", ")}\\)`));
  assert.match(sql, new RegExp(`type in \\(${K.RESOURCE_TYPES.map((t) => `'${t}'`).join(", ")}\\)`));
  assert.match(sql, new RegExp(`status in \\(${K.RESOURCE_STATUSES.map((t) => `'${t}'`).join(", ")}\\)`));
  assert.match(sql, new RegExp(`status in \\(${K.DOCUMENT_STATUSES.map((t) => `'${t}'`).join(", ")}\\)`));
  assert.deepEqual([...K.KNOWLEDGE_MANAGER_ROLES], ["owner", "manager"]);
});
