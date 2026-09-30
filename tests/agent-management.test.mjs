// Agent management (Rename / Duplicate / Delete) — pure logic against an
// in-memory store and a READ-ONLY fake LiveKit. Synthetic ids and data only.
import { test } from "node:test";
import assert from "node:assert/strict";

const M = await import("@/lib/agent-management");
const { dispatchMetadata } = await import("@/lib/livekit");

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const TINA = "aaaaaaaa-0000-4000-8000-000000000001";
const LAURA = "aaaaaaaa-0000-4000-8000-000000000002";
const SPARE = "aaaaaaaa-0000-4000-8000-000000000003";
const NOVA = "aaaaaaaa-0000-4000-8000-000000000004";
const FOREIGN = "bbbbbbbb-0000-4000-8000-000000000009";

const clone = (v) => JSON.parse(JSON.stringify(v));

function voiceSettings(extra = {}) {
  return {
    minSpeechDuration: 0.1,
    turnDetectionEnabled: true,
    detectionMode: "smart",
    maxCallDuration: 30,
    dataStorage: "store_only",
    recordCalls: false,
    transferNumber: "+15550100000",
    transferMessage: "One moment.",
    extractionFields: [{ name: "reason", description: "why they called", type: "string" }],
    livekit: { stt: "deepgram/nova-3", sttLanguage: "", llm: "openai/gpt-4.1-mini", tts: "inworld/inworld-tts-2", voice: "Ashley", interruptions: "adaptive", agentName: "" },
    interruptions: { mode: "adaptive", minDuration: 0.5, minWords: 2, resumeFalseInterruption: true },
    tools: { book_appointment: true, send_email: false },
    callEnding: { enabled: true, mode: "explicit", messages: { general: "Goodbye!" }, confirmBeforeEnding: true, hangupDelaySec: 1, silenceTimeoutSec: 0 },
    configVersion: 1,
    ...extra,
  };
}

function agent(id, name, extra = {}) {
  return {
    id,
    workspace_id: WS,
    name,
    kind: "voice",
    role: "Receptionist",
    status: "Live",
    model: "openai/gpt-4o-mini",
    vapi_assistant_id: `vapi-${id.slice(-4)}`,
    xai_agent_id: `xai-${id.slice(-4)}`,
    voice: "Warm female",
    voice_id: "voice-1",
    first_message: `Hi, this is ${name}.`,
    first_message_mode: "assistant_first",
    language: "English",
    agent_identity: `You are ${name}.`,
    instructions: "Help callers book.",
    behavior: "Be brief.",
    knowledge_base: "Open 9-5.",
    kb_files: ["prices.pdf"],
    can_book: true,
    can_reschedule: true,
    can_cancel: false,
    channels: ["whatsapp"],
    purpose: "inbound",
    voice_settings: voiceSettings(),
    created_at: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

// Imported, console-bound (clinic-shaped): LiveKit Builder provenance, a
// console binding, and a Builder HTTP tool that calls this agent's own id.
function importedLaura() {
  return agent(LAURA, "Laura", {
    voice_settings: voiceSettings({
      livekit: { stt: "deepgram/nova-3", sttLanguage: "", llm: "openai/gpt-4.1-mini", tts: "cartesia/sonic-3", voice: "Katie", interruptions: "adaptive", agentName: "receptionist-console-fixture" },
      builderImport: { source: "livekit-builder", agentName: "receptionist-console-fixture", agentId: "CA_fixture1", agentVersion: "v7", importedAt: "2026-02-01T00:00:00Z", fields: {}, sourceFingerprint: "abc123" },
      importedTools: [
        { name: "book", displayName: "Book", type: "http", enabled: true, source: "livekit-builder", executable: false, url: `https://pydent.example/api/builder-tools/${LAURA}/book_appointment` },
        { name: "end_call", displayName: "End call", type: "end_call", enabled: true, source: "livekit-builder", executable: true },
      ],
      endCall: { enabled: true, conditions: "caller says bye", finalResponse: "Bye!", deleteRoom: true, summaryUrl: "", summaryHeaders: {} },
    }),
  });
}

function world(opts = {}) {
  const agents = new Map();
  for (const a of [
    agent(TINA, "Tina"),
    importedLaura(),
    agent(SPARE, "Spare Test Agent", { status: "Draft" }),
    agent(NOVA, "Nova", { role: "Sales" }),
    agent(FOREIGN, "Foreign Agent", { workspace_id: OTHER_WS }),
  ]) agents.set(a.id, a);
  const numbers = opts.numbers ?? [
    // US-shaped test number: DB-assigned to Tina, not provider-linked.
    { workspace_id: WS, number: "+15550100001", nickname: "US test", agent_id: TINA, routing_agent_id: null, routing_provider: "none" },
    // Clinic-shaped: provider-routed + protected, assigned to Laura.
    { workspace_id: WS, number: "+15550100002", nickname: "Clinic", agent_id: LAURA, routing_agent_id: LAURA, routing_provider: "livekit", routing_protected: true },
  ];
  // Dispatch rules — the US-shaped rule names Tina in its metadata.
  const rules = opts.rules ?? [
    { sipDispatchRuleId: "SDR_fixtureUS", roomConfig: { agents: [{ agentName: "pydent-agent", metadata: dispatchMetadata(TINA, WS, { source: "phone" }) }] } },
    { sipDispatchRuleId: "SDR_fixtureCL", roomConfig: { agents: [{ agentName: "receptionist-console-fixture" }] } },
  ];
  const calls = { inserts: [], deletes: [], renames: [], restores: [] };
  const store = {
    async getAgent(ws, id) {
      const a = agents.get(id);
      return a && a.workspace_id === ws ? clone(a) : null;
    },
    async listAgentNames(ws) {
      return [...agents.values()].filter((a) => a.workspace_id === ws).map((a) => ({ id: a.id, name: a.name, kind: a.kind }));
    },
    async renameAgent(ws, id, expected, name) {
      const a = agents.get(id);
      if (!a || a.workspace_id !== ws || a.name !== expected) return false;
      a.name = name;
      calls.renames.push({ id, name });
      return true;
    },
    async insertAgent(row) {
      if (opts.insertError) return { error: opts.insertError };
      const id = `cccccccc-0000-4000-8000-${String(calls.inserts.length + 1).padStart(12, "0")}`;
      agents.set(id, { ...clone(row), id, created_at: "2026-09-30T00:00:00Z" });
      calls.inserts.push(clone(row));
      return { id };
    },
    async deleteAgent(ws, id) {
      const a = agents.get(id);
      if (!a || a.workspace_id !== ws) return false;
      agents.delete(id);
      calls.deletes.push(id);
      if (opts.raceAssign) numbers.push({ workspace_id: ws, number: "+15550100009", nickname: null, agent_id: id, routing_agent_id: null, routing_provider: "none" });
      return true;
    },
    async restoreAgent(row) {
      agents.set(row.id, clone(row));
      calls.restores.push(row.id);
      return true;
    },
    async numberReferences(agentId) {
      const out = [];
      for (const n of numbers) {
        for (const field of ["agent_id", "routing_agent_id"]) {
          if (n[field] === agentId) out.push({ workspaceId: n.workspace_id, number: n.number, nickname: n.nickname ?? null, field, routingProvider: n.routing_provider });
        }
      }
      return out;
    },
    async unfinishedAssignments(agentId) {
      return (opts.audits ?? []).filter((a) => ["pending", "reconcile_needed"].includes(a.status) && (a.from_agent_id === agentId || a.to_agent_id === agentId)).length;
    },
    async activeNumberLeases() {
      return opts.leases ?? 0;
    },
    async configReferences(_ws, agentId) {
      return { channel_defaults: (opts.channelDefaults ?? []).filter((x) => x === agentId).length, campaigns: 0, workflows: 0, phone_lines: 0, pipeline_stage_agents: 0 };
    },
    async cascadeCounts() {
      return { conversationAssignments: 2, followUps: 1 };
    },
  };
  // READ-ONLY LiveKit reader: returns rule JSON; it has no write surface
  // (tests/agent-management-safety checks the real binding statically).
  const livekit = opts.livekitDown
    ? async () => ({ ok: false, reason: "unavailable", error: "connect ECONNREFUSED" })
    : opts.livekitMissing
    ? async () => ({ ok: false, reason: "not_configured", error: "No LiveKit project configured." })
    : async () => ({ ok: true, projects: 1, rules: rules.map((r) => ({ id: r.sipDispatchRuleId, json: JSON.stringify(r) })) });
  const deps = {
    store,
    livekitRules: livekit,
    workerAgentName: async () => "pydent-agent",
    now: () => new Date("2026-09-30T12:00:00Z"),
  };
  const snapshot = () => clone([...agents.values()]);
  return { deps, agents, numbers, rules, calls, snapshot };
}

// ------------------------------------------------------------------ rename

test("rename a normal agent: only agents.name changes", async () => {
  const w = world();
  const before = clone(w.agents.get(SPARE));
  const out = await M.renameAgent(w.deps, { workspaceId: WS, agentId: SPARE, name: "  Front   Desk  " });
  assert.equal(out.httpStatus, 200, JSON.stringify(out.body));
  assert.equal(out.body.name, "Front Desk");
  assert.match(String(out.body.message), /introduce itself using this new name/);
  const after = w.agents.get(SPARE);
  assert.deepEqual({ ...after, name: before.name }, before, "nothing but the name changed");
});

test("rename an imported LiveKit agent keeps its runtime identity (id, console binding, provider ids)", async () => {
  const w = world();
  const before = clone(w.agents.get(LAURA));
  const rulesBefore = clone(w.rules);
  const numbersBefore = clone(w.numbers);
  const out = await M.renameAgent(w.deps, { workspaceId: WS, agentId: LAURA, name: "Laura (Front Desk)" });
  assert.equal(out.httpStatus, 200);
  const after = w.agents.get(LAURA);
  assert.equal(after.id, LAURA);
  assert.equal(after.voice_settings.livekit.agentName, "receptionist-console-fixture");
  assert.deepEqual(after.voice_settings, before.voice_settings);
  assert.equal(after.vapi_assistant_id, before.vapi_assistant_id);
  assert.equal(after.xai_agent_id, before.xai_agent_id);
  assert.deepEqual(w.rules, rulesBefore, "dispatch rules untouched");
  assert.deepEqual(w.numbers, numbersBefore, "phone routing untouched");
});

test("rename rejects empty, whitespace-only, too-long and control-character names", async () => {
  const w = world();
  for (const [name, code] of [["", "name_required"], ["    ", "name_required"], [null, "name_required"], ["x".repeat(81), "name_too_long"], ["bad\u0007name", "name_invalid"]]) {
    const out = await M.renameAgent(w.deps, { workspaceId: WS, agentId: SPARE, name });
    assert.equal(out.httpStatus, 400);
    assert.equal(out.body.code, code);
  }
  assert.equal(w.calls.renames.length, 0);
  assert.equal((await M.renameAgent(w.deps, { workspaceId: WS, agentId: SPARE, name: "x".repeat(80) })).httpStatus, 200);
});

test("rename rejects a name another voice agent already uses (case-insensitive)", async () => {
  const w = world();
  const out = await M.renameAgent(w.deps, { workspaceId: WS, agentId: SPARE, name: "tina" });
  assert.equal(out.httpStatus, 409);
  assert.equal(out.body.code, "name_taken");
});

test("the seeded Nova cannot be renamed — not to a safe name, not to another Nova name", async () => {
  const w = world();
  const before = clone(w.agents.get(NOVA));
  for (const name of ["Sales Closer", "Nova Sales", "Phoenix", "nova"]) {
    const out = await M.renameAgent(w.deps, { workspaceId: WS, agentId: NOVA, name });
    assert.equal(out.httpStatus, 403, name);
    assert.equal(out.body.code, "system_managed_agent", name);
    assert.equal(out.body.error, "Nova is a system-managed agent and cannot be renamed.");
  }
  // Submitting its current name unchanged is a harmless no-op (no write).
  assert.equal((await M.renameAgent(w.deps, { workspaceId: WS, agentId: NOVA, name: "Nova" })).body.unchanged, true);
  assert.deepEqual(w.agents.get(NOVA), before);
  assert.equal(w.calls.renames.length, 0);
});

test("a legacy Phoenix-named agent (also claimed by the Nova seeding) cannot be renamed either", async () => {
  const w = world();
  w.agents.get(SPARE).name = "Phoenix";
  const out = await M.renameAgent(w.deps, { workspaceId: WS, agentId: SPARE, name: "Closer" });
  assert.equal(out.body.code, "system_managed_agent");
  assert.equal(w.agents.get(SPARE).name, "Phoenix");
});

test("another agent cannot be renamed to a Nova or Phoenix name", async () => {
  const w = world();
  for (const name of ["Nova", "nova receptionist", "Casanova", "Phoenix", "Phoenix 2", "the PHOENIX"]) {
    const out = await M.renameAgent(w.deps, { workspaceId: WS, agentId: SPARE, name });
    assert.equal(out.httpStatus, 400, name);
    assert.equal(out.body.code, "name_reserved", name);
  }
  assert.equal(w.calls.renames.length, 0);
  assert.equal(w.agents.get(SPARE).name, "Spare Test Agent");
});

test("rename still works for a normal agent after the Nova rules", async () => {
  const w = world();
  const out = await M.renameAgent(w.deps, { workspaceId: WS, agentId: TINA, name: "Tina Front Desk" });
  assert.equal(out.httpStatus, 200);
  assert.equal(w.agents.get(TINA).name, "Tina Front Desk");
});

test("rename of an agent in another workspace is rejected as not found", async () => {
  const w = world();
  const out = await M.renameAgent(w.deps, { workspaceId: WS, agentId: FOREIGN, name: "Hijacked" });
  assert.equal(out.httpStatus, 404);
  assert.equal(w.agents.get(FOREIGN).name, "Foreign Agent");
});

test("a concurrent rename is not clobbered (compare-and-set on the old name)", async () => {
  const w = world();
  const realGet = w.deps.store.getAgent;
  w.deps.store.getAgent = async (ws, id) => {
    const a = await realGet(ws, id);
    w.agents.get(id).name = "Changed Elsewhere";
    return a;
  };
  const out = await M.renameAgent(w.deps, { workspaceId: WS, agentId: SPARE, name: "Mine" });
  assert.equal(out.body.code, "agent_changed");
  assert.equal(w.agents.get(SPARE).name, "Changed Elsewhere");
});

// ------------------------------------------------------------------ duplicate

test("duplicate a basic agent: new id, Draft, every selected section copied, original unchanged", async () => {
  const w = world();
  const before = w.snapshot();
  const out = await M.duplicateAgent(w.deps, { workspaceId: WS, agentId: TINA, name: "Tina Copy" });
  assert.equal(out.httpStatus, 201, JSON.stringify(out.body));
  const newId = out.body.agentId;
  assert.notEqual(newId, TINA);
  const src = w.agents.get(TINA);
  const dup = w.agents.get(newId);
  assert.equal(dup.status, "Draft");
  assert.equal(dup.workspace_id, WS);
  // Instructions & prompts
  for (const k of ["agent_identity", "instructions", "behavior", "first_message", "first_message_mode"]) assert.deepEqual(dup[k], src[k], k);
  // Voice / model
  for (const k of ["model", "voice", "voice_id", "language"]) assert.deepEqual(dup[k], src[k], k);
  assert.deepEqual(dup.voice_settings.livekit, src.voice_settings.livekit);
  assert.deepEqual(dup.voice_settings.interruptions, src.voice_settings.interruptions);
  assert.equal(dup.voice_settings.maxCallDuration, 30);
  // Tools
  for (const k of ["can_book", "can_reschedule", "can_cancel"]) assert.equal(dup[k], src[k], k);
  assert.deepEqual(dup.voice_settings.tools, src.voice_settings.tools);
  // Knowledge base (text + filenames; no files are physically duplicated)
  assert.equal(dup.knowledge_base, src.knowledge_base);
  assert.deepEqual(dup.kb_files, src.kb_files);
  // Call ending
  assert.deepEqual(dup.voice_settings.callEnding, src.voice_settings.callEnding);
  // Always-safe configuration
  for (const k of ["role", "purpose", "channels"]) assert.deepEqual(dup[k], src[k], k);
  for (const k of ["dataStorage", "recordCalls", "transferNumber", "transferMessage", "extractionFields"]) assert.deepEqual(dup.voice_settings[k], src.voice_settings[k], k);
  // Never copied
  assert.equal(dup.vapi_assistant_id, undefined);
  assert.equal(dup.xai_agent_id, undefined);
  assert.equal(dup.created_at, "2026-09-30T00:00:00Z");
  // Original untouched; nothing else changed.
  assert.deepEqual(w.snapshot().filter((a) => a.id !== newId), before);
});

test("duplicate never copies phone routing or dispatch ownership", async () => {
  const w = world();
  const numbersBefore = clone(w.numbers);
  const rulesBefore = clone(w.rules);
  const out = await M.duplicateAgent(w.deps, { workspaceId: WS, agentId: TINA, name: "Tina Copy" });
  const newId = out.body.agentId;
  assert.deepEqual(w.numbers, numbersBefore);
  assert.deepEqual(w.rules, rulesBefore);
  assert.equal((await w.deps.store.numberReferences(newId)).length, 0, "no number points at the duplicate");
  assert.ok(!JSON.stringify(w.rules).includes(newId), "no dispatch rule names the duplicate");
  // The duplicate is immediately deletable — nothing routes to it.
  const insp = await M.inspectDeletion(w.deps, { workspaceId: WS, agentId: newId });
  assert.deepEqual(insp.blockers, []);
});

test("duplicating an imported console-bound agent drops the binding, Builder identity and self-referencing tools", async () => {
  const w = world();
  const before = clone(w.agents.get(LAURA));
  const out = await M.duplicateAgent(w.deps, { workspaceId: WS, agentId: LAURA, name: "Laura Copy" });
  assert.equal(out.httpStatus, 201);
  const dup = w.agents.get(out.body.agentId);
  assert.equal(dup.voice_settings.livekit.agentName, "", "runs on the Pydent worker, not the source console agent");
  assert.equal(dup.voice_settings.livekit.tts, "cartesia/sonic-3", "models and voice are still copied");
  assert.equal(dup.voice_settings.builderImport, undefined);
  assert.ok(!JSON.stringify(dup).includes("CA_fixture1") && !JSON.stringify(dup).includes("abc123"), "no LiveKit agent id / fingerprint");
  assert.ok(!JSON.stringify(dup).includes(LAURA), "nothing in the duplicate references the source id");
  assert.deepEqual(dup.voice_settings.importedTools.map((t) => t.name), ["end_call"]);
  assert.deepEqual(dup.voice_settings.endCall, before.voice_settings.endCall);
  assert.ok(out.body.excluded.some((e) => /console binding/.test(e)));
  assert.ok(out.body.excluded.some((e) => /builderImport/.test(e)));
  assert.ok(out.body.excluded.some((e) => /imported tool/.test(e)));
  assert.deepEqual(w.agents.get(LAURA), before, "source unchanged");
  const reasons = M.externalBindingReasons(dup, "pydent-agent");
  assert.ok(!reasons.some((r) => /^bound to the LiveKit console agent|^imported from LiveKit Builder$/.test(r)), "the duplicate is not console-bound or Builder-imported");
});

test("unchecked sections are not copied and fall back to defaults", async () => {
  const w = world();
  const out = await M.duplicateAgent(w.deps, {
    workspaceId: WS, agentId: TINA, name: "Blank Tina",
    sections: { instructions: false, voice: false, tools: false, knowledge: false, callEnding: false },
  });
  const dup = w.agents.get(out.body.agentId);
  for (const k of ["agent_identity", "instructions", "behavior", "first_message", "model", "voice", "voice_id", "language", "can_book", "knowledge_base", "kb_files"]) {
    assert.equal(dup[k], undefined, k);
  }
  for (const k of ["livekit", "tools", "importedTools", "callEnding", "endCall", "interruptions", "maxCallDuration"]) assert.equal(dup.voice_settings[k], undefined, k);
  // Always-safe configuration is still copied.
  assert.equal(dup.voice_settings.transferNumber, "+15550100000");
  assert.equal(dup.role, "Receptionist");
});

test("duplicate validates the name: reserved, taken, empty; the default name is never reserved", async () => {
  const w = world();
  assert.equal(M.defaultDuplicateName("Tina"), "Tina Copy");
  assert.equal(M.defaultDuplicateName("Nova"), "", "no 'Nova Copy' default");
  assert.equal(M.defaultDuplicateName("x".repeat(80)), "", "too long for a default");
  assert.equal((await M.duplicateAgent(w.deps, { workspaceId: WS, agentId: NOVA, name: "Nova Copy" })).body.code, "name_reserved");
  assert.equal((await M.duplicateAgent(w.deps, { workspaceId: WS, agentId: NOVA, name: "Nova" })).body.code, "name_reserved");
  for (const name of ["Phoenix", "Phoenix Copy", "Tina Nova", "casanova"]) {
    assert.equal((await M.duplicateAgent(w.deps, { workspaceId: WS, agentId: TINA, name })).body.code, "name_reserved", name);
  }
  assert.equal(M.defaultDuplicateName("Phoenix"), "", "no 'Phoenix Copy' default");
  assert.equal((await M.duplicateAgent(w.deps, { workspaceId: WS, agentId: TINA, name: "Laura" })).body.code, "name_taken");
  assert.equal((await M.duplicateAgent(w.deps, { workspaceId: WS, agentId: TINA, name: " " })).body.code, "name_required");
  assert.equal(w.calls.inserts.length, 0);
  const ok = await M.duplicateAgent(w.deps, { workspaceId: WS, agentId: NOVA, name: "Sales Closer" });
  assert.equal(ok.httpStatus, 201);
});

test("duplicate of an agent in another workspace is rejected", async () => {
  const w = world();
  const out = await M.duplicateAgent(w.deps, { workspaceId: WS, agentId: FOREIGN, name: "Stolen" });
  assert.equal(out.httpStatus, 404);
  assert.equal(w.calls.inserts.length, 0);
});

test("a failed insert reports clearly and leaves everything unchanged", async () => {
  const w = world({ insertError: "permission denied" });
  const before = w.snapshot();
  const out = await M.duplicateAgent(w.deps, { workspaceId: WS, agentId: TINA, name: "Tina Copy" });
  assert.equal(out.body.code, "insert_failed");
  assert.deepEqual(w.snapshot(), before);
});

// ------------------------------------------------------------------ delete

test("an unassigned test agent can be deleted — Pydent row only", async () => {
  const w = world();
  const numbersBefore = clone(w.numbers);
  const rulesBefore = clone(w.rules);
  const check = await M.checkDeletion(w.deps, { workspaceId: WS, agentId: SPARE });
  assert.equal(check.body.deletable, true);
  assert.equal(check.body.requiresTypedConfirmation, false);
  assert.deepEqual(check.body.cascade, { conversationAssignments: 2, followUps: 1 });
  const out = await M.deleteAgent(w.deps, { workspaceId: WS, agentId: SPARE, confirm: true });
  assert.equal(out.httpStatus, 200, JSON.stringify(out.body));
  assert.equal(w.agents.has(SPARE), false);
  assert.deepEqual(w.calls.deletes, [SPARE]);
  assert.deepEqual(w.numbers, numbersBefore);
  assert.deepEqual(w.rules, rulesBefore);
});

test("delete requires explicit confirmation", async () => {
  const w = world();
  const out = await M.deleteAgent(w.deps, { workspaceId: WS, agentId: SPARE });
  assert.equal(out.body.code, "confirmation_required");
  assert.equal(w.agents.has(SPARE), true);
});

test("an agent assigned to a phone number (US shape) cannot be deleted; nothing is reassigned", async () => {
  const w = world();
  const numbersBefore = clone(w.numbers);
  const out = await M.deleteAgent(w.deps, { workspaceId: WS, agentId: TINA, confirm: true });
  assert.equal(out.httpStatus, 409);
  assert.equal(out.body.code, "assigned_to_number");
  assert.match(String(out.body.error), /currently assigned to a phone number/);
  assert.ok(out.body.blockers.some((b) => b.code === "referenced_by_dispatch_rule"), "the US-shaped rule metadata also names Tina");
  assert.equal(w.agents.has(TINA), true);
  assert.deepEqual(w.numbers, numbersBefore);
  assert.equal(w.calls.deletes.length, 0);
});

test("a production/protected provider-routed agent (clinic shape) cannot be deleted, even with the typed name", async () => {
  const w = world();
  const out = await M.deleteAgent(w.deps, { workspaceId: WS, agentId: LAURA, confirm: true, confirmName: "Laura" });
  assert.equal(out.httpStatus, 409);
  assert.equal(out.body.code, "assigned_to_number");
  assert.equal(w.agents.has(LAURA), true);
});

test("a dispatch rule naming the agent blocks delete even when no DB row does", async () => {
  const w = world({ numbers: [] });
  const out = await M.deleteAgent(w.deps, { workspaceId: WS, agentId: TINA, confirm: true });
  assert.equal(out.body.code, "referenced_by_dispatch_rule");
  assert.match(String(out.body.error), /SDR_fixtureUS/);
  assert.equal(w.agents.has(TINA), true);
});

test("LiveKit unavailable → delete is BLOCKED (fail closed) with the exact message", async () => {
  const w = world({ livekitDown: true });
  const out = await M.deleteAgent(w.deps, { workspaceId: WS, agentId: SPARE, confirm: true });
  assert.equal(out.body.code, "livekit_unverifiable");
  assert.equal(out.body.error, "Deletion could not be safely verified because LiveKit routing is currently unavailable. No changes were made.");
  assert.equal(w.agents.has(SPARE), true);
  const w2 = world({ livekitMissing: true });
  assert.equal((await M.deleteAgent(w2.deps, { workspaceId: WS, agentId: SPARE, confirm: true })).body.code, "livekit_unverifiable");
  assert.equal(w2.agents.has(SPARE), true);
});

test("an unfinished reassignment or an active routing lease blocks delete", async () => {
  const w = world({ audits: [{ status: "pending", from_agent_id: TINA, to_agent_id: SPARE }] });
  assert.equal((await M.deleteAgent(w.deps, { workspaceId: WS, agentId: SPARE, confirm: true })).body.code, "assignment_in_progress");
  const w2 = world({ audits: [{ status: "applied", from_agent_id: TINA, to_agent_id: SPARE }] });
  assert.equal((await M.deleteAgent(w2.deps, { workspaceId: WS, agentId: SPARE, confirm: true })).httpStatus, 200, "finished audits do not block");
  const w3 = world({ leases: 1 });
  assert.equal((await M.deleteAgent(w3.deps, { workspaceId: WS, agentId: SPARE, confirm: true })).body.code, "routing_change_in_progress");
});

test("other active configuration (e.g. a channel default) blocks delete", async () => {
  const w = world({ channelDefaults: [SPARE] });
  const out = await M.deleteAgent(w.deps, { workspaceId: WS, agentId: SPARE, confirm: true });
  assert.equal(out.body.code, "used_by_channel_defaults");
  assert.equal(w.agents.has(SPARE), true);
});

test("a console-bound/imported agent that passes the checks needs its name typed", async () => {
  const w = world({ numbers: [], rules: [] });
  const check = await M.checkDeletion(w.deps, { workspaceId: WS, agentId: LAURA });
  assert.equal(check.body.deletable, true);
  assert.equal(check.body.requiresTypedConfirmation, true);
  assert.ok(check.body.typedConfirmationReasons.some((r) => /console agent/.test(r)));
  assert.equal((await M.deleteAgent(w.deps, { workspaceId: WS, agentId: LAURA, confirm: true })).body.code, "typed_confirmation_required");
  assert.equal((await M.deleteAgent(w.deps, { workspaceId: WS, agentId: LAURA, confirm: true, confirmName: "laura" })).body.code, "typed_confirmation_required");
  assert.equal(w.agents.has(LAURA), true);
  assert.equal((await M.deleteAgent(w.deps, { workspaceId: WS, agentId: LAURA, confirm: true, confirmName: "Laura" })).httpStatus, 200);
  assert.equal(w.agents.has(LAURA), false);
});

test("a number assigned while the delete ran → the agent row is restored", async () => {
  const w = world({ raceAssign: true });
  const out = await M.deleteAgent(w.deps, { workspaceId: WS, agentId: SPARE, confirm: true });
  assert.equal(out.body.code, "delete_reverted");
  assert.equal(w.agents.has(SPARE), true);
  assert.deepEqual(w.calls.restores, [SPARE]);
});

test("delete in another workspace is rejected; a number there referencing ours is masked", async () => {
  const w = world({ numbers: [{ workspace_id: OTHER_WS, number: "+15550199999", nickname: "theirs", agent_id: SPARE, routing_agent_id: null, routing_provider: "none" }] });
  assert.equal((await M.deleteAgent(w.deps, { workspaceId: WS, agentId: FOREIGN, confirm: true })).httpStatus, 404);
  assert.equal(w.agents.has(FOREIGN), true);
  const out = await M.deleteAgent(w.deps, { workspaceId: WS, agentId: SPARE, confirm: true });
  assert.equal(out.body.code, "assigned_to_number");
  assert.match(String(out.body.error), /another workspace/);
  assert.ok(!String(out.body.error).includes("+15550199999"), "no cross-workspace number disclosed");
});
