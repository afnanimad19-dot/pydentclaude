// SDK-aware dispatch-rule representability + semantic preservation, and the
// full link → reassign → readback → rollback → readback lifecycle against a
// fake LiveKit that behaves like the real server: raw JSON in snake_case with
// zero-value enums spelled by name, numbers as strings, and createdAt /
// updatedAt timestamps (updatedAt changes on EVERY write).
//
// Fixtures mirror the SHAPE of the verified US test rule and the clinic rule;
// every id, number and name is synthetic. No provider or database is contacted.

import { test } from "node:test";
import assert from "node:assert/strict";

const R = await import("@/lib/number-routing");
const S = await import("@/lib/livekit-rule-semantics");
const { SIPDispatchRuleInfo } = await import("livekit-server-sdk");

const WS = "11111111-1111-4111-8111-111111111111";
const TINA = "55555555-5555-4555-8555-555555555555";
const LAURA = "44444444-4444-4444-8444-444444444444";
const NUM = "33333333-3333-4333-8333-333333333333";
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── fixtures (shapes only) ───────────────────────────────────────────────────
const US_SHAPE = {
  sipDispatchRuleId: "SDR_fixtureUS1",
  rule: { dispatchRuleIndividual: { roomPrefix: `p_${WS}_call_` } },
  trunkIds: ["ST_fixtureUS1"],
  name: "pydent-fixture-+15550100001",
  metadata: JSON.stringify({ ws: WS, agentId: TINA }),
  roomConfig: { agents: [{ agentName: "pydent-agent", metadata: JSON.stringify({ pydentAgentId: TINA, ws: WS, agentName: "Tina", instructions: "synthetic stale prompt copy" }) }] },
};
const CLINIC_SHAPE = {
  sipDispatchRuleId: "SDR_fixtureCL1",
  rule: { dispatchRuleIndividual: { roomPrefix: "synthetic-clinic-" } },
  trunkIds: ["ST_fixtureCL1"],
  name: "Synthetic-Clinic-Laura",
  roomConfig: { agents: [{ agentName: "builder-laura-fixture" }] },
};
// Every preserved setting populated with a NON-default value.
function rich(shape) {
  const r = clone(shape);
  Object.assign(r, {
    attributes: { team: "front-desk", region: "test" },
    hidePhoneNumber: true,
    krispEnabled: true,
    mediaEncryption: "SIP_MEDIA_ENCRYPT_ALLOW",
    inboundNumbers: ["+15550109999"],
    metadata: r.metadata ?? JSON.stringify({ note: "rule-level metadata" }),
  });
  r.roomConfig = { ...r.roomConfig, emptyTimeout: 30, maxParticipants: 2, metadata: "room-meta" };
  r.roomConfig.agents = [{ ...r.roomConfig.agents[0], restartPolicy: "JRP_NEVER", attributes: { tier: "gold" }, deployment: "production" }];
  return r;
}

// ── LiveKit-server-style raw rendering ───────────────────────────────────────
const MAP_KEYS = new Set(["attributes", "headers", "headersToAttributes", "attributesToHeaders", "tags"]);
const snake = (k) => k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
function toSnake(v) {
  if (Array.isArray(v)) return v.map(toSnake);
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const [k, val] of Object.entries(v)) out[snake(k)] = MAP_KEYS.has(k) ? val : toSnake(val);
  return out;
}
/** What the server sends: explicit defaults, zero enums by NAME, a number as a string, snake_case. */
function serverRaw(json) {
  const c = clone(json);
  c.hidePhoneNumber ??= false;
  c.krispEnabled ??= false;
  c.mediaEncryption ??= "SIP_MEDIA_ENCRYPT_DISABLE";
  c.inboundNumbers ??= [];
  c.numbers ??= [];
  c.roomPreset ??= "";
  if (c.roomConfig) {
    c.roomConfig.maxParticipants = String(c.roomConfig.maxParticipants ?? 0);
    for (const a of c.roomConfig.agents ?? []) { a.restartPolicy ??= "JRP_ON_FAILURE"; a.deployment ??= ""; }
  }
  return toSnake(c);
}

// ── fake LiveKit (server semantics) ──────────────────────────────────────────
function fakeLivekit(rules, { tamper } = {}) {
  let tick = 0;
  const ts = () => new Date(Date.UTC(2026, 8, 29, 0, 0, tick++)).toISOString();
  const store = new Map();
  for (const r of rules) store.set(r.sipDispatchRuleId, SIPDispatchRuleInfo.fromJson({ ...clone(r), createdAt: ts(), updatedAt: ts() }).toJson());
  const writes = [];
  const extraRaw = {};
  return {
    store, writes, extraRaw,
    adapter: {
      workerAgentName: "pydent-agent",
      workerTokenConfigured: true,
      // The SDK read path: fromJson(ignoreUnknownFields) → toJson.
      async getRule(id) { const j = store.get(id); return j ? SIPDispatchRuleInfo.fromJson(serverRaw(j), { ignoreUnknownFields: true }).toJson() : null; },
      async getRuleRaw(id) { const j = store.get(id); return j ? { ...serverRaw(j), ...(extraRaw[id] ?? {}) } : null; },
      async listRulesForTrunk(trunkId) {
        return [...store.values()].filter((r) => (r.trunkIds ?? []).length === 0 || r.trunkIds.includes(trunkId)).map((r) => SIPDispatchRuleInfo.fromJson(r).toJson());
      },
      async getInboundTrunk(id) { return { id, name: "synthetic trunk", numbers: [] }; },
      async listDeployedAgents() { return [{ agentName: "pydent-agent", status: "Running" }, { agentName: "builder-laura-fixture", status: "Running" }]; },
      async replaceRule(id, rule) {
        writes.push([id, clone(rule)]);
        // Server semantics: the request is parsed as SIPDispatchRuleInfo; createdAt kept, updatedAt bumped.
        let j = SIPDispatchRuleInfo.fromJson(rule).toJson();
        j = { ...j, createdAt: store.get(id).createdAt, updatedAt: ts() };
        if (tamper) j = tamper(clone(j), writes.length) ?? j;
        store.set(id, j);
      },
    },
  };
}

// ── fake database ────────────────────────────────────────────────────────────
function world(ruleFixture, { dbAgentId, tamper, extraRaw } = {}) {
  const agents = [
    { id: TINA, workspace_id: WS, name: "Tina", kind: "voice", status: "Live", vapi_assistant_id: null, voice_settings: { livekit: { agentName: "" }, dataStorage: "no_store", recordCalls: false } },
    { id: LAURA, workspace_id: WS, name: "Laura (builder)", kind: "voice", status: "Live", vapi_assistant_id: null, voice_settings: { livekit: { agentName: "builder-laura-fixture" } } },
  ];
  const trunkId = ruleFixture.trunkIds[0];
  const row = {
    id: NUM, workspace_id: WS, number: "+15550100001", provider: "livekit", agent_id: dbAgentId, vapi_phone_number_id: null,
    routing_provider: "none", livekit_trunk_id: null, livekit_dispatch_rule_id: null, routing_agent_id: null,
    routing_status: "unverified", routing_verified_at: null, routing_error: null, routing_protected: false, assignment_version: 1, assignment_lock_until: null,
  };
  const audits = [];
  const lk = fakeLivekit([ruleFixture], { tamper });
  if (extraRaw) lk.extraRaw[ruleFixture.sipDispatchRuleId] = extraRaw;
  const store = {
    async getNumber(ws, id) { return ws === WS && id === NUM ? clone(row) : null; },
    async getAgent(ws, id) { const a = agents.find((x) => x.id === id && x.workspace_id === ws); return a ? clone(a) : null; },
    async listVoiceAgents() { return agents.map(clone); },
    async updateNumberIfVersion(ws, id, v, patch) { if (id !== NUM || row.assignment_version !== v) return false; Object.assign(row, patch); return true; },
    async findNumberByRule(ruleId) { return row.livekit_dispatch_rule_id === ruleId ? { id: NUM, workspace_id: WS } : null; },
    async findAuditByKey(ws, key) { return clone(audits.find((a) => a.idempotency_key === key) ?? null); },
    async getAudit(ws, id) { return clone(audits.find((a) => a.id === id) ?? null); },
    async listAudits() { return audits.slice().reverse().map(clone); },
    async insertAudit(r) { if (audits.some((a) => a.idempotency_key === r.idempotency_key)) return { conflict: true }; const id = `audit-${audits.length + 1}`; audits.push({ ...clone(r), id }); return { id }; },
    async updateAudit(id, patch) { Object.assign(audits.find((a) => a.id === id), clone(patch)); },
  };
  const deps = { store, livekit: lk.adapter, vapi: null, now: () => new Date(Date.UTC(2026, 8, 29, 12)), externalMetadata: (a, ws) => JSON.stringify({ pydentAgentId: a.id, ws, instructions: "synthetic" }) };
  return { deps, row, audits, lk, ruleId: ruleFixture.sipDispatchRuleId, trunkId };
}

let n = 0;
const key = () => `semantics-key-${++n}-abcdef`;
const link = (w) => R.linkLivekitRoute(w.deps, { workspaceId: WS, actorUserId: "u", numberId: NUM, trunkId: w.trunkId, ruleId: w.ruleId, idempotencyKey: key(), protect: false });
const reassign = (w, to) => R.reassignNumber(w.deps, { workspaceId: WS, actorUserId: "u", numberId: NUM, targetAgentId: to, expectedCurrentAgentId: w.row.agent_id, idempotencyKey: key() });
const rollback = (w, assignmentId) => R.rollbackAssignment(w.deps, { workspaceId: WS, actorUserId: "u", numberId: NUM, assignmentId, idempotencyKey: key() });
const current = async (w) => w.deps.livekit.getRule(w.ruleId);
const AGENT_PATHS = ["roomConfig.agents[0].agentName", "roomConfig.agents[0].metadata", "roomConfig.agents[0].deployment"];

// ── 1. representability ──────────────────────────────────────────────────────
test("representability: every server spelling of KNOWN fields passes the strict SDK parse", () => {
  for (const fixture of [US_SHAPE, CLINIC_SHAPE, rich(US_SHAPE), rich(CLINIC_SHAPE)]) {
    const canonical = SIPDispatchRuleInfo.fromJson({ ...fixture, createdAt: "2026-09-26T13:54:55Z", updatedAt: "2026-09-27T08:00:00Z" }).toJson();
    const raw = serverRaw(canonical);
    // The raw really does carry the spellings that tripped the old check.
    assert.ok("restart_policy" in raw.room_config.agents[0] && "media_encryption" in raw && typeof raw.room_config.max_participants === "string");
    const rep = S.checkRuleRepresentable(raw);
    assert.equal(rep.ok, true, rep.reason);
    // The strict raw view and the SDK read view describe the same rule.
    assert.deepEqual(S.semanticDiff(rep.normalized, SIPDispatchRuleInfo.fromJson(raw, { ignoreUnknownFields: true }).toJson()), []);
  }
  // Zero enums by name normalize to the same rule as omitting them.
  assert.deepEqual(S.semanticDiff({ ...US_SHAPE, mediaEncryption: "SIP_MEDIA_ENCRYPT_DISABLE" }, US_SHAPE), []);
  assert.deepEqual(S.semanticDiff({ ...CLINIC_SHAPE, roomConfig: { agents: [{ agentName: "builder-laura-fixture", restartPolicy: "JRP_ON_FAILURE" }] } }, CLINIC_SHAPE), []);
  // …but a NON-default value is a real difference.
  assert.deepEqual(S.semanticDiff({ ...CLINIC_SHAPE, roomConfig: { agents: [{ agentName: "builder-laura-fixture", restartPolicy: "JRP_NEVER" }] } }, CLINIC_SHAPE), ["roomConfig.agents[0].restartPolicy"]);
});

test("representability: genuinely unknown fields FAIL CLOSED (top level, agent entry, rule oneof)", () => {
  const raw = serverRaw(SIPDispatchRuleInfo.fromJson(US_SHAPE).toJson());
  const top = S.checkRuleRepresentable({ ...raw, future_setting: { enabled: true } });
  assert.equal(top.ok, false);
  assert.equal(top.unknownKey, "future_setting");
  const nested = clone(raw);
  nested.room_config.agents[0].future_agent_option = "x";
  assert.equal(S.checkRuleRepresentable(nested).ok, false);
  assert.equal(S.checkRuleRepresentable(nested).unknownKey, "future_agent_option");
  const inRule = clone(raw);
  inRule.rule.dispatch_rule_individual.future_rule_option = true;
  assert.equal(S.checkRuleRepresentable(inRule).ok, false);
  assert.equal(S.checkRuleRepresentable(null).ok, false);
});

test("timestamps are provider-managed: ignored by comparison and never written back", () => {
  const a = { ...US_SHAPE, createdAt: "2026-09-26T13:54:55Z", updatedAt: "2026-09-26T13:54:55Z" };
  const b = { ...US_SHAPE, createdAt: "2026-09-26T13:54:55Z", updatedAt: "2026-09-29T09:00:00Z" };
  assert.equal(S.sameRuleSemantics(a, b), true);
  assert.equal("updatedAt" in S.stripProviderManaged(b), false);
  assert.equal("createdAt" in R.buildReplacementRule(a, { agentName: "pydent-agent", metadata: "{}" }), false);
});

// ── 2. agent-entry preservation + deployment policy ──────────────────────────
test("replacement preserves restartPolicy, attributes and every rule setting; deployment policy is agent-aware", () => {
  const before = SIPDispatchRuleInfo.fromJson(rich(CLINIC_SHAPE)).toJson();
  // Different agent (builder → worker): deployment dropped, everything else kept.
  const toWorker = R.buildReplacementRule(before, { agentName: "pydent-agent", metadata: R.workerDispatchMetadata(TINA, WS) });
  const e = toWorker.roomConfig.agents[0];
  assert.equal(e.restartPolicy, "JRP_NEVER");
  assert.deepEqual(e.attributes, { tier: "gold" });
  assert.equal(e.deployment, undefined);
  assert.deepEqual(S.semanticDiff(before, toWorker).sort(), AGENT_PATHS.slice().sort());
  assert.deepEqual(R.unexpectedRuleChanges(before, toWorker, R.reassignAllowedPaths(before, toWorker)), []);
  // Same agent name (worker → worker, different Pydent agent): deployment KEPT.
  const workerBefore = SIPDispatchRuleInfo.fromJson(rich(US_SHAPE)).toJson();
  const sameAgent = R.buildReplacementRule(workerBefore, { agentName: "pydent-agent", metadata: R.workerDispatchMetadata(LAURA, WS) });
  assert.equal(sameAgent.roomConfig.agents[0].deployment, "production");
  assert.deepEqual(R.reassignAllowedPaths(workerBefore, sameAgent), ["roomConfig.agents[0].agentName", "roomConfig.agents[0].metadata"]);
  assert.deepEqual(S.semanticDiff(workerBefore, sameAgent), ["roomConfig.agents[0].metadata"]);
});

// ── 3. full lifecycles ───────────────────────────────────────────────────────
async function lifecycle(fixture, { dbAgentId, target, expectFrom }) {
  const w = world(fixture, { dbAgentId });
  const original = await current(w);

  // link — provider read-only
  const linked = await link(w);
  assert.equal(linked.body.ok, true, linked.body.message);
  assert.equal(w.lk.writes.length, 0, "link makes ZERO LiveKit writes");
  assert.equal(w.row.routing_agent_id, expectFrom);

  // reassign — exactly one in-place write, verified despite updatedAt changing
  const out = await reassign(w, target);
  assert.equal(out.body.status, "synced", out.body.message);
  assert.equal(w.lk.writes.length, 1);
  assert.equal(w.lk.writes[0][0], w.ruleId);
  assert.equal("updatedAt" in w.lk.writes[0][1] || "createdAt" in w.lk.writes[0][1], false, "timestamps never written back");
  const afterReassign = await current(w);
  assert.notEqual(afterReassign.updatedAt, original.updatedAt, "the provider bumped updatedAt");
  const changed = S.semanticDiff(original, afterReassign);
  assert.ok(changed.length > 0 && changed.every((p) => AGENT_PATHS.includes(p)), `only the dispatched agent changed, got ${changed}`);
  assert.equal(w.row.agent_id, target);
  assert.equal(w.row.routing_agent_id, target);

  // rollback — restores the original semantically, including preserved/deployment settings
  const rb = await rollback(w, out.body.assignmentId);
  assert.equal(rb.body.status, "synced", rb.body.message);
  assert.equal(w.lk.writes.length, 2);
  const afterRollback = await current(w);
  assert.deepEqual(S.semanticDiff(original, afterRollback), [], "rollback restored every field");
  assert.equal(w.row.agent_id, expectFrom);
  assert.equal(w.row.routing_status, "synced");
  return w;
}

test("lifecycle A — US-test-rule shape (worker/Tina → builder agent → rollback)", async () => {
  await lifecycle(US_SHAPE, { dbAgentId: TINA, target: LAURA, expectFrom: TINA });
  await lifecycle(rich(US_SHAPE), { dbAgentId: TINA, target: LAURA, expectFrom: TINA });
});

test("lifecycle B — clinic-rule shape (builder Laura → worker/Tina → rollback)", async () => {
  await lifecycle(CLINIC_SHAPE, { dbAgentId: LAURA, target: TINA, expectFrom: LAURA });
  const w = await lifecycle(rich(CLINIC_SHAPE), { dbAgentId: LAURA, target: TINA, expectFrom: LAURA });
  // After the Tina write the preserved settings were intact (checked inside), and after rollback
  // the builder entry's deployment + restart policy + attributes are back exactly.
  const e = (await current(w)).roomConfig.agents[0];
  assert.deepEqual([e.agentName, e.deployment, e.restartPolicy, e.attributes], ["builder-laura-fixture", "production", "JRP_NEVER", { tier: "gold" }]);
});

// ── 4. post-write semantic violations ────────────────────────────────────────
test("provider silently changes a preserved field → reassignment fails, rollback verified", async () => {
  const w = world(rich(CLINIC_SHAPE), { dbAgentId: LAURA, tamper: (j, i) => (i === 1 ? { ...j, hidePhoneNumber: false } : j) });
  const original = await current(w);
  assert.equal((await link(w)).body.ok, true);
  const out = await reassign(w, TINA);
  assert.equal(out.body.status, "failed");
  assert.equal(out.body.details.rollbackVerified, true);
  assert.match(out.body.message, /hidePhoneNumber/);
  assert.equal(w.lk.writes.length, 2, "attempt + restore");
  assert.deepEqual(S.semanticDiff(original, await current(w)), []);
  assert.equal(w.row.agent_id, LAURA);
  assert.equal(w.row.routing_status, "failed");
  assert.equal(w.audits.at(-1).status, "rolled_back");
});

test("provider tampers with the rollback too → reconcile_needed, rollback reported unverified", async () => {
  const w = world(rich(CLINIC_SHAPE), { dbAgentId: LAURA, tamper: (j) => ({ ...j, name: "tampered" }) });
  assert.equal((await link(w)).body.ok, true);
  const out = await reassign(w, TINA);
  assert.equal(out.body.status, "reconcile_needed");
  assert.equal(out.body.details.rollbackVerified, false);
  assert.equal(w.row.routing_status, "reconcile_needed");
  assert.equal(w.row.agent_id, LAURA, "never claims the target");
});

// ── 5. link stays read-only and fails closed on unknown fields ───────────────
test("link: unknown provider field → refused, zero LiveKit writes, DB untouched", async () => {
  const w = world(US_SHAPE, { dbAgentId: TINA, extraRaw: { future_setting: { enabled: true } } });
  const before = clone(w.row);
  const out = await link(w);
  assert.equal(out.body.code, "rule_has_unsupported_fields");
  assert.deepEqual(out.body.details.fields, ["future_setting"]);
  assert.equal(w.lk.writes.length, 0);
  assert.deepEqual(w.row, before);
  assert.equal(w.audits.length, 0);
});

test("link: the verified US-rule shape with server-style defaults is now ACCEPTED, still read-only", async () => {
  const w = world(US_SHAPE, { dbAgentId: TINA });
  const out = await link(w);
  assert.equal(out.body.ok, true, out.body.message);
  assert.equal(w.row.routing_provider, "livekit");
  assert.equal(w.row.routing_agent_id, TINA);
  assert.equal(w.lk.writes.length, 0);
});
