// Phase 1B — Central Knowledge lexical retrieval. PURE tests: the loader's row
// shaping (buildAgentCentralKnowledge) is exercised directly; searchKnowledgeCore
// runs with an INJECTED loader built from a fake database that mimics the real
// queries' filters (workspace_id, agent_id, status='ready'); the Supabase-bound
// loader itself is guarded by source scans. No database, no network, synthetic
// data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { buildAgentCentralKnowledge, centralSourceLabel } = await import("@/lib/knowledge-runtime");
const { searchKnowledgeCore, searchKnowledgeSpoken } = await import("@/lib/agent-tools-core");
const { retrieveKnowledge } = await import("@/lib/kb-retrieval");

const root = path.resolve(import.meta.dirname, "..");
const src = (p) => fs.readFileSync(path.join(root, p), "utf8");

const WS_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const WS_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const AGENT_LAURA = "00000000-aaaa-4000-8000-000000000001";
const AGENT_NOVA = "00000000-aaaa-4000-8000-000000000002";
const RES_FAQ = "00000000-cccc-4000-8000-000000000001";
const RES_PRICES = "00000000-cccc-4000-8000-000000000002";
const RES_FOREIGN = "00000000-cccc-4000-8000-00000000000b"; // workspace B's resource

const LEGACY_MARKER = "LEGACY-BLOB-ONLY-FACT osmium crowns";
const CENTRAL_FACT = "Dr Anmol Batria leads endodontics and root canal treatment.";
const FOREIGN_SECRET = "FOREIGN-WORKSPACE-SECRET implant price";

/** Fake database + a loader that applies the SAME filters as the real queries. */
function makeDb() {
  const db = {
    assignments: [], // { workspace_id, agent_id, resource_id, position }
    resources: [],   // { workspace_id, id, name }
    documents: [],   // { workspace_id, id, resource_id, filename, source_url, content, position, status }
  };
  const loader = async (ws, agentId) => {
    if (!ws || !agentId) return { assigned: false, knowledge: null };
    const assignments = db.assignments.filter((a) => a.workspace_id === ws && a.agent_id === agentId);
    if (!assignments.length) return { assigned: false, knowledge: null };
    const ids = assignments.map((a) => a.resource_id);
    const resources = db.resources.filter((r) => r.workspace_id === ws && ids.includes(r.id));
    const documents = db.documents.filter((d) => d.workspace_id === ws && ids.includes(d.resource_id) && d.status === "ready");
    return { assigned: true, knowledge: buildAgentCentralKnowledge(assignments, resources, documents) };
  };
  return { db, loader };
}

function seed(db) {
  db.resources.push(
    { workspace_id: WS_A, id: RES_FAQ, name: "Clinic FAQs" },
    { workspace_id: WS_A, id: RES_PRICES, name: "Price List" },
    { workspace_id: WS_B, id: RES_FOREIGN, name: "Foreign KB" }
  );
  db.documents.push(
    { workspace_id: WS_A, id: "d1", resource_id: RES_FAQ, filename: "doctors.pdf", source_url: null, content: CENTRAL_FACT, position: 0, status: "ready" },
    { workspace_id: WS_A, id: "d2", resource_id: RES_FAQ, filename: "hours.pdf", source_url: null, content: "Open 09:00 to 17:00, closed Fridays.", position: 1, status: "ready" },
    { workspace_id: WS_A, id: "d3", resource_id: RES_PRICES, filename: null, source_url: "https://clinic.example/prices", content: "Cleaning AED 300. Whitening AED 900.", position: 0, status: "ready" },
    { workspace_id: WS_B, id: "db1", resource_id: RES_FOREIGN, filename: "secret.pdf", source_url: null, content: FOREIGN_SECRET, position: 0, status: "ready" }
  );
}

const laura = (overrides = {}) => ({
  id: AGENT_LAURA,
  workspace_id: WS_A,
  name: "Laura",
  knowledge_base: `--- Legacy notes ---\n${LEGACY_MARKER}. Open 10:00 to 16:00 (outdated).`,
  ...overrides,
});

// ── central mode ──────────────────────────────────────────────────────────────

test("(1,12) an assigned Central resource is retrievable, with 'Resource / document' source labels", async () => {
  const w = makeDb();
  seed(w.db);
  w.db.assignments.push({ workspace_id: WS_A, agent_id: AGENT_LAURA, resource_id: RES_FAQ, position: 0 });
  const r = await searchKnowledgeCore(laura(), { query: "who leads root canal treatment?" }, "test", w.loader);
  assert.equal(r.success, true);
  assert.equal(r.sourceMode, "central");
  assert.equal(r.found, true);
  assert.ok(r.text.includes(CENTRAL_FACT), "central content answers");
  // Small KB → full mode: the text carries the composed source markers.
  assert.ok(r.text.includes("--- Clinic FAQs / doctors.pdf ---"), "label identifies resource + document");
});

test("(2) an UNASSIGNED resource of the same workspace is not retrievable", async () => {
  const w = makeDb();
  seed(w.db);
  w.db.assignments.push({ workspace_id: WS_A, agent_id: AGENT_LAURA, resource_id: RES_FAQ, position: 0 });
  // Price List exists in WS_A but is NOT assigned to Laura.
  const r = await searchKnowledgeCore(laura(), { query: "how much is whitening?" }, "test", w.loader);
  assert.equal(r.sourceMode, "central");
  assert.ok(!r.text.includes("Whitening"), "unassigned resource content never appears");
  assert.ok(!r.text.includes("Price List"), "unassigned resource label never appears");
});

test("(3, cross-tenant proof) even with KNOWN foreign UUIDs, another workspace's knowledge is unreachable", async () => {
  const w = makeDb();
  seed(w.db);
  // Hostile setup: workspace A rows point at workspace B's known resource id —
  // a state Phase 1A cannot create; the loader's workspace filters must still
  // exclude B's rows (as the real queries' .eq("workspace_id") do).
  w.db.assignments.push({ workspace_id: WS_A, agent_id: AGENT_LAURA, resource_id: RES_FOREIGN, position: 0 });
  const r = await searchKnowledgeCore(laura(), { query: "implant price secret" }, "test", w.loader);
  assert.ok(!r.text.includes(FOREIGN_SECRET), "foreign content never appears");
  // Phase 1C: assigned (even if only to an unreadable id) = migrated — the
  // tool stays central with nothing usable rather than serving any blob.
  assert.equal(r.sourceMode, "central");
  assert.equal(r.found, false, "truthfully no information — nothing foreign, nothing legacy");
  assert.ok(!r.text.includes(LEGACY_MARKER));
  // An agent of B likewise cannot be driven from A's context.
  w.db.assignments.push({ workspace_id: WS_B, agent_id: AGENT_NOVA, resource_id: RES_FOREIGN, position: 0 });
  const viaA = await searchKnowledgeCore(laura({ id: AGENT_NOVA, workspace_id: WS_A }), { query: "implant price secret" }, "test", w.loader);
  assert.ok(!viaA.text.includes(FOREIGN_SECRET));
});

test("(4,5,6) multiple resources and documents, deterministically ordered by assignment then document position", async () => {
  const w = makeDb();
  seed(w.db);
  // Assigned in reverse name order: positions decide, not names.
  w.db.assignments.push(
    { workspace_id: WS_A, agent_id: AGENT_LAURA, resource_id: RES_PRICES, position: 0 },
    { workspace_id: WS_A, agent_id: AGENT_LAURA, resource_id: RES_FAQ, position: 1 }
  );
  const r = await searchKnowledgeCore(laura(), { query: "anything" }, "test", w.loader);
  assert.equal(r.sourceMode, "central");
  const order = ["--- Price List / https://clinic.example/prices ---", "--- Clinic FAQs / doctors.pdf ---", "--- Clinic FAQs / hours.pdf ---"];
  const idx = order.map((m) => r.text.indexOf(m));
  assert.ok(idx.every((i) => i >= 0), "all three documents present");
  assert.deepEqual(idx.slice().sort((a, b) => a - b), idx, "assignment position, then document position");
  // Pure builder agrees (same rows, same order).
  const built = buildAgentCentralKnowledge(
    w.db.assignments.filter((a) => a.agent_id === AGENT_LAURA),
    w.db.resources.filter((x) => x.workspace_id === WS_A),
    w.db.documents.filter((d) => d.workspace_id === WS_A && d.status === "ready")
  );
  assert.equal(built.resources, 2);
  assert.equal(built.documents, 3);
});

test("(7,8) only ready documents participate; blank-content documents are ignored", async () => {
  const w = makeDb();
  seed(w.db);
  w.db.assignments.push({ workspace_id: WS_A, agent_id: AGENT_LAURA, resource_id: RES_PRICES, position: 0 });
  w.db.documents.push(
    { workspace_id: WS_A, id: "d4", resource_id: RES_PRICES, filename: "draft.pdf", source_url: null, content: "PROCESSING-CONTENT veneers", position: 1, status: "processing" },
    { workspace_id: WS_A, id: "d5", resource_id: RES_PRICES, filename: "broken.pdf", source_url: null, content: "ERROR-CONTENT implants", position: 2, status: "error" },
    { workspace_id: WS_A, id: "d6", resource_id: RES_PRICES, filename: "empty.pdf", source_url: null, content: "   \n  ", position: 3, status: "ready" }
  );
  const r = await searchKnowledgeCore(laura(), { query: "veneers implants cleaning" }, "test", w.loader);
  assert.equal(r.sourceMode, "central");
  assert.ok(r.text.includes("Cleaning AED 300"));
  for (const absent of ["PROCESSING-CONTENT", "ERROR-CONTENT", "empty.pdf"]) assert.ok(!r.text.includes(absent), absent);
  // All-unusable documents → null → fallback (deterministic rule E).
  assert.equal(
    buildAgentCentralKnowledge(
      [{ resource_id: RES_PRICES, position: 0 }],
      [{ id: RES_PRICES, name: "Price List" }],
      [{ id: "d6", resource_id: RES_PRICES, filename: "empty.pdf", source_url: null, content: "  ", position: 0 }]
    ),
    null
  );
});

// ── legacy fallback ───────────────────────────────────────────────────────────

test("(9,10) no assignments → legacy mode with byte-identical legacy retrieval behaviour", async () => {
  const w = makeDb();
  seed(w.db); // resources exist, nothing assigned
  const agent = laura();
  const r = await searchKnowledgeCore(agent, { query: "osmium crowns" }, "test", w.loader);
  assert.equal(r.sourceMode, "legacy");
  assert.ok(r.text.includes(LEGACY_MARKER));
  // Exactly what the legacy engine produces over the blob with the same options.
  const direct = retrieveKnowledge(agent.knowledge_base, ["osmium crowns", ""], { budget: 6000, relevantBudget: 6000, topK: 4 });
  assert.equal(r.text, direct.mode === "full" ? direct.text.slice(0, 6000) : direct.text);
});

test("(9b) assigned-but-unusable stays CENTRAL with no information (Phase 1C — never the stale blob); only an unknowable migration state falls back to legacy", async () => {
  const w = makeDb();
  seed(w.db);
  w.db.assignments.push({ workspace_id: WS_A, agent_id: AGENT_LAURA, resource_id: RES_PRICES, position: 0 });
  w.db.documents.forEach((d) => { if (d.resource_id === RES_PRICES) d.status = "processing"; });
  const r = await searchKnowledgeCore(laura(), { query: "osmium crowns" }, "test", w.loader);
  assert.equal(r.sourceMode, "central", "assignments exist → migrated, whatever the documents are doing");
  assert.equal(r.found, false, "nothing usable → truthfully no information");
  assert.ok(!r.text.includes(LEGACY_MARKER), "the legacy blob is never served to a migrated agent");
  // Only when the assignment lookup itself fails (migration state unknowable)
  // does the tool keep the legacy path, so a live call never dies.
  const thrown = await searchKnowledgeCore(laura(), { query: "osmium crowns" }, "test", async () => { throw new Error("db down"); });
  assert.equal(thrown.sourceMode, "legacy");
  assert.equal(thrown.success, true, "a loader failure never kills the tool");
  assert.ok(thrown.text.includes(LEGACY_MARKER));
});

test("(11) central mode NEVER silently includes the legacy blob", async () => {
  const w = makeDb();
  seed(w.db);
  w.db.assignments.push({ workspace_id: WS_A, agent_id: AGENT_LAURA, resource_id: RES_FAQ, position: 0 });
  // Query for a fact that exists ONLY in the legacy blob.
  const r = await searchKnowledgeCore(laura(), { query: "osmium crowns legacy" }, "test", w.loader);
  assert.equal(r.sourceMode, "central");
  assert.ok(!r.text.includes(LEGACY_MARKER), "legacy content is absent in central mode");
  assert.ok(!r.text.includes("10:00 to 16:00"), "outdated legacy hours are absent");
});

// ── engine behaviour preserved ────────────────────────────────────────────────

test("(13) budget and top-K behaviour is intact over large Central Knowledge", async () => {
  const w = makeDb();
  seed(w.db);
  w.db.assignments.push({ workspace_id: WS_A, agent_id: AGENT_LAURA, resource_id: RES_FAQ, position: 0 });
  // Inflate well past the 6,000-char budget so ranked retrieval kicks in.
  for (let i = 0; i < 30; i++) {
    w.db.documents.push({
      workspace_id: WS_A, id: `pad${i}`, resource_id: RES_FAQ, filename: `pad${i}.pdf`, source_url: null,
      content: `Padding document ${i}. ${"General dental hygiene advice sentence. ".repeat(20)}`,
      position: 10 + i, status: "ready",
    });
  }
  const r = await searchKnowledgeCore(laura(), { query: "who leads root canal treatment?" }, "test", w.loader);
  assert.equal(r.sourceMode, "central");
  assert.ok(r.sources.length >= 1 && r.sources.length <= 4, "top-K ≤ 4");
  assert.ok(r.text.length <= 6400, `budget respected (${r.text.length})`);
  assert.ok(r.text.includes("root canal"), "the relevant chunk is ranked in");
  assert.equal(r.sources[0].source, "Clinic FAQs / doctors.pdf", "ranked source keeps the central label");
});

test("(17) the tool contract is unchanged: result fields, spoken wrapper, missing_query", async () => {
  const w = makeDb();
  seed(w.db);
  w.db.assignments.push({ workspace_id: WS_A, agent_id: AGENT_LAURA, resource_id: RES_FAQ, position: 0 });
  const r = await searchKnowledgeCore(laura(), { query: "root canal" }, "test", w.loader);
  for (const k of ["success", "found", "text", "sources"]) assert.ok(k in r, k);
  assert.ok(Array.isArray(r.sources) && r.sources.every((s) => "source" in s && "id" in s && "score" in s));
  assert.match(searchKnowledgeSpoken(r), /^Relevant clinic knowledge \(answer ONLY from this/);
  const empty = await searchKnowledgeCore(laura(), { query: "" }, "test", w.loader);
  assert.deepEqual(empty, { success: false, error: "missing_query", found: false, text: "", sources: [] });
  // The worker contract file is untouched: same tokenless-arg tool, same post.
  assert.ok(src("livekit-agent/agent.py").includes('"/api/agents/tool-exec", {"token": WORKER_TOKEN, "agentId": agent_id, "name": name, "args": args}'));
});

test("centralSourceLabel is one line, id-free and falls back sensibly", () => {
  assert.equal(centralSourceLabel("Clinic\nFAQs", { filename: "a  b.pdf", source_url: null }), "Clinic FAQs / a b.pdf");
  assert.equal(centralSourceLabel("  ", { filename: null, source_url: null }), "Knowledge resource / Document");
  assert.equal(centralSourceLabel("Site", { filename: null, source_url: "https://x.example/p" }), "Site / https://x.example/p");
});

// ── wiring + security posture (source scans) ──────────────────────────────────

test("the real loader scopes EVERY query by workspace (and the assignment query by agent)", () => {
  const code = src("src/lib/knowledge-runtime.ts");
  // Loader: assignments + resources + documents; Phase 1C adds the prompt-mode
  // probe — four queries, every one workspace-filtered.
  assert.equal((code.match(/\.eq\("workspace_id", ws\)/g) ?? []).length, 4, "every query is workspace-filtered");
  assert.equal((code.match(/\.eq\("agent_id", agentId\)/g) ?? []).length, 2, "assignments and the probe are agent-filtered");
  assert.ok(code.includes('.eq("status", "ready")'), "only ready documents are loaded");
  assert.ok(code.includes('.in("resource_id", ids)') && code.includes('.in("id", ids)'), "resource ids come only from the agent's assignments");
  // Server-only: uses the service-role client; never imported by browser code
  // (tests/knowledge-ui.test.mjs scans every non-API src file for table names).
  assert.ok(code.includes("supabase-admin"));
});

test("(14,15,18) Phase 0 posture holds: tool-exec auth precedes data, worker pin wired, no Central KB in the browser JWT path", () => {
  const toolExec = src("src/app/api/agents/tool-exec/route.ts");
  const authAt = toolExec.indexOf("resolveWorkerToken(");
  const readAt = toolExec.indexOf('.from("agents")');
  assert.ok(authAt > 0 && readAt > 0 && authAt < readAt, "401 before any read");
  assert.ok(toolExec.includes("enforceWorkerWorkspacePin("));
  // The session route / livekit.ts may consult the MODE (Phase 1C) but never
  // load Central KB content or name the 0065 tables.
  const session = src("src/app/api/livekit/session/route.ts");
  const livekit = src("src/lib/livekit.ts");
  for (const [name, code] of [["session route", session], ["livekit.ts", livekit]]) {
    assert.doesNotMatch(code, /loadAgentCentralKnowledge|knowledge_documents|knowledge_resources|agent_knowledge_resources/, name);
  }
  assert.match(session, /:\s*dispatchMetadata\(/, "worker join tokens stay id-only");
});
