// /api/livekit/agent-config must FAIL CLOSED: a job without a valid
// pydentAgentId is refused — never answered by the workspace's oldest agent.
// Synthetic ids only.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { resolveWorkerAgent } = await import("@/lib/worker-agent-lookup");

const WS = "aaaaaaaa-0000-4000-8000-00000000000a";
const OTHER = "bbbbbbbb-0000-4000-8000-00000000000b";
const TINA = "55555555-5555-4555-8555-555555555555";
const OLDEST = "44444444-4444-4444-8444-444444444444";
const rows = { [TINA]: { id: TINA, workspace_id: WS, name: "Tina" }, [OLDEST]: { id: OLDEST, workspace_id: WS, name: "Oldest" } };

function deps() {
  const calls = [];
  return { calls, getVoiceAgent: async (id) => { calls.push(id); return rows[id] ?? null; } };
}

test("missing / empty / non-uuid pydentAgentId → 400, and no agent is looked up at all", async () => {
  for (const pydentAgentId of [undefined, "", "   ", "not-a-uuid", 42, null]) {
    const d = deps();
    const r = await resolveWorkerAgent(d, { tokenWorkspace: WS, bodyWorkspace: WS, pydentAgentId });
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.deepEqual(d.calls, [], "no fallback lookup");
  }
});

test("workspace required; token workspace wins; mismatches are refused", async () => {
  assert.equal((await resolveWorkerAgent(deps(), { pydentAgentId: TINA })).status, 400);
  assert.equal((await resolveWorkerAgent(deps(), { tokenWorkspace: WS, bodyWorkspace: OTHER, pydentAgentId: TINA })).status, 403);
  assert.equal((await resolveWorkerAgent(deps(), { tokenWorkspace: OTHER, pydentAgentId: TINA })).status, 403);
  assert.equal((await resolveWorkerAgent(deps(), { bodyWorkspace: OTHER, pydentAgentId: TINA })).status, 403);
});

test("unknown agent → 404; the named agent (never another) → ok", async () => {
  assert.equal((await resolveWorkerAgent(deps(), { tokenWorkspace: WS, pydentAgentId: "00000000-0000-4000-8000-000000000000" })).status, 404);
  const ok = await resolveWorkerAgent(deps(), { tokenWorkspace: WS, bodyWorkspace: WS, pydentAgentId: TINA });
  assert.equal(ok.ok, true);
  assert.equal(ok.agent.id, TINA);
  assert.equal(ok.workspaceId, WS);
  const envToken = await resolveWorkerAgent(deps(), { tokenWorkspace: null, bodyWorkspace: WS, pydentAgentId: TINA });
  assert.equal(envToken.ok, true);
});

test("the agent-config route has no oldest-agent fallback any more", () => {
  const s = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src/app/api/livekit/agent-config/route.ts"), "utf8");
  assert.match(s, /resolveWorkerAgent\(/);
  assert.doesNotMatch(s, /order\("created_at"/);
  assert.doesNotMatch(s, /limit\(1\)/);
});
