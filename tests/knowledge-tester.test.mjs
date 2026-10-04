// Central Knowledge Base Tester (Phase A5): POST /api/knowledge/test.
// Requests run through the REAL route wrapper (knowledge-route) and the REAL
// Tester (knowledge-tester → A2 prepareTester → kb-retrieval) against an
// in-memory, workspace-scoped store. The model is an injected fake: no
// network, no database, no provider. Synthetic data only.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { withKnowledge } = await import("@/lib/knowledge-route");
const T = await import("@/lib/knowledge-tester");
const K = await import("@/lib/knowledge");
const { KnowledgeMigrationMissing } = await import("@/lib/knowledge-service");

const root = path.resolve(import.meta.dirname, "..");
const src = (p) => fs.readFileSync(path.join(root, p), "utf8");

const WS_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const WS_B = "bbbbbbbb-0000-4000-8000-00000000000b";
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const SECRET = "CONFIDENTIAL-CLINIC-NOTE";

// ------------------------------------------------------------ store (reads used by the Tester)

function makeWorld() {
  const db = { resources: [], documents: [] };
  const reads = [];
  let missing = false;
  const guard = () => { if (missing) throw new KnowledgeMigrationMissing(); };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const store = {
    async getResource(ws, id) { guard(); reads.push(`getResource:${id}`); const r = db.resources.find((x) => x.workspace_id === ws && x.id === id); return r ? clone(r) : null; },
    async listDocuments(ws, rid, { withContent }) {
      guard();
      reads.push(`listDocuments:${rid}`);
      return clone(db.documents.filter((d) => d.workspace_id === ws && d.resource_id === rid).sort((a, b) => a.position - b.position)).map((d) => (withContent ? d : { ...d, content: "" }));
    },
  };
  // Every other store method must stay untouched by the Tester (read-only).
  for (const m of ["listResources", "insertResource", "updateResource", "deleteResource", "listDocumentStats", "applyDocumentChanges", "duplicateResource", "listAssignments"]) {
    store[m] = async () => { throw new Error(`Tester must not call ${m}`); };
  }
  const addResource = (ws, name, type = "file", status = "ready") => {
    const r = { id: uuid(), workspace_id: ws, name, description: "", type, status, refresh_enabled: false, refresh_interval_hours: null, next_refresh_at: null, last_refreshed_at: null, last_error: null, content_version: 1, created_by: null, updated_by: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" };
    db.resources.push(r);
    return r;
  };
  const addDoc = (r, content, extra = {}) => {
    const position = db.documents.filter((d) => d.resource_id === r.id).length;
    const d = {
      id: uuid(), workspace_id: r.workspace_id, resource_id: r.id, kind: r.type,
      filename: r.type === "file" ? extra.filename ?? `doc${position}.txt` : null,
      source_url: r.type === "url" ? extra.source_url ?? `https://example.com/p${position}` : null,
      mime: "text/plain", content, content_hash: "h", char_count: content.length, fetched_at: null,
      status: extra.status ?? "ready", error: extra.error ?? null, position, created_at: "x", updated_at: "x",
    };
    db.documents.push(d);
    return d;
  };
  const logs = [];
  const chatCalls = [];
  const ai = { mode: "answer", answer: "Cleaning costs AED 300 [1]." };
  const chat = async (messages) => {
    chatCalls.push(messages);
    if (ai.mode === "throw") throw new Error(`OpenRouter 500: upstream sk-or-v1-SECRETKEY ${SECRET}`);
    if (ai.mode === "empty") return "   ";
    return ai.answer;
  };
  const deps = (who = "owner", ws = WS_A, opts = {}) => ({
    authorize: async () => {
      if (who === "anon") return { ok: false, status: 401, error: "Sign in first." };
      if (who === "forged") return { ok: false, status: 401, error: "Invalid or expired session." };
      if (who === "outsider") return { ok: false, status: 403, error: "You are not a member of this workspace." };
      return { ok: true, userId: `user-${who}`, workspaceId: ws, role: who, isAdmin: who === "owner" };
    },
    serviceRoleConfigured: () => opts.noServiceRole !== true,
    store,
    ingest: () => ({ extract: async () => ({ ok: false, status: 500, error: "unused" }), importSite: async () => ({ ok: false, status: 500, error: "unused" }) }),
    now: () => new Date("2026-10-04T12:00:00Z"),
    log: (l) => logs.push(l),
  });
  // Exactly what the route does (mode "read", op "test").
  const ask = async (d, body, { noAi = false } = {}) => {
    const res = await withKnowledge(d, "read", "test", ({ ws, store: s, log }) => T.testKnowledge(s, ws, body, noAi ? null : chat, log));
    return { status: res.status, body: await res.json() };
  };
  return { db, reads, logs, chatCalls, ai, addResource, addDoc, deps, ask, setMissing: (v) => { missing = v; } };
}

function clinic(w) {
  const pricing = w.addResource(WS_A, "Pricing");
  w.addDoc(pricing, `Teeth cleaning costs AED 300. Whitening costs AED 900. ${SECRET}`, { filename: "prices.pdf" });
  const hours = w.addResource(WS_A, "Opening hours", "url");
  w.addDoc(hours, "The clinic is open Monday to Saturday from 9am to 9pm.", { source_url: "https://clinic.example/hours" });
  const foreign = w.addResource(WS_B, "Rival Pricing");
  w.addDoc(foreign, "Teeth cleaning costs AED 100 at the rival clinic.");
  return { pricing, hours, foreign };
}

// ------------------------------------------------------------ authentication / authorization

test("auth: anonymous / forged → 401, non-member → 403; owner, manager, doctor and agent may all test", async () => {
  const w = makeWorld();
  const { pricing } = clinic(w);
  const body = { resourceIds: [pricing.id], question: "How much is cleaning?" };
  for (const who of ["anon", "forged"]) {
    const r = await w.ask(w.deps(who), body);
    assert.equal(r.status, 401, who);
    assert.equal(r.body.code, "unauthenticated");
  }
  const out = await w.ask(w.deps("outsider"), body);
  assert.equal(out.status, 403);
  assert.equal(out.body.code, "forbidden");
  for (const who of ["owner", "manager", "doctor", "agent"]) {
    const r = await w.ask(w.deps(who), body);
    assert.equal(r.status, 200, who);
    assert.equal(r.body.ok, true);
  }
});

// ------------------------------------------------------------ validation

test("validation: resourceIds required, non-empty, valid UUIDs, at most 10; duplicates normalized", async () => {
  const w = makeWorld();
  const { pricing } = clinic(w);
  const q = "How much is cleaning?";
  const cases = [
    [{ question: q }, "selection_required"],
    [{ resourceIds: [], question: q }, "selection_required"],
    [{ resourceIds: "not-an-array", question: q }, "selection_required"],
    [{ resourceIds: ["not-a-uuid"], question: q }, "resource_id_invalid"],
    [{ resourceIds: [pricing.id, 42], question: q }, "resource_id_invalid"],
    [{ resourceIds: Array.from({ length: 11 }, () => uuid()), question: q }, "too_many_resources"],
  ];
  for (const [body, code] of cases) {
    w.reads.length = 0;
    const r = await w.ask(w.deps(), body);
    assert.equal(r.status, 400, code);
    assert.equal(r.body.code, code);
    assert.deepEqual(w.reads, [], "validated before any database read");
  }
  // Duplicates (incl. different case) → one resource tested once.
  const dup = await w.ask(w.deps(), { resourceIds: [pricing.id, pricing.id, pricing.id.toUpperCase()], question: q });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.resources.length, 1);
  assert.equal(new Set(dup.body.chunks.map((c) => c.documentId)).size, dup.body.chunks.length, "no duplicated chunks");
});

test("validation: question required, whitespace-only refused, 1,000-character limit; body must be an object", async () => {
  const w = makeWorld();
  const { pricing } = clinic(w);
  const ids = [pricing.id];
  for (const [question, code] of [[undefined, "question_required"], ["   \n\t ", "question_required"], [42, "question_required"], ["x".repeat(1001), "question_too_long"]]) {
    const r = await w.ask(w.deps(), { resourceIds: ids, question });
    assert.equal(r.status, 400, String(question).slice(0, 10));
    assert.equal(r.body.code, code);
  }
  assert.equal((await w.ask(w.deps(), { resourceIds: ids, question: "x".repeat(1000) })).status, 200);
  for (const body of [null, "text", [ids]]) assert.equal((await w.ask(w.deps(), body)).body.code, "invalid_body");
});

test("server-owned / agent / model / prompt fields are refused (400 field_not_allowed), nothing read", async () => {
  const w = makeWorld();
  const { pricing } = clinic(w);
  const fields = {
    workspace_id: WS_B, workspaceId: WS_B, ws: WS_B, agent_id: "a", agentId: "a", model: "anthropic/claude-opus", system: "x", systemPrompt: "x",
    prompt: "x", instructions: "Be Laura", promptConfiguration: {}, messages: [], temperature: 2, maxContextChars: 999999, topK: 100, knowledgeBase: "x",
  };
  for (const [k, v] of Object.entries(fields)) {
    w.reads.length = 0;
    const r = await w.ask(w.deps(), { resourceIds: [pricing.id], question: "price?", [k]: v });
    assert.equal(r.status, 400, k);
    assert.equal(r.body.code, "field_not_allowed", k);
    assert.deepEqual(w.reads, [], k);
  }
  assert.equal(w.chatCalls.length, 0);
});

// ------------------------------------------------------------ workspace isolation

test("workspace: own resources succeed; foreign, nonexistent and MIXED selections fail the whole request with 404", async () => {
  const w = makeWorld();
  const { pricing, hours, foreign } = clinic(w);
  const q = "How much is teeth cleaning?";
  assert.equal((await w.ask(w.deps(), { resourceIds: [pricing.id, hours.id], question: q })).status, 200);
  for (const ids of [[foreign.id], [uuid()], [pricing.id, foreign.id], [foreign.id, pricing.id, hours.id]]) {
    w.reads.length = 0;
    w.chatCalls.length = 0;
    const r = await w.ask(w.deps(), { resourceIds: ids, question: q });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "resource_not_found");
    assert.ok(!("chunks" in r.body) && !("answer" in r.body), "nothing partially tested");
    assert.ok(!w.reads.some((x) => x.startsWith("listDocuments")), "no document of any selected resource was read");
    assert.equal(w.chatCalls.length, 0);
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes("Rival") && !text.includes("AED 100") && !text.includes(foreign.id), "no foreign metadata disclosed");
  }
  // The foreign resource looks exactly like one that doesn't exist.
  const a = await w.ask(w.deps(), { resourceIds: [foreign.id], question: q });
  const b = await w.ask(w.deps(), { resourceIds: [uuid()], question: q });
  assert.deepEqual(a, b);
  // Its owner (workspace B) can test it.
  const own = await w.ask(w.deps("doctor", WS_B), { resourceIds: [foreign.id], question: q });
  assert.equal(own.status, 200);
  assert.match(own.body.chunks[0].preview, /AED 100/);
});

// ------------------------------------------------------------ retrieval

test("retrieval: one resource — ranked by the A2/kb-retrieval logic, with full source attribution", async () => {
  const w = makeWorld();
  const { pricing } = clinic(w);
  const r = await w.ask(w.deps("agent"), { resourceIds: [pricing.id], question: "how much does teeth cleaning cost" });
  assert.equal(r.status, 200);
  const c = r.body.chunks[0];
  const doc = w.db.documents.find((d) => d.resource_id === pricing.id);
  assert.deepEqual(
    { rank: c.rank, resourceId: c.resourceId, resourceName: c.resourceName, documentId: c.documentId, documentLabel: c.documentLabel, section: c.section, chunkIndex: c.chunkIndex },
    { rank: 1, resourceId: pricing.id, resourceName: "Pricing", documentId: doc.id, documentLabel: "prices.pdf", section: "prices.pdf", chunkIndex: 0 }
  );
  assert.ok(c.score > 0);
  assert.equal(c.chars, doc.content.length);
  assert.equal(c.preview, doc.content.slice(0, 200));
  assert.deepEqual(r.body.resources, [{ id: pricing.id, name: "Pricing", type: "file", status: "ready", documentCount: 1, searchedDocumentCount: 1 }]);
  assert.equal(r.body.retrieval.maxContextChars, 12000);
});

test("retrieval: multiple resources; ONLY the selected ones are searched; order and scores equal A2 prepareTester", async () => {
  const w = makeWorld();
  const { pricing, hours } = clinic(w);
  const other = w.addResource(WS_A, "Unselected FAQ");
  w.addDoc(other, "Teeth cleaning costs AED 250 on Fridays. Teeth cleaning teeth cleaning.");
  const question = "teeth cleaning cost and is the clinic open on saturday";
  const r = await w.ask(w.deps(), { resourceIds: [pricing.id, hours.id], question });
  assert.deepEqual(new Set(r.body.chunks.map((c) => c.resourceId)), new Set([pricing.id, hours.id]));
  assert.ok(!r.body.chunks.some((c) => c.resourceId === other.id), "unselected resource never searched");
  assert.ok(!w.reads.includes(`listDocuments:${other.id}`));
  // Same ranking as calling the approved A2 preparation directly.
  const sel = [pricing, hours];
  const direct = K.prepareTester({
    question,
    selectedResourceIds: sel.map((x) => x.id),
    resources: sel.map((x) => ({ id: x.id, name: x.name })),
    documents: w.db.documents.filter((d) => sel.some((x) => x.id === d.resource_id)).map((d) => ({ id: d.id, resourceId: d.resource_id, kind: d.kind, filename: d.filename, sourceUrl: d.source_url, content: d.content })),
  });
  assert.deepEqual(r.body.chunks.map((c) => [c.documentId, c.chunkIndex, c.score]), direct.value.chunks.map((c) => [c.documentId, c.chunkIndex, c.score]));
  assert.equal(r.body.chunks.find((c) => c.resourceId === hours.id).documentLabel, "https://clinic.example/hours");
});

test("retrieval: context capped at 12,000 characters (the model sees no more), previews ~200 characters", async () => {
  const w = makeWorld();
  const big = w.addResource(WS_A, "Big manual");
  for (let i = 0; i < 12; i++) w.addDoc(big, `Implant aftercare guidance part ${i}. ${"Implant aftercare rinse gently twice daily. ".repeat(80)}`);
  const r = await w.ask(w.deps(), { resourceIds: [big.id], question: "implant aftercare" });
  assert.ok(r.body.chunks.length > 1);
  assert.ok(r.body.retrieval.contextChars <= 12000, `context ${r.body.retrieval.contextChars}`);
  assert.equal(r.body.retrieval.contextChars, r.body.chunks.reduce((n, c) => n + c.chars, 0));
  assert.ok(r.body.retrieval.totalChunks > r.body.chunks.length, "the cap actually limited the selection");
  for (const c of r.body.chunks) assert.ok(c.preview.length <= 200);
  const sys = w.chatCalls.at(-1)[0].content;
  const excerpts = sys.slice(sys.indexOf("--- Knowledge excerpts ---"));
  assert.ok(excerpts.length < 12000 + 2000, "model context bounded by the cap (+ excerpt labels)");
});

test("eligible documents: ready + non-empty only; a ready document with a recorded refresh error keeps its last good content", async () => {
  const w = makeWorld();
  const res = w.addResource(WS_A, "Mixed", "url");
  w.addDoc(res, "Root canal costs AED 1500.", { status: "ready" });
  w.addDoc(res, "Root canal costs AED 1. STALE-PROCESSING", { status: "processing" });
  w.addDoc(res, "Root canal costs AED 2. ERROR-DOC", { status: "error", error: "fetch failed" });
  w.addDoc(res, "   ", { status: "ready" });
  w.addDoc(res, "Root canal aftercare: avoid chewing for a day.", { status: "ready", error: "Last refresh failed: timeout" });
  const r = await w.ask(w.deps(), { resourceIds: [res.id], question: "root canal cost and aftercare" });
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes("STALE-PROCESSING") && !text.includes("ERROR-DOC"), "processing / error documents never retrieved");
  assert.match(text, /AED 1500/);
  assert.match(text, /avoid chewing/, "last-known-good content of a ready document with an error is used");
  assert.deepEqual(r.body.retrieval, { ...r.body.retrieval, documentsSearched: 2, documentsSkipped: 3 });
  assert.equal(r.body.resources[0].documentCount, 5);
  assert.equal(r.body.resources[0].searchedDocumentCount, 2);
  // A resource with no documents at all → clean no-match.
  const empty = w.addResource(WS_A, "Empty", "file", "empty");
  const e = await w.ask(w.deps(), { resourceIds: [empty.id], question: "anything" });
  assert.equal(e.status, 200);
  assert.equal(e.body.answerStatus, "not_found");
  assert.deepEqual(e.body.chunks, []);
});

test("no useful match: clean 200 'not available' answer, empty chunks, and NO model call", async () => {
  const w = makeWorld();
  const { pricing } = clinic(w);
  w.chatCalls.length = 0;
  const r = await w.ask(w.deps(), { resourceIds: [pricing.id], question: "parking availability zzz" });
  assert.equal(r.status, 200);
  assert.equal(r.body.answerStatus, "not_found");
  assert.equal(r.body.answer, T.NOT_AVAILABLE_ANSWER);
  assert.deepEqual(r.body.generation, { status: "skipped_no_match", model: null });
  assert.deepEqual(r.body.chunks, []);
  assert.equal(r.body.retrieval.matchedChunks, 0);
  assert.equal(w.chatCalls.length, 0, "no unnecessary AI call");
});

// ------------------------------------------------------------ generation

test("grounded answer: neutral instruction + selected excerpts + the question — and nothing else", async () => {
  const w = makeWorld();
  const { pricing, hours } = clinic(w);
  w.chatCalls.length = 0;
  const r = await w.ask(w.deps("doctor"), { resourceIds: [pricing.id], question: "  How much is   teeth cleaning? " });
  assert.equal(r.body.answerStatus, "answered");
  assert.equal(r.body.answer, "Cleaning costs AED 300 [1].");
  assert.deepEqual(r.body.generation, { status: "answered", model: "openai/gpt-4o-mini" });
  assert.equal(w.chatCalls.length, 1);
  const msgs = w.chatCalls[0];
  assert.deepEqual(msgs.map((m) => m.role), ["system", "user"], "no history, no tools, no extra turns");
  assert.equal(msgs[1].content, "How much is teeth cleaning?", "the (normalized) question");
  const sys = msgs[0].content;
  assert.ok(sys.startsWith(T.TESTER_SYSTEM_INSTRUCTION));
  assert.match(T.TESTER_SYSTEM_INSTRUCTION, /ONLY the knowledge excerpts/);
  assert.match(T.TESTER_SYSTEM_INSTRUCTION, /not contained in the excerpts, reply exactly: "This isn't available in the selected knowledge resources\."/);
  assert.match(sys, /\[1\] Pricing · prices\.pdf\nTeeth cleaning costs AED 300/);
  assert.ok(!sys.includes("Monday to Saturday"), "unselected knowledge not in the context");
  // The instruction is neutral: no agent / Prompt Configuration / runtime material.
  const instruction = sys.slice(0, sys.indexOf("--- Knowledge excerpts ---"));
  assert.doesNotMatch(instruction, /laura|tina|nova|receptionist|prompt configuration|persona|personality|livekit|vapi|builder|tool|function call|book_appointment|patient context|language:/i);
  assert.equal(msgs.length, 2);
  void hours;
});

test("AI not configured → 200 retrieval-only (answer null, generation unavailable); no configuration details exposed", async () => {
  const w = makeWorld();
  const { pricing } = clinic(w);
  const r = await w.ask(w.deps(), { resourceIds: [pricing.id], question: "teeth cleaning cost" }, { noAi: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.answer, null);
  assert.equal(r.body.answerStatus, "retrieval_only");
  assert.deepEqual(r.body.generation, { status: "unavailable", model: null, reason: "not_configured" });
  assert.ok(r.body.chunks.length > 0, "retrieval returned normally");
  assert.doesNotMatch(JSON.stringify(r.body), /OPENROUTER|api[_ ]?key|sk-/i);
});

test("provider failure / empty response → 200 with retrieval preserved, generation failed, no provider internals", async () => {
  const w = makeWorld();
  const { pricing } = clinic(w);
  for (const [mode, reason] of [["throw", "provider_error"], ["empty", "empty_response"]]) {
    w.ai.mode = mode;
    const r = await w.ask(w.deps(), { resourceIds: [pricing.id], question: "teeth cleaning cost" });
    assert.equal(r.status, 200, mode);
    assert.equal(r.body.answer, null);
    assert.equal(r.body.answerStatus, "retrieval_only");
    assert.deepEqual(r.body.generation, { status: "failed", model: null, attemptedModel: "openai/gpt-4o-mini", reason }, "no model credited for a failed generation");
    assert.ok(r.body.chunks.length > 0);
    assert.doesNotMatch(JSON.stringify(r.body), /sk-or|SECRETKEY|OpenRouter 500|upstream/);
  }
  for (const l of w.logs) assert.doesNotMatch(l, /sk-or|SECRETKEY|upstream/);
});

test("AI timeout (30 s) → 200 retrieval-only with generation failed/timeout", async () => {
  const w = makeWorld();
  const { pricing } = clinic(w);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let called = false;
    const hang = () => { called = true; return new Promise(() => {}); };
    const pending = withKnowledge(w.deps(), "read", "test", ({ ws, store, log }) => T.testKnowledge(store, ws, { resourceIds: [pricing.id], question: "teeth cleaning cost" }, hang, log));
    while (!called) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(T.TESTER_AI_TIMEOUT_MS);
    const res = await pending;
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.generation, { status: "failed", model: null, attemptedModel: "openai/gpt-4o-mini", reason: "timeout" });
    assert.ok(body.chunks.length > 0);
  } finally {
    mock.timers.reset();
  }
});

// ------------------------------------------------------------ A5.1: real OpenRouter helper, stubbed network

const { callOpenRouter } = await import("@/lib/agent-reply");

/** Run one Tester request through the REAL callOpenRouter with a stubbed fetch; records every outbound request. */
async function viaOpenRouter(w, respond, body) {
  const requests = [];
  const realFetch = globalThis.fetch;
  const savedEnv = {};
  // A configured xAI key must make NO difference: the Tester never falls back.
  for (const k of ["X_AI_VOICE_KEY", "XAI_API_KEY", "GROK_API_KEY"]) { savedEnv[k] = process.env[k]; process.env[k] = "xai-test-key"; }
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
    return respond(String(url));
  };
  try {
    const chat = T.openRouterTesterChat("or-test-key", callOpenRouter);
    const res = await withKnowledge(w.deps(), "read", "test", ({ ws, store, log }) => T.testKnowledge(store, ws, body, chat, log));
    return { status: res.status, body: await res.json(), requests };
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const jsonRes = (status, obj) => new Response(typeof obj === "string" ? obj : JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

test("A5.1 success: exactly one OpenRouter request, model openai/gpt-4o-mini, only the two Tester messages", async () => {
  const w = makeWorld();
  const { pricing } = clinic(w);
  const r = await viaOpenRouter(w, () => jsonRes(200, { model: "openai/gpt-4o-mini", choices: [{ message: { content: "AED 300 [1]." } }] }), { resourceIds: [pricing.id], question: "teeth cleaning cost" });
  assert.equal(r.status, 200);
  assert.equal(r.body.answerStatus, "answered");
  assert.deepEqual(r.body.generation, { status: "answered", model: "openai/gpt-4o-mini" });
  assert.equal(r.body.answer, "AED 300 [1].");
  assert.equal(r.requests.length, 1);
  const q = r.requests[0];
  assert.equal(q.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(q.init.headers.Authorization, "Bearer or-test-key");
  assert.equal(q.body.model, "openai/gpt-4o-mini");
  assert.equal(q.body.temperature, 0);
  assert.deepEqual(q.body.messages.map((m) => m.role), ["system", "user"]);
  assert.ok(q.body.messages[0].content.startsWith(T.TESTER_SYSTEM_INSTRUCTION));
  assert.equal(q.body.messages[1].content, "teeth cleaning cost");
  assert.ok(!("tools" in q.body) && !("tool_choice" in q.body));
  assert.doesNotMatch(JSON.stringify(r.body), /or-test-key|xai-test-key/);
});

test("A5.1 browser cannot select the model: a `model` field is refused before any request", async () => {
  const w = makeWorld();
  const { pricing } = clinic(w);
  for (const model of ["xai/grok-4", "anthropic/claude-opus", "openai/gpt-4o"]) {
    const r = await viaOpenRouter(w, () => jsonRes(200, {}), { resourceIds: [pricing.id], question: "teeth cleaning cost", model });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "field_not_allowed");
    assert.equal(r.requests.length, 0);
  }
});

test("A5.1 failures → 200 retrieval_only, chunks preserved, NO xAI / Grok / other-model request, no model credited", async () => {
  const w = makeWorld();
  const { pricing } = clinic(w);
  const cases = [
    ["insufficient credit (402)", () => jsonRes(402, { error: { message: "Insufficient credits. Prompt tokens limit exceeded" } }), "provider_error"],
    ["provider error (500)", () => jsonRes(500, { error: { message: "upstream sk-or-v1-LEAK" } }), "provider_error"],
    ["rate limited (429)", () => jsonRes(429, "Too Many Requests"), "provider_error"],
    ["network failure", () => { throw new TypeError("fetch failed"); }, "provider_error"],
    ["empty response", () => jsonRes(200, { choices: [{ message: { content: "" } }] }), "empty_response"],
    ["no choices", () => jsonRes(200, {}), "empty_response"],
  ];
  for (const [name, respond, reason] of cases) {
    const r = await viaOpenRouter(w, respond, { resourceIds: [pricing.id], question: "teeth cleaning cost" });
    assert.equal(r.status, 200, name);
    assert.equal(r.body.answer, null, name);
    assert.equal(r.body.answerStatus, "retrieval_only", name);
    assert.deepEqual(r.body.generation, { status: "failed", model: null, attemptedModel: "openai/gpt-4o-mini", reason }, name);
    assert.ok(r.body.chunks.length > 0 && r.body.chunks[0].resourceId === pricing.id, `${name}: retrieval preserved`);
    assert.equal(r.requests.length, 1, `${name}: one request, no retry / fallback`);
    for (const q of r.requests) {
      assert.equal(q.url, "https://openrouter.ai/api/v1/chat/completions", name);
      assert.doesNotMatch(q.url, /x\.ai|grok/i, `${name}: no xAI / Grok`);
      assert.equal(q.body.model, "openai/gpt-4o-mini", `${name}: no other model`);
    }
    assert.doesNotMatch(JSON.stringify(r.body), /Insufficient credits|sk-or-v1|LEAK|Too Many|fetch failed|OpenRouter error/, `${name}: no provider internals`);
  }
});

test("A5.1 OpenRouter not configured → retrieval_only (unavailable / not_configured), no request at all", async () => {
  const w = makeWorld();
  const { pricing } = clinic(w);
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("must not be called"); };
  try {
    const r = await w.ask(w.deps(), { resourceIds: [pricing.id], question: "teeth cleaning cost" }, { noAi: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.answer, null);
    assert.equal(r.body.answerStatus, "retrieval_only");
    assert.deepEqual(r.body.generation, { status: "unavailable", model: null, reason: "not_configured" });
    assert.ok(r.body.chunks.length > 0);
    assert.equal(calls, 0, "no OpenRouter, xAI or any other request");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("A5.1 timeout through the real helper → retrieval_only / timeout, the single request was OpenRouter", async () => {
  const w = makeWorld();
  const { pricing } = clinic(w);
  const realFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = (url) => { urls.push(String(url)); return new Promise(() => {}); };
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const chat = T.openRouterTesterChat("or-test-key", callOpenRouter);
    const pending = withKnowledge(w.deps(), "read", "test", ({ ws, store, log }) => T.testKnowledge(store, ws, { resourceIds: [pricing.id], question: "teeth cleaning cost" }, chat, log));
    while (!urls.length) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(T.TESTER_AI_TIMEOUT_MS);
    const res = await pending;
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.answerStatus, "retrieval_only");
    assert.deepEqual(body.generation, { status: "failed", model: null, attemptedModel: "openai/gpt-4o-mini", reason: "timeout" });
    assert.ok(body.chunks.length > 0);
    assert.deepEqual(urls, ["https://openrouter.ai/api/v1/chat/completions"]);
  } finally {
    mock.timers.reset();
    globalThis.fetch = realFetch;
  }
});

// ------------------------------------------------------------ privacy / logging

test("privacy: response has previews only (no assembled context / prompt); logs carry metadata only", async () => {
  const w = makeWorld();
  const res = w.addResource(WS_A, "Long policy");
  const longText = `Refund policy: ${"refunds are processed within fourteen days of the request. ".repeat(10)} ${SECRET}`;
  w.addDoc(res, longText);
  const question = "refund policy processing time";
  const r = await w.ask(w.deps(), { resourceIds: [res.id], question });
  const text = JSON.stringify(r.body);
  assert.ok(longText.length > 300);
  assert.ok(!text.includes(longText), "full chunk text not returned");
  assert.ok(!text.includes(SECRET), "content beyond the preview not returned");
  assert.ok(!text.includes(T.TESTER_SYSTEM_INSTRUCTION) && !text.includes("Knowledge excerpts"), "no system prompt / context");
  for (const c of r.body.chunks) assert.ok(!("text" in c) && !("content" in c));
  const testLogs = w.logs.filter((l) => l.includes("op=test"));
  assert.equal(testLogs.length, 1);
  assert.match(testLogs[0], /^\[knowledge\] op=test ws=[0-9a-f-]+ resources=1 documents=1 eligible=1 chunks=\d+\/\d+ context_chars=\d+ scores=[\d.,]+ generation=answered$/);
  for (const l of w.logs) {
    assert.ok(!l.includes(SECRET) && !l.includes("Refund policy") && !l.includes("refunds are processed"), "no knowledge content");
    assert.ok(!l.includes(question) && !l.includes("Long policy"), "no question / resource names");
  }
});

// ------------------------------------------------------------ fail closed

test("migration 0065 missing → 503 knowledge_migration_missing for every role (never empty, 404, 500 or success)", async () => {
  const w = makeWorld();
  const { pricing } = clinic(w);
  w.setMissing(true);
  for (const who of ["owner", "manager", "doctor", "agent"]) {
    const r = await w.ask(w.deps(who), { resourceIds: [pricing.id], question: "price?" });
    assert.equal(r.status, 503, who);
    assert.equal(r.body.code, "knowledge_migration_missing");
    assert.equal(r.body.ok, false);
  }
  assert.equal(w.chatCalls.length, 0);
});

test("internal Central KB failure → generic 500; missing service role → 503", async () => {
  const w = makeWorld();
  const { pricing } = clinic(w);
  const d = w.deps();
  d.store.listDocuments = async () => { throw new Error(`select failed near ${SECRET}`); };
  const r = await w.ask(d, { resourceIds: [pricing.id], question: "price?" });
  assert.equal(r.status, 500);
  assert.equal(r.body.code, "internal_error");
  assert.ok(!JSON.stringify(r.body).includes(SECRET));
  assert.equal((await w.ask(w.deps("owner", WS_A, { noServiceRole: true }), { resourceIds: [pricing.id], question: "x" })).body.code, "service_unavailable");
});

// ------------------------------------------------------------ static wiring / isolation

const code = (f) => src(f).replace(/^\s*\/\/[^\n]*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

test("route: POST /api/knowledge/test is a READ (any member), session workspace only, no direct database access", () => {
  const route = src("src/app/api/knowledge/test/route.ts");
  assert.match(route, /export async function POST\(req: NextRequest\)/);
  assert.match(route, /withKnowledge\(knowledgeDeps\(req\), "read", "test", \(\{ ws, store, log \}\) => testKnowledge\(store, ws, body, knowledgeTesterChat\(\), log\)\)/);
  assert.match(route, /export const runtime = "nodejs";/);
  assert.doesNotMatch(code("src/app/api/knowledge/test/route.ts"), /supabase|workspace_id|headers\.get|searchParams/);
  assert.doesNotMatch(route, /export async function (GET|PUT|PATCH|DELETE)/);
});

test("model / provider (static): OpenRouter-only callOpenRouter with the fixed model; never resilientChat / xAI / Grok", () => {
  const server = code("src/lib/knowledge-server.ts");
  const fnBody = server.slice(server.indexOf("export function knowledgeTesterChat"));
  assert.match(fnBody, /const apiKey = process\.env\.OPENROUTER_API_KEY \?\? "";\s*if \(!apiKey\) return null;\s*return openRouterTesterChat\(apiKey, callOpenRouter\);/);
  assert.match(server, /import \{ callOpenRouter \} from "@\/lib\/agent-reply";/);
  for (const f of ["src/lib/knowledge-server.ts", "src/lib/knowledge-tester.ts", "src/app/api/knowledge/test/route.ts"]) {
    assert.doesNotMatch(code(f), /resilientChat|callXaiChat|x\.ai|grok|XAI|xai/i, `${f}: no fallback provider`);
  }
  assert.equal(T.TESTER_MODEL, "openai/gpt-4o-mini");
  // The Tester itself never sees the key source, an agent, or another provider SDK.
  const tester = code("src/lib/knowledge-tester.ts");
  assert.doesNotMatch(tester, /process\.env|OPENROUTER|from "openai"|@ai-sdk|anthropic/);
  assert.doesNotMatch(tester, /agents|kb_files|knowledge_base|knowledgeBase|agent-reply|livekit|vapi|builder|prompt_config|promptConfig/i);
  const pkg = JSON.parse(src("package.json"));
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) assert.doesNotMatch(dep, /^(openai|@ai-sdk\/|ai$|@anthropic-ai\/|@google\/generative-ai)/, `no new AI SDK: ${dep}`);
});

test("production resilientChat is unchanged: OpenRouter first, direct-xAI fallback on credit errors still in place", () => {
  const ar = src("src/lib/agent-reply.ts");
  const rc = ar.slice(ar.indexOf("export async function resilientChat("), ar.indexOf("/** Metadata about what knowledge was retrieved"));
  assert.match(rc, /const data = await callOpenRouter\(apiKey, model, body\);/);
  assert.match(rc, /if \(\/402\|credit\|tokens limit\|Prompt tokens\|payment\/i\.test\(primary\)\) \{\s*try \{\s*const data = await callXaiChat\(body\);/);
  assert.match(rc, /if \(isLivekitModel\(model\)\)/);
  // callOpenRouter itself: one OpenRouter request, no fallback, no logging.
  const co = ar.slice(ar.indexOf("export async function callOpenRouter("), ar.indexOf("// ── LiveKit Inference"));
  assert.match(co, /await fetch\("https:\/\/openrouter\.ai\/api\/v1\/chat\/completions"/);
  assert.equal([...co.matchAll(/fetch\(/g)].length, 1);
  assert.doesNotMatch(co, /console\.|callXaiChat|x\.ai/);
});

test("runtime isolation: no agent / runtime file references the Tester or the Central KB", () => {
  for (const f of [
    "src/lib/livekit.ts", "src/app/api/livekit/agent-config/route.ts", "src/lib/agent-tools-core.ts", "src/app/api/agents/tool-exec/route.ts",
    "livekit-agent/agent.py", "src/lib/builder-tools.ts", "src/app/api/builder-tools/[agentId]/[tool]/route.ts", "src/app/api/vapi/assistants/route.ts",
    "src/lib/agent-reply.ts", "src/app/api/chat/route.ts", "src/app/api/whatsapp/webhook/route.ts", "src/app/api/sms/webhook/route.ts",
    "src/components/dashboard/agents-shared.tsx", "src/lib/db.ts", "src/lib/agent-management.ts", "src/lib/kb-retrieval.ts",
  ]) {
    assert.doesNotMatch(src(f), /knowledge-tester|\/api\/knowledge|knowledge_resources|knowledge_documents|knowledge-server|knowledge-service/, f);
  }
});
