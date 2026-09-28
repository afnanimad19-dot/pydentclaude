// Guarded phone-number reassignment (lib/number-routing.ts) — exercised end to
// end against in-memory fakes of the database, LiveKit and Vapi. Every id,
// number and name here is SYNTHETIC; no provider or database is contacted.

import { test } from "node:test";
import assert from "node:assert/strict";

const R = await import("@/lib/number-routing");
const { dispatchMetadata } = await import("@/lib/livekit");
const { SIPDispatchRuleInfo } = await import("livekit-server-sdk");

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const NUM = "33333333-3333-4333-8333-333333333333";
const LAURA = "44444444-4444-4444-8444-444444444444";
const TINA = "55555555-5555-4555-8555-555555555555";
const DRAFT = "66666666-6666-4666-8666-666666666666";
const FOREIGN = "77777777-7777-4777-8777-777777777777";
const VNUM = "88888888-8888-4888-8888-888888888888";
const DBNUM = "99999999-9999-4999-8999-999999999999";
const PHONE = "+15550100001"; // synthetic
const clone = (x) => JSON.parse(JSON.stringify(x));

function world(over = {}) {
  const agents = [
    { id: LAURA, workspace_id: WS, name: "Laura", kind: "voice", status: "Live", vapi_assistant_id: "asst_laura", voice_settings: { livekit: { agentName: "builder-laura-test" }, dataStorage: "store_analyze" } },
    { id: TINA, workspace_id: WS, name: "Tina", kind: "voice", status: "Live", vapi_assistant_id: "asst_tina", voice_settings: { livekit: { agentName: "" }, dataStorage: "no_store", recordCalls: false } },
    { id: DRAFT, workspace_id: WS, name: "Draft agent", kind: "voice", status: "Draft", vapi_assistant_id: null, voice_settings: {} },
    { id: FOREIGN, workspace_id: OTHER_WS, name: "Other clinic agent", kind: "voice", status: "Live", vapi_assistant_id: "asst_other", voice_settings: {} },
  ];
  const baseRule = {
    sipDispatchRuleId: "SDR_test1",
    rule: { dispatchRuleIndividual: { roomPrefix: "synthetic-clinic-" } },
    trunkIds: ["ST_test1"],
    name: "Synthetic-Laura",
    attributes: { team: "front-desk" },
    roomConfig: { agents: [{ agentName: "builder-laura-test", deployment: "production" }] },
  };
  const rules = new Map([
    ["SDR_test1", clone(baseRule)],
    ["SDR_other", { sipDispatchRuleId: "SDR_other", rule: { dispatchRuleIndividual: { roomPrefix: "other-" } }, trunkIds: ["ST_other"], name: "Unrelated", roomConfig: { agents: [{ agentName: "someone-else" }] } }],
  ]);
  const trunks = new Map([
    ["ST_test1", { id: "ST_test1", name: "Synthetic-Asterisk", numbers: [] }],
    ["ST_other", { id: "ST_other", name: "Unrelated trunk", numbers: ["+15550199999"] }],
  ]);
  const numbers = new Map([
    [NUM, {
      id: NUM, workspace_id: WS, number: PHONE, provider: "landline", agent_id: LAURA, vapi_phone_number_id: null,
      routing_provider: "livekit", livekit_trunk_id: "ST_test1", livekit_dispatch_rule_id: "SDR_test1", routing_agent_id: LAURA,
      routing_status: "synced", routing_verified_at: null, routing_error: null, routing_protected: true, assignment_version: 3, assignment_lock_until: null,
    }],
    [VNUM, {
      id: VNUM, workspace_id: WS, number: "+15550100002", provider: "twilio", agent_id: LAURA, vapi_phone_number_id: "vapi_pn_1",
      routing_provider: "vapi", livekit_trunk_id: null, livekit_dispatch_rule_id: null, routing_agent_id: LAURA,
      routing_status: "synced", routing_verified_at: null, routing_error: null, routing_protected: false, assignment_version: 0, assignment_lock_until: null,
    }],
    [DBNUM, {
      id: DBNUM, workspace_id: WS, number: "+15550100003", provider: "sip", agent_id: null, vapi_phone_number_id: null,
      routing_provider: "none", livekit_trunk_id: null, livekit_dispatch_rule_id: null, routing_agent_id: null,
      routing_status: "unverified", routing_verified_at: null, routing_error: null, routing_protected: false, assignment_version: 0, assignment_lock_until: null,
    }],
  ]);
  const audits = [];
  const log = [];
  const vapiNumbers = new Map([["vapi_pn_1", "asst_laura"]]);
  const faults = { replace: [], vapiSet: [], rawExtra: null, getRuleThrows: false, ...over.faults };
  const deployed = over.deployed ?? [{ agentName: "pydent-agent", status: "Running" }, { agentName: "builder-laura-test", status: "Running" }];

  const store = {
    async getNumber(ws, id) { const n = numbers.get(id); return n && n.workspace_id === ws ? clone(n) : null; },
    async getAgent(ws, id) { const a = agents.find((x) => x.id === id && x.workspace_id === ws); return a ? clone(a) : null; },
    async listVoiceAgents(ws) { return agents.filter((a) => a.workspace_id === ws && a.kind === "voice").map(clone); },
    async updateNumberIfVersion(ws, id, v, patch) {
      const n = numbers.get(id);
      if (!n || n.workspace_id !== ws || n.assignment_version !== v) return false;
      Object.assign(n, patch);
      log.push(["db.update", id, clone(patch)]);
      return true;
    },
    async findNumberByRule(ruleId) { for (const n of numbers.values()) if (n.livekit_dispatch_rule_id === ruleId) return { id: n.id, workspace_id: n.workspace_id }; return null; },
    async findAuditByKey(ws, key) { return clone(audits.find((a) => a.workspace_id === ws && a.idempotency_key === key) ?? null); },
    async getAudit(ws, id) { return clone(audits.find((a) => a.workspace_id === ws && a.id === id) ?? null); },
    async listAudits(ws, numberId, limit) { return audits.filter((a) => a.workspace_id === ws && a.voice_number_id === numberId).slice().reverse().slice(0, limit).map(clone); },
    async insertAudit(row) {
      if (audits.some((a) => a.workspace_id === row.workspace_id && a.idempotency_key === row.idempotency_key)) return { conflict: true };
      const id = `audit-${audits.length + 1}`;
      audits.push({ ...clone(row), id, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, audits.length)).toISOString() });
      return { id };
    },
    async updateAudit(id, patch) { Object.assign(audits.find((a) => a.id === id), clone(patch)); },
  };
  const livekit = over.livekit === null ? null : {
    workerAgentName: "pydent-agent",
    workerTokenConfigured: over.workerTokenConfigured ?? true,
    async getRule(id) { log.push(["lk.getRule", id]); if (faults.getRuleThrows) throw new Error("synthetic read failure"); return clone(rules.get(id) ?? null); },
    async getRuleRaw(id) { const r = rules.get(id); return r ? { ...clone(r), ...(faults.rawExtra ?? {}) } : null; },
    async listRulesForTrunk(trunkId) {
      log.push(["lk.listRulesForTrunk", trunkId]);
      return [...rules.values()].filter((r) => (r.trunkIds ?? []).length === 0 || r.trunkIds.includes(trunkId)).map(clone);
    },
    async getInboundTrunk(id) { log.push(["lk.getInboundTrunk", id]); return clone(trunks.get(id) ?? null); },
    async listDeployedAgents() { return clone(deployed); },
    async replaceRule(id, rule) {
      log.push(["lk.replaceRule", id, clone(rule)]);
      const f = faults.replace.shift();
      if (f === "throw") throw new Error("synthetic LiveKit 503");
      if (f === "apply-then-throw") { rules.set(id, clone(rule)); throw new Error("synthetic lost response"); }
      if (f === "corrupt") { const c = clone(rule); c.roomConfig.agents[0].metadata = "{}"; rules.set(id, c); return; }
      if (f === "corrupt-throw") { const c = clone(rule); c.roomConfig.agents[0].agentName = "garbage"; rules.set(id, c); throw new Error("synthetic partial write"); }
      rules.set(id, clone(rule));
    },
  };
  const vapi = {
    async getAssistantId(id) { log.push(["vapi.get", id]); return vapiNumbers.get(id) ?? null; },
    async setAssistantId(id, assistantId) {
      log.push(["vapi.set", id, assistantId]);
      if (faults.vapiSet.shift() === "throw") throw new Error("synthetic Vapi 500");
      vapiNumbers.set(id, assistantId);
    },
  };
  let clock = Date.UTC(2026, 8, 28, 10, 0, 0);
  const deps = {
    store, livekit, vapi,
    now: () => new Date(clock),
    externalMetadata: (agent, ws) => JSON.stringify({ pydentAgentId: agent.id, ws, instructions: "synthetic" }),
  };
  return { deps, rules, trunks, numbers, audits, log, vapiNumbers, faults, agents, baseRule, advance: (ms) => { clock += ms; } };
}

let seq = 0;
const key = () => `test-key-${++seq}-abcdef`;
const toTina = (w, extra = {}) => R.reassignNumber(w.deps, {
  workspaceId: WS, actorUserId: "user-1", numberId: NUM, targetAgentId: TINA, expectedCurrentAgentId: LAURA,
  idempotencyKey: key(), confirmNumber: PHONE, ...extra,
});
const writes = (w) => w.log.filter((e) => e[0] === "lk.replaceRule" || e[0] === "vapi.set");

// ── the core scenario ────────────────────────────────────────────────────────

test("Laura → Tina: rule updated IN PLACE, verified, then committed", async () => {
  const w = world();
  const trunkBefore = clone(w.trunks.get("ST_test1"));
  const out = await toTina(w);
  assert.equal(out.httpStatus, 200, out.body.message);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.status, "synced");
  const n = w.numbers.get(NUM);
  assert.equal(n.agent_id, TINA);
  assert.equal(n.routing_agent_id, TINA);
  assert.equal(n.routing_status, "synced");
  assert.equal(n.assignment_lock_until, null);
  assert.equal(n.assignment_version, 5); // lease (+1) and commit (+1)
  // Same rule id, one write, trunk untouched.
  const w1 = writes(w);
  assert.equal(w1.length, 1);
  assert.equal(w1[0][1], "SDR_test1");
  assert.deepEqual(w.trunks.get("ST_test1"), trunkBefore);
  const after = w.rules.get("SDR_test1");
  assert.equal(after.sipDispatchRuleId, "SDR_test1");
  assert.deepEqual(after.trunkIds, ["ST_test1"]);
  assert.equal(after.name, "Synthetic-Laura");
  assert.deepEqual(after.rule, { dispatchRuleIndividual: { roomPrefix: "synthetic-clinic-" } });
  assert.deepEqual(after.attributes, { team: "front-desk" });
  // Only the dispatched agent changed: the Pydent worker, Tina selected by metadata.
  assert.deepEqual(after.roomConfig.agents, [{ agentName: "pydent-agent", metadata: JSON.stringify({ pydentAgentId: TINA, ws: WS, source: "phone" }) }]);
  assert.ok(R.onlyAgentsDiffer(w.baseRule, after));
  const audit = w.audits.at(-1);
  assert.equal(audit.status, "applied");
  assert.deepEqual(audit.provider_before, w.baseRule);
  assert.equal(audit.from_agent_id, LAURA);
  assert.equal(audit.to_agent_id, TINA);
});

test("the dispatch metadata is exactly the worker's existing contract (dispatchMetadata in lib/livekit.ts)", () => {
  assert.equal(R.workerDispatchMetadata(TINA, WS), dispatchMetadata(TINA, WS, { source: "phone" }));
  const meta = JSON.parse(R.workerDispatchMetadata(TINA, WS));
  assert.equal(meta.pydentAgentId, TINA); // agent.py: meta.get("pydentAgentId")
  assert.equal(meta.ws, WS); //               agent.py: meta.get("ws")
});

test("one active receiving agent: exactly one dispatch entry, resolving to Tina only", async () => {
  const w = world();
  await toTina(w);
  const rule = w.rules.get("SDR_test1");
  assert.equal(rule.roomConfig.agents.length, 1);
  const resolved = R.resolveRuleAgent(rule, w.agents.filter((a) => a.workspace_id === WS), WS, "pydent-agent");
  assert.equal(resolved.agentId, TINA);
  const status = await R.getRoutingStatus(w.deps, WS, NUM);
  assert.equal(status.body.providerAgent.agentId, TINA);
  assert.equal(status.body.database.agentId, TINA);
  assert.equal(status.body.drift, false);
});

test("the replacement rule round-trips through the SDK's own SIPDispatchRuleInfo (deployment preserved on restore)", () => {
  const w = world();
  const after = R.buildReplacementRule(w.baseRule, { agentName: "pydent-agent", metadata: R.workerDispatchMetadata(TINA, WS) });
  assert.deepEqual(SIPDispatchRuleInfo.fromJson(after).toJson(), after);
  assert.deepEqual(SIPDispatchRuleInfo.fromJson(w.baseRule).toJson(), w.baseRule);
});

// ── tenancy / validation ─────────────────────────────────────────────────────

test("cross-workspace: another clinic's agent or number is 'not found' and nothing is written", async () => {
  const w = world();
  const a = await toTina(w, { targetAgentId: FOREIGN });
  assert.equal(a.httpStatus, 404);
  const b = await R.reassignNumber(w.deps, { workspaceId: OTHER_WS, actorUserId: "u", numberId: NUM, targetAgentId: FOREIGN, expectedCurrentAgentId: LAURA, idempotencyKey: key(), confirmNumber: PHONE });
  assert.equal(b.httpStatus, 404);
  assert.equal(writes(w).length, 0);
  assert.equal(w.numbers.get(NUM).agent_id, LAURA);
});

test("missing, Draft, undeployed or worker-token-less targets are refused before any write", async () => {
  let w = world();
  assert.equal((await toTina(w, { targetAgentId: "00000000-0000-4000-8000-000000000000" })).httpStatus, 404);
  assert.equal((await toTina(w, { targetAgentId: DRAFT })).body.code, "target_ineligible");
  w = world({ deployed: [{ agentName: "builder-laura-test", status: "Running" }] });
  const undeployed = await toTina(w);
  assert.equal(undeployed.body.code, "target_ineligible");
  assert.match(undeployed.body.message, /not deployed/);
  w = world({ deployed: [{ agentName: "pydent-agent", status: "Sleeping" }, { agentName: "builder-laura-test", status: "Running" }] });
  assert.match((await toTina(w)).body.message, /not Running/);
  w = world({ workerTokenConfigured: false });
  assert.match((await toTina(w)).body.message, /worker token/);
  assert.equal(writes(w).length, 0);
});

test("protected production number requires the typed number", async () => {
  const w = world();
  const out = await toTina(w, { confirmNumber: undefined });
  assert.equal(out.body.code, "confirmation_required");
  assert.equal((await toTina(w, { confirmNumber: "+15550100009" })).body.code, "confirmation_required");
  assert.equal(writes(w).length, 0);
});

test("a provider-routed number can never be left without an agent", async () => {
  const w = world();
  const out = await toTina(w, { targetAgentId: null });
  assert.equal(out.body.code, "unassign_routed_forbidden");
  assert.equal(writes(w).length, 0);
});

// ── failures, rollback, reconcile ────────────────────────────────────────────

test("provider API failure: routing unchanged, DB stays Laura, status failed, audit rolled_back", async () => {
  const w = world({ faults: { replace: ["throw"] } });
  const out = await toTina(w);
  assert.equal(out.httpStatus, 502);
  assert.equal(out.body.status, "failed");
  assert.match(out.body.message, /NOT changed — calls still go to Laura/);
  assert.deepEqual(w.rules.get("SDR_test1"), w.baseRule);
  const n = w.numbers.get(NUM);
  assert.equal(n.agent_id, LAURA);
  assert.equal(n.routing_agent_id, LAURA);
  assert.equal(n.routing_status, "failed");
  assert.equal(n.assignment_lock_until, null);
  assert.equal(w.audits.at(-1).status, "rolled_back");
});

test("readback mismatch: the BEFORE snapshot is restored and verified", async () => {
  const w = world({ faults: { replace: ["corrupt"] } });
  const out = await toTina(w);
  assert.equal(out.body.status, "failed");
  assert.deepEqual(w.rules.get("SDR_test1"), w.baseRule);
  assert.equal(writes(w).length, 2); // the attempt + the restore
  assert.deepEqual(writes(w)[1][2], w.baseRule);
  assert.equal(w.numbers.get(NUM).agent_id, LAURA);
});

test("lost response: the write errored but the readback proves it applied → success", async () => {
  const w = world({ faults: { replace: ["apply-then-throw"] } });
  const out = await toTina(w);
  assert.equal(out.body.status, "synced");
  assert.equal(w.numbers.get(NUM).agent_id, TINA);
});

test("rollback cannot be verified → reconcile_needed, further reassignment blocked, reconcile is read-only", async () => {
  const w = world({ faults: { replace: ["corrupt-throw", "throw"] } });
  const out = await toTina(w);
  assert.equal(out.body.status, "reconcile_needed");
  const n = w.numbers.get(NUM);
  assert.equal(n.routing_status, "reconcile_needed");
  assert.equal(n.agent_id, LAURA); // never claims Tina
  assert.equal(w.audits.at(-1).status, "reconcile_needed");
  const again = await toTina(w, { expectedCurrentAgentId: LAURA });
  assert.equal(again.body.code, "reconcile_needed");
  // Reconcile adopts only a mappable provider agent and never writes to LiveKit.
  const before = writes(w).length;
  const rec = await R.reconcileNumber(w.deps, { workspaceId: WS, actorUserId: "u", numberId: NUM, idempotencyKey: key() });
  assert.equal(rec.body.code, "provider_agent_unknown"); // "garbage" is nobody
  w.rules.set("SDR_test1", clone(w.baseRule)); // an operator restored it in the console
  const rec2 = await R.reconcileNumber(w.deps, { workspaceId: WS, actorUserId: "u", numberId: NUM, idempotencyKey: key() });
  assert.equal(rec2.body.ok, true);
  assert.equal(w.numbers.get(NUM).routing_status, "synced");
  assert.equal(writes(w).length, before);
});

test("an expired in-flight lease is treated as reconcile_needed, never silently retried", async () => {
  const w = world();
  Object.assign(w.numbers.get(NUM), { routing_status: "pending", assignment_lock_until: new Date(Date.UTC(2026, 8, 28, 9, 0)).toISOString() });
  assert.equal((await toTina(w)).body.code, "reconcile_needed");
  Object.assign(w.numbers.get(NUM), { assignment_lock_until: new Date(Date.UTC(2026, 8, 28, 11, 0)).toISOString() });
  assert.equal((await toTina(w)).body.code, "in_progress");
  assert.equal(writes(w).length, 0);
});

test("explicit rollback restores the exact previous rule (deployment + empty metadata) and Laura", async () => {
  const w = world();
  const out = await toTina(w);
  const rb = await R.rollbackAssignment(w.deps, { workspaceId: WS, actorUserId: "u", numberId: NUM, assignmentId: out.body.assignmentId, idempotencyKey: key(), confirmNumber: PHONE });
  assert.equal(rb.body.status, "synced", rb.body.message);
  assert.deepEqual(w.rules.get("SDR_test1"), w.baseRule);
  assert.equal(w.numbers.get(NUM).agent_id, LAURA);
  assert.equal(w.audits.at(-1).action, "rollback");
});

test("rollback refuses when the rule was changed outside Pydent since the assignment", async () => {
  const w = world();
  const out = await toTina(w);
  w.rules.get("SDR_test1").roomConfig.agents[0].metadata = JSON.stringify({ pydentAgentId: TINA, ws: WS, source: "console" });
  const rb = await R.rollbackAssignment(w.deps, { workspaceId: WS, actorUserId: "u", numberId: NUM, assignmentId: out.body.assignmentId, idempotencyKey: key(), confirmNumber: PHONE });
  assert.equal(rb.httpStatus, 409);
  assert.equal(writes(w).length, 1);
});

test("drift: LiveKit already disagrees with the DB → refused before any write", async () => {
  const w = world();
  w.rules.get("SDR_test1").roomConfig.agents = [{ agentName: "pydent-agent", metadata: R.workerDispatchMetadata(TINA, WS) }];
  const out = await toTina(w, { targetAgentId: DRAFT });
  assert.equal(out.body.code, "drift");
  assert.equal(writes(w).length, 0);
});

// ── concurrency / idempotency ────────────────────────────────────────────────

test("concurrent reassignments: exactly one proceeds, one provider write", async () => {
  const w = world();
  const [a, b] = await Promise.all([toTina(w), toTina(w)]);
  const oks = [a, b].filter((x) => x.body.ok);
  assert.equal(oks.length, 1);
  assert.ok([a, b].some((x) => x.httpStatus === 409));
  assert.equal(writes(w).length, 1);
  assert.equal(w.numbers.get(NUM).agent_id, TINA);
});

test("stale expectedCurrentAgentId is rejected (compare-and-set)", async () => {
  const w = world();
  const out = await toTina(w, { expectedCurrentAgentId: TINA });
  assert.equal(out.body.code, "stale_assignment");
  assert.equal(writes(w).length, 0);
});

test("duplicate request (same idempotency key) replays the result; reuse for another change is refused", async () => {
  const w = world();
  const k = key();
  const first = await toTina(w, { idempotencyKey: k });
  const second = await toTina(w, { idempotencyKey: k });
  assert.equal(first.body.ok, true);
  assert.equal(second.body.ok, true);
  assert.equal(second.body.idempotent, true);
  assert.equal(writes(w).length, 1);
  const reused = await toTina(w, { idempotencyKey: k, targetAgentId: DRAFT, expectedCurrentAgentId: TINA });
  assert.equal(reused.body.code, "idempotency_key_reused");
});

test("re-assigning to the agent that already receives the number is a verified no-op", async () => {
  const w = world();
  const out = await toTina(w, { targetAgentId: LAURA });
  assert.equal(out.body.status, "noop");
  assert.equal(writes(w).length, 0);
});

// ── existing calls ───────────────────────────────────────────────────────────

test("existing calls are not redirected: a call's agent is fixed at dispatch; only NEW calls use the new rule", async () => {
  const w = world();
  // Minimal model of LiveKit: a call is dispatched once, when it arrives, from the rule at that moment.
  const dispatchCall = () => clone(w.rules.get("SDR_test1").roomConfig.agents[0]);
  const inProgress = dispatchCall();
  await toTina(w);
  const newCall = dispatchCall();
  assert.equal(inProgress.agentName, "builder-laura-test");
  assert.equal(newCall.agentName, "pydent-agent");
  // Pydent issued no room / participant / dispatch operations — only reads and one rule replace.
  const kinds = new Set(w.log.map((e) => e[0]));
  assert.deepEqual([...kinds].filter((k) => k.startsWith("lk.")).sort(), ["lk.getInboundTrunk", "lk.getRule", "lk.listRulesForTrunk", "lk.replaceRule"]);
});

// ── provider selection ───────────────────────────────────────────────────────

test("Vapi numbers use Vapi only (stored id), LiveKit numbers use LiveKit only", async () => {
  const w = world();
  const v = await R.reassignNumber(w.deps, { workspaceId: WS, actorUserId: "u", numberId: VNUM, targetAgentId: TINA, expectedCurrentAgentId: LAURA, idempotencyKey: key() });
  assert.equal(v.body.status, "synced", v.body.message);
  assert.equal(w.vapiNumbers.get("vapi_pn_1"), "asst_tina");
  assert.equal(w.log.filter((e) => e[0] === "lk.replaceRule").length, 0);
  await toTina(w);
  assert.equal(w.log.filter((e) => e[0] === "vapi.set").length, 1);
  assert.equal(w.log.filter((e) => e[0] === "lk.replaceRule").length, 1);
});

test("Vapi failure restores the previous assistant; a number without a stored Vapi id is refused", async () => {
  const w = world({ faults: { vapiSet: ["throw"] } });
  const out = await R.reassignNumber(w.deps, { workspaceId: WS, actorUserId: "u", numberId: VNUM, targetAgentId: TINA, expectedCurrentAgentId: LAURA, idempotencyKey: key() });
  assert.equal(out.body.status, "failed");
  assert.equal(w.vapiNumbers.get("vapi_pn_1"), "asst_laura");
  w.numbers.get(VNUM).vapi_phone_number_id = null;
  Object.assign(w.numbers.get(VNUM), { routing_status: "synced" });
  const noId = await R.reassignNumber(w.deps, { workspaceId: WS, actorUserId: "u", numberId: VNUM, targetAgentId: TINA, expectedCurrentAgentId: LAURA, idempotencyKey: key() });
  assert.equal(noId.body.code, "vapi_number_not_registered");
});

test("database-only numbers never touch a provider", async () => {
  const w = world();
  const out = await R.reassignNumber(w.deps, { workspaceId: WS, actorUserId: "u", numberId: DBNUM, targetAgentId: TINA, expectedCurrentAgentId: null, idempotencyKey: key() });
  assert.equal(out.body.status, "unverified");
  assert.match(out.body.message, /Pydent only/);
  assert.equal(w.numbers.get(DBNUM).agent_id, TINA);
  assert.equal(writes(w).length, 0);
  assert.equal(w.log.filter((e) => e[0].startsWith("lk.") || e[0].startsWith("vapi.")).length, 0);
});

test("LiveKit numbers are refused (no fallback) when the workspace has no LiveKit credentials", async () => {
  const w = world({ livekit: null });
  assert.equal((await toTina(w)).body.code, "livekit_not_configured");
});

// ── dispatch-rule safety ─────────────────────────────────────────────────────

test("unrelated dispatch rules and trunks are never modified", async () => {
  const w = world();
  const otherRule = clone(w.rules.get("SDR_other"));
  const otherTrunk = clone(w.trunks.get("ST_other"));
  await toTina(w);
  assert.deepEqual(w.rules.get("SDR_other"), otherRule);
  assert.deepEqual(w.trunks.get("ST_other"), otherTrunk);
  assert.deepEqual(writes(w).map((e) => e[1]), ["SDR_test1"]);
});

test("wildcard or overlapping rules on the trunk are refused", async () => {
  let w = world();
  w.rules.set("SDR_wild", { sipDispatchRuleId: "SDR_wild", rule: { dispatchRuleIndividual: { roomPrefix: "x-" } }, name: "Wildcard", roomConfig: { agents: [{ agentName: "x" }] } });
  let out = await toTina(w);
  assert.equal(out.body.code, "overlapping_rule");
  assert.deepEqual(out.body.details.overlapping, ["SDR_wild"]);
  w = world();
  w.rules.set("SDR_dup", { sipDispatchRuleId: "SDR_dup", trunkIds: ["ST_test1"], name: "Duplicate", roomConfig: { agents: [{ agentName: "y" }] } });
  assert.equal((await toTina(w)).body.code, "overlapping_rule");
  w = world();
  w.rules.get("SDR_test1").trunkIds = [];
  assert.equal((await toTina(w)).body.code, "rule_wildcard");
  w = world();
  w.rules.get("SDR_test1").trunkIds = ["ST_test1", "ST_other"];
  assert.equal((await toTina(w)).body.code, "rule_trunk_mismatch");
  w = world();
  w.rules.get("SDR_test1").roomConfig.egress = { room: { roomName: "r" } };
  assert.equal((await toTina(w)).body.code, "rule_has_egress");
  assert.equal(writes(w).length, 0);
});

test("a rule carrying fields the SDK cannot represent is refused (a full replace would erase them)", async () => {
  const w = world({ faults: { rawExtra: { future_setting: { enabled: true } } } });
  const out = await toTina(w);
  assert.equal(out.body.code, "rule_has_unsupported_fields");
  assert.deepEqual(out.body.details.fields, ["futureSetting", "futureSetting.enabled"]);
  assert.equal(writes(w).length, 0);
  // Default-valued / snake_case spellings of KNOWN fields are not false positives.
  assert.deepEqual(R.unsupportedRuleFields({ sip_dispatch_rule_id: "SDR_x", trunk_ids: ["ST_a"], hide_phone_number: false, attributes: { any_key: "v" } }, { sipDispatchRuleId: "SDR_x", trunkIds: ["ST_a"], attributes: { any_key: "v" } }), []);
});

test("a trunk that lists numbers must include this number", async () => {
  const w = world();
  w.trunks.get("ST_test1").numbers = ["+15550188888"];
  assert.equal((await toTina(w)).body.code, "trunk_number_mismatch");
  w.trunks.get("ST_test1").numbers = ["0550100001"];
  assert.equal(R.sameNumber("0550100001", PHONE), true); // national spelling of the same number
});

// ── link existing (read-only on LiveKit) ─────────────────────────────────────

function unlinked(w) {
  Object.assign(w.numbers.get(NUM), { routing_provider: "none", livekit_trunk_id: null, livekit_dispatch_rule_id: null, routing_agent_id: null, routing_status: "unverified", routing_protected: false });
}

test("link existing: verifies trunk + rule, records them, protects the number — zero LiveKit writes", async () => {
  const w = world();
  unlinked(w);
  const out = await R.linkLivekitRoute(w.deps, { workspaceId: WS, actorUserId: "u", numberId: NUM, trunkId: "ST_test1", ruleId: "SDR_test1", idempotencyKey: key() });
  assert.equal(out.body.ok, true, out.body.message);
  const n = w.numbers.get(NUM);
  assert.equal(n.routing_provider, "livekit");
  assert.equal(n.livekit_trunk_id, "ST_test1");
  assert.equal(n.livekit_dispatch_rule_id, "SDR_test1");
  assert.equal(n.routing_agent_id, LAURA);
  assert.equal(n.routing_protected, true);
  assert.equal(writes(w).length, 0);
  assert.deepEqual(w.rules.get("SDR_test1"), w.baseRule);
});

test("link existing refuses mismatches, overlaps, double links and bad ids", async () => {
  let w = world();
  unlinked(w);
  w.numbers.get(NUM).agent_id = TINA;
  assert.equal((await R.linkLivekitRoute(w.deps, { workspaceId: WS, actorUserId: "u", numberId: NUM, trunkId: "ST_test1", ruleId: "SDR_test1", idempotencyKey: key() })).body.code, "db_provider_mismatch");
  w = world();
  unlinked(w);
  w.rules.set("SDR_wild", { sipDispatchRuleId: "SDR_wild", name: "Wildcard", roomConfig: { agents: [{ agentName: "x" }] } });
  assert.equal((await R.linkLivekitRoute(w.deps, { workspaceId: WS, actorUserId: "u", numberId: NUM, trunkId: "ST_test1", ruleId: "SDR_test1", idempotencyKey: key() })).body.code, "overlapping_rule");
  w = world(); // already linked
  assert.equal((await R.linkLivekitRoute(w.deps, { workspaceId: WS, actorUserId: "u", numberId: NUM, trunkId: "ST_test1", ruleId: "SDR_test1", idempotencyKey: key() })).body.code, "already_linked");
  w = world();
  assert.equal((await R.linkLivekitRoute(w.deps, { workspaceId: WS, actorUserId: "u", numberId: DBNUM, trunkId: "ST_test1", ruleId: "SDR_test1", idempotencyKey: key() })).body.code, "rule_already_linked");
  assert.equal((await R.linkLivekitRoute(w.deps, { workspaceId: WS, actorUserId: "u", numberId: DBNUM, trunkId: "bad", ruleId: "SDR_test1", idempotencyKey: key() })).body.code, "bad_request");
  assert.equal(writes(w).length, 0);
});

// ── status endpoint ──────────────────────────────────────────────────────────

test("routing status separates DB, verified routing and live provider agent; eligibility + rollback offered", async () => {
  const w = world();
  const s0 = await R.getRoutingStatus(w.deps, WS, NUM);
  assert.equal(s0.body.providerAgent.agentId, LAURA);
  assert.equal(s0.body.providerAgent.livekitAgentName, "builder-laura-test");
  assert.equal(s0.body.drift, false);
  assert.equal(s0.body.protected, true);
  const draft = s0.body.eligibleTargets.find((e) => e.agentId === DRAFT);
  assert.equal(draft.eligible, false);
  assert.equal(s0.body.eligibleTargets.find((e) => e.agentId === TINA).eligible, true);
  assert.equal(s0.body.rollbackCandidate, null);
  assert.equal(JSON.stringify(s0.body).includes("deployment"), false, "no raw rule JSON in the status payload");
  await toTina(w);
  const s1 = await R.getRoutingStatus(w.deps, WS, NUM);
  assert.equal(s1.body.rollbackCandidate.restoresAgentId, LAURA);
  // Out-of-band change shows as drift.
  w.rules.get("SDR_test1").roomConfig.agents = [{ agentName: "builder-laura-test" }];
  const s2 = await R.getRoutingStatus(w.deps, WS, NUM);
  assert.equal(s2.body.drift, true);
  assert.equal(s2.body.rollbackCandidate, null);
  assert.equal((await R.getRoutingStatus(w.deps, OTHER_WS, NUM)).httpStatus, 404);
});

// ── privacy ──────────────────────────────────────────────────────────────────

test("privacy: Tina stays no_store / recordCalls=false, and no egress is ever introduced", async () => {
  const w = world();
  const tinaBefore = clone(w.agents.find((a) => a.id === TINA));
  await toTina(w);
  assert.deepEqual(w.agents.find((a) => a.id === TINA), tinaBefore);
  assert.equal(w.rules.get("SDR_test1").roomConfig.egress, undefined);
  for (const a of w.audits) assert.equal(JSON.stringify(a).includes("egress"), false);
});
