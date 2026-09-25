// LiveKit CloudAgent listing: host derivation (project URL → global agents
// host, as the official Go SDK does) and STRICT response parsing — the
// project host's non-JSON "200 OK" catch-all must surface as an error, never
// as "no agents deployed". Fictional values only.

import { test } from "node:test";
import assert from "node:assert/strict";

const { cloudAgentsHost, parseListAgents } = await import("@/lib/cloud-agents");

// ── Host derivation ──────────────────────────────────────────────────────────
test("project URL is rewritten to the global agents host", () => {
  assert.equal(cloudAgentsHost("wss://fictional-project.livekit.cloud"), "https://agents.livekit.cloud");
  assert.equal(cloudAgentsHost("https://someproj.livekit.cloud/"), "https://agents.livekit.cloud");
  assert.equal(cloudAgentsHost("ws://someproj.livekit.cloud"), "https://agents.livekit.cloud");
});

test("localhost development URLs pass through untouched", () => {
  assert.equal(cloudAgentsHost("ws://localhost:7880"), "http://localhost:7880");
  assert.equal(cloudAgentsHost("http://127.0.0.1:7880"), "http://127.0.0.1:7880");
});

// ── Strict parsing ───────────────────────────────────────────────────────────
const LIST = JSON.stringify({
  agents: [
    {
      agentId: "CA_fictional01",
      agentName: "pydent-agent",
      version: "v3",
      agentDeployments: [{ status: "running" }],
      deployedAt: "2026-01-01T00:00:00Z",
    },
    { agent_id: "CA_fictional02", agent_name: "console-laura", agent_deployments: [] },
  ],
});

test("a valid list parses with both camelCase and snake_case fields", () => {
  const agents = parseListAgents(200, LIST);
  assert.equal(agents.length, 2);
  assert.deepEqual(agents[0], { agentId: "CA_fictional01", agentName: "pydent-agent", version: "v3", status: "running", deployedAt: "2026-01-01T00:00:00Z" });
  assert.equal(agents[1].agentId, "CA_fictional02");
  assert.equal(agents[1].status, "unknown");
});

test("genuinely empty lists are preserved: {\"agents\":[]} and {} (proto3 omits empties)", () => {
  assert.deepEqual(parseListAgents(200, '{"agents":[]}'), []);
  assert.deepEqual(parseListAgents(200, "{}"), []);
});

test("HTTP errors throw with the status and body", () => {
  assert.throws(() => parseListAgents(401, '{"code":"unauthenticated"}'), /ListAgents 401/);
  assert.throws(() => parseListAgents(500, "boom"), /ListAgents 500/);
});

test("the project host's non-JSON catch-all ('OK') throws instead of reading as empty", () => {
  assert.throws(() => parseListAgents(200, "OK"), /non-JSON/);
  assert.throws(() => parseListAgents(200, ""), /non-JSON/);
  assert.throws(() => parseListAgents(200, "<html>login</html>"), /non-JSON/);
});

test("malformed JSON shapes throw", () => {
  assert.throws(() => parseListAgents(200, "[1,2,3]"), /not an object/);
  assert.throws(() => parseListAgents(200, '"just a string"'), /not an object/);
  assert.throws(() => parseListAgents(200, '{"agents": "nope"}'), /not an array/);
});
