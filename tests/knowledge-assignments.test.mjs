// Central Knowledge ↔ agent assignment (Phase 1A): the writer for the 0065
// link table agent_knowledge_resources. Requests run through the REAL route
// wrapper + service against an in-memory store that mirrors the 0065
// constraints (PK idempotency, composite workspace FK, the workspace trigger).
// No database, network or AI. Synthetic data only.
//
// Phase 1A invariant: assignment is MANAGEMENT only — no agent runtime reads
// Central Knowledge yet (guarded at the bottom and by the existing knowledge
// suites' runtime-isolation scans).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { withKnowledge } = await import("@/lib/knowledge-route");
const S = await import("@/lib/knowledge-service");

const root = path.resolve(import.meta.dirname, "..");
const src = (p) => fs.readFileSync(path.join(root, p), "utf8");

const WS_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const WS_B = "bbbbbbbb-0000-4000-8000-00000000000b";
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

// ------------------------------------------------------------ in-memory store (0065 assignment semantics)

function makeStore() {
  const db = { resources: [], assignments: [], agents: [] };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const store = {
    async listResources(ws) { return clone(db.resources.filter((r) => r.workspace_id === ws)); },
    async getResource(ws, id) { const r = db.resources.find((x) => x.workspace_id === ws && x.id === id); return r ? clone(r) : null; },
    async insertResource(ws, row) {
      const r = { id: uuid(), workspace_id: ws, next_refresh_at: null, last_refreshed_at: null, last_error: null, content_version: 0, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...row };
      db.resources.push(r);
      return { row: clone(r) };
    },
    async updateResource() { throw new Error("not used here"); },
    async deleteResource(ws, id) {
      const i = db.resources.findIndex((x) => x.workspace_id === ws && x.id === id);
      if (i < 0) return "not_found";
      if (db.assignments.some((a) => a.resource_id === id)) return "assigned"; // NO ACTION FK
      db.resources.splice(i, 1);
      return "deleted";
    },
    async listDocuments() { return []; },
    async listDocumentStats() { return []; },
    async applyDocumentChanges() { throw new Error("not used here"); },
    async duplicateResource() { throw new Error("not used here"); },
    async listAssignments(ws, ids) {
      return db.assignments
        .filter((a) => a.workspace_id === ws && (!ids || ids.includes(a.resource_id)))
        .map((a) => ({ resource_id: a.resource_id, agent_id: a.agent_id, agent_name: db.agents.find((g) => g.id === a.agent_id)?.name ?? "" }));
    },
    async listWorkspaceAgents(ws) {
      return db.agents.filter((a) => a.workspace_id === ws).map((a) => ({ id: a.id, name: a.name, kind: a.kind ?? null }));
    },
    async getWorkspaceAgent(ws, agentId) {
      const a = db.agents.find((x) => x.workspace_id === ws && x.id === agentId);
      return a ? { id: a.id, name: a.name, kind: a.kind ?? null } : null;
    },
    async insertAssignment(ws, agentId, resourceId) {
      // PK (agent_id, resource_id) — idempotent.
      if (db.assignments.some((a) => a.agent_id === agentId && a.resource_id === resourceId)) return "exists";
      // Composite FK (workspace_id, resource_id) → knowledge_resources.
      if (!db.resources.some((r) => r.workspace_id === ws && r.id === resourceId)) return "refused";
      // Trigger agent_knowledge_resources_check_ws: the agent must be in ws.
      if (!db.agents.some((a) => a.workspace_id === ws && a.id === agentId)) return "refused";
      const position = db.assignments.filter((a) => a.agent_id === agentId).length;
      db.assignments.push({ workspace_id: ws, agent_id: agentId, resource_id: resourceId, position });
      return "inserted";
    },
    async deleteAssignment(ws, agentId, resourceId) {
      const i = db.assignments.findIndex((a) => a.workspace_id === ws && a.agent_id === agentId && a.resource_id === resourceId);
      if (i < 0) return "not_found";
      db.assignments.splice(i, 1);
      return "deleted";
    },
  };
  return { store, db };
}

// ------------------------------------------------------------ harness (same shape as knowledge-api.test.mjs)

const ROLES = { owner: "owner", manager: "manager", doctor: "doctor", agent: "agent" };
function world() {
  const s = makeStore();
  const deps = (who = "owner", ws = WS_A) => ({
    authorize: async () => {
      if (who === "anon") return { ok: false, status: 401, error: "Sign in first." };
      if (who === "outsider") return { ok: false, status: 403, error: "You are not a member of this workspace." };
      return { ok: true, userId: `user-${who}`, workspaceId: ws, role: ROLES[who], isAdmin: who === "owner" };
    },
    serviceRoleConfigured: () => true,
    store: s.store,
    ingest: () => ({ extract: async () => ({ ok: true, text: "" }), importSite: async () => ({ ok: false, status: 502, error: "no network in tests" }) }),
    now: () => new Date("2026-10-06T12:00:00Z"),
    log: () => {},
  });
  const call = async (p) => {
    const res = await p;
    return { status: res.status, body: await res.json() };
  };
  // The same (mode, operation, service function) pairs as the route files.
  const api = {
    listAgents: (d, id) => call(withKnowledge(d, "read", "agents_list", ({ ws, store }) => S.listResourceAgents(store, ws, id))),
    assign: (d, id, body) => call(withKnowledge(d, "write", "agent_assign", ({ ws, store }) => S.assignAgent(store, ws, id, body))),
    unassign: (d, id, agentId) => call(withKnowledge(d, "write", "agent_unassign", ({ ws, store }) => S.unassignAgent(store, ws, id, agentId))),
    detail: (d, id) => call(withKnowledge(d, "read", "detail", ({ ws, store }) => S.getResourceDetail(store, ws, id))),
    del: (d, id) => call(withKnowledge(d, "write", "delete", ({ ws, store }) => S.deleteResource(store, ws, id))),
  };
  return { ...s, deps, api };
}

async function seed(w) {
  const resA = (await w.store.insertResource(WS_A, { name: "Clinic FAQs", description: "", type: "file", status: "empty", refresh_enabled: false, refresh_interval_hours: null, created_by: "u", updated_by: "u" })).row;
  const resB = (await w.store.insertResource(WS_B, { name: "Other clinic", description: "", type: "file", status: "empty", refresh_enabled: false, refresh_interval_hours: null, created_by: "u", updated_by: "u" })).row;
  const laura = { id: uuid(), workspace_id: WS_A, name: "Laura", kind: "voice" };
  const nova = { id: uuid(), workspace_id: WS_A, name: "Nova", kind: "voice" };
  const stranger = { id: uuid(), workspace_id: WS_B, name: "Stranger", kind: "voice" };
  w.db.agents.push(laura, nova, stranger);
  return { resA, resB, laura, nova, stranger };
}

// ------------------------------------------------------------ happy path

test("authorized member lists assignments; owner assigns, detail reflects it, owner unassigns", async () => {
  const w = world();
  const { resA, laura, nova } = await seed(w);

  // (1) read: any member, empty to start — both agents offered.
  const list0 = await w.api.listAgents(w.deps("doctor"), resA.id);
  assert.equal(list0.status, 200);
  assert.deepEqual(list0.body.assignedAgents, []);
  assert.deepEqual(list0.body.availableAgents.map((a) => a.name).sort(), ["Laura", "Nova"]);

  // (2) assign a same-workspace agent.
  const a1 = await w.api.assign(w.deps("owner"), resA.id, { agentId: laura.id });
  assert.equal(a1.status, 201);
  assert.equal(a1.body.assigned, true);
  assert.equal(a1.body.agent.name, "Laura");
  assert.equal(a1.body.alreadyAssigned, false);

  // "Used by" (detail assignedAgents) reflects the real assignment.
  const detail = await w.api.detail(w.deps("doctor"), resA.id);
  assert.deepEqual(detail.body.assignedAgents.map((a) => a.name), ["Laura"]);
  assert.equal(detail.body.resource.assignedAgentCount, 1);

  // The picker no longer offers Laura.
  const list1 = await w.api.listAgents(w.deps("manager"), resA.id);
  assert.deepEqual(list1.body.assignedAgents.map((a) => a.name), ["Laura"]);
  assert.deepEqual(list1.body.availableAgents.map((a) => a.name), ["Nova"]);

  // (3) unassign.
  const u1 = await w.api.unassign(w.deps("manager"), resA.id, laura.id);
  assert.equal(u1.status, 200);
  assert.equal(u1.body.unassigned, true);
  assert.equal((await w.api.detail(w.deps("owner"), resA.id)).body.resource.assignedAgentCount, 0);
  assert.equal(w.db.assignments.length, 0);
  assert.ok(nova); // (unused in this test beyond the picker)
});

test("duplicate assignment is idempotent: one row, 200 alreadyAssigned", async () => {
  const w = world();
  const { resA, laura } = await seed(w);
  assert.equal((await w.api.assign(w.deps("owner"), resA.id, { agentId: laura.id })).status, 201);
  const again = await w.api.assign(w.deps("owner"), resA.id, { agentId: laura.id });
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyAssigned, true);
  assert.equal(w.db.assignments.length, 1, "no duplicate row");
});

test("position appends per agent (0065 ordering preserved)", async () => {
  const w = world();
  const { resA, laura } = await seed(w);
  const res2 = (await w.store.insertResource(WS_A, { name: "Second", description: "", type: "url", status: "empty", refresh_enabled: false, refresh_interval_hours: null, created_by: "u", updated_by: "u" })).row;
  await w.api.assign(w.deps("owner"), resA.id, { agentId: laura.id });
  await w.api.assign(w.deps("owner"), res2.id, { agentId: laura.id });
  const positions = w.db.assignments.filter((a) => a.agent_id === laura.id).map((a) => a.position);
  assert.deepEqual(positions, [0, 1]);
});

// ------------------------------------------------------------ workspace isolation

test("cross-workspace agent assignment is rejected and writes nothing", async () => {
  const w = world();
  const { resA, stranger } = await seed(w);
  const r = await w.api.assign(w.deps("owner", WS_A), resA.id, { agentId: stranger.id });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, "agent_not_found");
  assert.equal(w.db.assignments.length, 0);
});

test("the database-level backstops refuse what the service lookup would miss", async () => {
  // Even if a service bug passed a foreign agent through, the store (mirroring
  // the 0065 trigger + composite FK) answers "refused" → 409, nothing written.
  const w = world();
  const { resA, stranger } = await seed(w);
  assert.equal(await w.store.insertAssignment(WS_A, stranger.id, resA.id), "refused");
  const direct = await S.assignAgent(
    { ...w.store, getWorkspaceAgent: async () => ({ id: stranger.id, name: "Stranger", kind: "voice" }) },
    WS_A,
    resA.id,
    { agentId: stranger.id }
  );
  assert.equal(direct.status, 409);
  assert.equal(direct.body.code, "assignment_refused");
  assert.equal(w.db.assignments.length, 0);
});

test("cross-workspace resource access is a 404 for list / assign / unassign", async () => {
  const w = world();
  const { resA, resB, laura } = await seed(w);
  // Workspace B's member cannot see or touch A's resource (and vice versa).
  for (const r of [
    await w.api.listAgents(w.deps("owner", WS_B), resA.id),
    await w.api.assign(w.deps("owner", WS_B), resA.id, { agentId: laura.id }),
    await w.api.unassign(w.deps("owner", WS_B), resA.id, laura.id),
    await w.api.assign(w.deps("owner", WS_A), resB.id, { agentId: laura.id }),
  ]) {
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "resource_not_found");
  }
  assert.equal(w.db.assignments.length, 0);
});

test("assignment reads are workspace-scoped: B's picker never contains A's agents or links", async () => {
  const w = world();
  const { resA, resB, laura } = await seed(w);
  await w.api.assign(w.deps("owner", WS_A), resA.id, { agentId: laura.id });
  const b = await w.api.listAgents(w.deps("owner", WS_B), resB.id);
  assert.equal(b.status, 200);
  assert.deepEqual(b.body.assignedAgents, []);
  assert.deepEqual(b.body.availableAgents.map((a) => a.name), ["Stranger"]);
});

test("unassign touches nothing else: another agent's identical link survives", async () => {
  const w = world();
  const { resA, laura, nova } = await seed(w);
  await w.api.assign(w.deps("owner"), resA.id, { agentId: laura.id });
  await w.api.assign(w.deps("owner"), resA.id, { agentId: nova.id });
  await w.api.unassign(w.deps("owner"), resA.id, laura.id);
  assert.deepEqual(w.db.assignments.map((a) => a.agent_id), [nova.id]);
});

// ------------------------------------------------------------ authentication / roles / malformed input

test("anonymous → 401, non-member → 403, read-only roles → 403 forbidden_role; nothing written", async () => {
  const w = world();
  const { resA, laura } = await seed(w);
  for (const who of ["anon", "outsider"]) {
    for (const r of [
      await w.api.listAgents(w.deps(who), resA.id),
      await w.api.assign(w.deps(who), resA.id, { agentId: laura.id }),
      await w.api.unassign(w.deps(who), resA.id, laura.id),
    ]) {
      assert.equal(r.status, who === "anon" ? 401 : 403, who);
      assert.equal(r.body.ok, false);
    }
  }
  for (const who of ["doctor", "agent"]) {
    assert.equal((await w.api.listAgents(w.deps(who), resA.id)).status, 200, `${who} may read`);
    for (const r of [await w.api.assign(w.deps(who), resA.id, { agentId: laura.id }), await w.api.unassign(w.deps(who), resA.id, laura.id)]) {
      assert.equal(r.status, 403, who);
      assert.equal(r.body.code, "forbidden_role");
    }
  }
  assert.equal(w.db.assignments.length, 0);
});

test("malformed or nonexistent ids fail safely", async () => {
  const w = world();
  const { resA } = await seed(w);
  // Agent ids: malformed, nonexistent, empty, missing body, server-owned field.
  for (const [body, code] of [
    [{ agentId: "not-a-uuid" }, "agent_not_found"],
    [{ agentId: uuid() }, "agent_not_found"],
    [{ agentId: "" }, "agent_not_found"],
    [null, "invalid_body"],
    [{ agentId: "x", workspace_id: WS_B }, "field_not_allowed"],
  ]) {
    const r = await w.api.assign(w.deps("owner"), resA.id, body);
    assert.equal(r.body.code, code, JSON.stringify(body));
    assert.ok(r.status === 400 || r.status === 404);
  }
  // Resource ids: malformed and nonexistent.
  for (const rid of ["garbage", uuid()]) {
    assert.equal((await w.api.listAgents(w.deps("owner"), rid)).body.code, "resource_not_found", rid);
    assert.equal((await w.api.assign(w.deps("owner"), rid, { agentId: uuid() })).body.code, "resource_not_found", rid);
  }
  // Unassign: malformed agent id and a link that doesn't exist.
  assert.equal((await w.api.unassign(w.deps("owner"), resA.id, "garbage")).body.code, "assignment_not_found");
  assert.equal((await w.api.unassign(w.deps("owner"), resA.id, uuid())).body.code, "assignment_not_found");
  assert.equal(w.db.assignments.length, 0);
});

// ------------------------------------------------------------ existing behaviour preserved

test("resource delete stays blocked while assigned (0065 NO ACTION) and works after unassign", async () => {
  const w = world();
  const { resA, laura } = await seed(w);
  await w.api.assign(w.deps("owner"), resA.id, { agentId: laura.id });
  const blocked = await w.api.del(w.deps("owner"), resA.id);
  assert.equal(blocked.status, 409);
  await w.api.unassign(w.deps("owner"), resA.id, laura.id);
  assert.equal((await w.api.del(w.deps("owner"), resA.id)).status, 200);
});

test("assignment changes never touch the resource row (no content_version / status / updated_by churn)", async () => {
  const w = world();
  const { resA, laura } = await seed(w);
  const before = JSON.stringify(w.db.resources.find((r) => r.id === resA.id));
  await w.api.assign(w.deps("owner"), resA.id, { agentId: laura.id });
  await w.api.unassign(w.deps("owner"), resA.id, laura.id);
  assert.equal(JSON.stringify(w.db.resources.find((r) => r.id === resA.id)), before);
});

// ------------------------------------------------------------ route wiring + Phase 1A runtime isolation

test("the assignment routes use withKnowledge with the right modes and service calls", () => {
  const list = src("src/app/api/knowledge/resources/[id]/agents/route.ts");
  assert.match(list, /withKnowledge\(knowledgeDeps\(req\), "read", "agents_list"/);
  assert.match(list, /withKnowledge\(knowledgeDeps\(req\), "write", "agent_assign"/);
  assert.ok(list.includes("listResourceAgents(") && list.includes("assignAgent("));
  const del = src("src/app/api/knowledge/resources/[id]/agents/[agentId]/route.ts");
  assert.match(del, /withKnowledge\(knowledgeDeps\(req\), "write", "agent_unassign"/);
  assert.ok(del.includes("unassignAgent("));
  // No route accepts a workspace: the body's only field is the agent id.
  assert.ok(!/bodyWs|body\.ws|workspace_id|workspaceId/.test(list + del), "no workspace from the request");
});

test("PHASE 1A INVARIANT: no agent runtime reads Central Knowledge (assignment is management only)", () => {
  // Same runtime files the knowledge suites guard — re-asserted here so this
  // suite fails on its own if Phase 1B leaks in early.
  for (const f of [
    "src/lib/livekit.ts", "src/app/api/livekit/agent-config/route.ts", "src/lib/agent-tools-core.ts", "src/app/api/agents/tool-exec/route.ts",
    "livekit-agent/agent.py", "src/lib/builder-tools.ts", "src/app/api/vapi/assistants/route.ts", "src/lib/agent-reply.ts", "src/app/api/chat/route.ts",
    "src/app/api/whatsapp/webhook/route.ts", "src/app/api/sms/webhook/route.ts", "src/lib/kb-retrieval.ts",
  ]) {
    assert.doesNotMatch(src(f), /knowledge_resources|knowledge_documents|agent_knowledge_resources|listResourceAgents|assignAgent|unassignAgent/, f);
  }
});
