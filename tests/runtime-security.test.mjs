// Phase 0 runtime security hardening — regression tests.
//
// Guards the authentication posture of the voice runtime endpoints:
//   * /api/agents/tool-exec requires the worker token BEFORE any data read;
//   * /api/livekit/session requires a signed-in member of the agent's own
//     workspace, and the Pydent worker's join token carries only dispatch ids
//     (no knowledge base / instructions) — only a console-built Builder agent
//     still receives instructions metadata, behind that same authentication;
//   * worker authentication is workspace-pinned: a workspace-bound token only
//     reaches its own agents, and the global env token is refused for any
//     workspace that provisioned its own token.
//
// Pure logic is tested directly (mocked lookups, fictional values only); the
// route wiring is guarded by source scans, the same pattern the knowledge and
// worker-agent-lookup suites use.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { enforceWorkerWorkspacePin } = await import("@/lib/worker-agent-lookup");
const { resolveWorkerTokenOrdered } = await import("@/lib/worker-token");

const root = path.resolve(import.meta.dirname, "..");
const src = (p) => fs.readFileSync(path.join(root, p), "utf8");

const WS_LHDM = "ws-lhdm-test";
const WS_OTHER = "ws-other-clinic";

// ── enforceWorkerWorkspacePin (pure) ─────────────────────────────────────────

const pinned = async (ws) => ws === WS_OTHER; // only the OTHER clinic provisioned a token

test("a workspace-bound token only reaches its own workspace's agents", async () => {
  const deps = { workspaceHasOwnToken: pinned };
  assert.deepEqual(await enforceWorkerWorkspacePin(deps, WS_LHDM, WS_LHDM), { ok: true });
  const refused = await enforceWorkerWorkspacePin(deps, WS_LHDM, WS_OTHER);
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 403);
  // A bound token never consults the lookup — the mismatch alone refuses it.
  const neverCalled = { workspaceHasOwnToken: async () => { throw new Error("must not be called"); } };
  assert.equal((await enforceWorkerWorkspacePin(neverCalled, WS_LHDM, WS_OTHER)).ok, false);
  assert.equal((await enforceWorkerWorkspacePin(neverCalled, WS_LHDM, WS_LHDM)).ok, true);
});

test("the global (unbound) token is refused for a workspace with its own token", async () => {
  const deps = { workspaceHasOwnToken: pinned };
  const refused = await enforceWorkerWorkspacePin(deps, null, WS_OTHER);
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 403);
  assert.match(refused.error, /own worker token/);
});

test("the global token still serves a workspace WITHOUT its own token (env-only deployments keep working)", async () => {
  const deps = { workspaceHasOwnToken: pinned };
  assert.deepEqual(await enforceWorkerWorkspacePin(deps, "", WS_LHDM), { ok: true });
  assert.deepEqual(await enforceWorkerWorkspacePin(deps, undefined, WS_LHDM), { ok: true });
});

test("a throwing token lookup counts as 'no workspace token' (table may not be migrated)", async () => {
  const boom = { workspaceHasOwnToken: async () => { throw new Error("db down"); } };
  assert.deepEqual(await enforceWorkerWorkspacePin(boom, null, WS_LHDM), { ok: true });
});

// ── resolver + pin together (the exact decision the routes make) ─────────────

const TOKEN_LHDM = "pyw_fictional_lhdm_token";
const TOKEN_OTHER = "pyw_fictional_other_token";
const ENV_TOKEN = "pyw_fictional_global_env_token";
const lookupWorkspace = async (t) => (t === TOKEN_LHDM ? WS_LHDM : t === TOKEN_OTHER ? WS_OTHER : null);
const hasOwnToken = async (ws) => ws === WS_LHDM || ws === WS_OTHER; // both provisioned

const decide = async (token, agentWs) => {
  const auth = await resolveWorkerTokenOrdered(token, { envToken: ENV_TOKEN, lookupWorkspace });
  if (!auth.ok) return { status: 401 };
  const pin = await enforceWorkerWorkspacePin({ workspaceHasOwnToken: hasOwnToken }, auth.ws ?? null, agentWs);
  return pin.ok ? { status: 200 } : { status: pin.status };
};

test("end to end: cross-workspace access is refused at every rung", async () => {
  assert.deepEqual(await decide(TOKEN_LHDM, WS_LHDM), { status: 200 }, "own token, own agent");
  assert.deepEqual(await decide(TOKEN_OTHER, WS_LHDM), { status: 403 }, "another clinic's token");
  assert.deepEqual(await decide(ENV_TOKEN, WS_LHDM), { status: 403 }, "global token vs provisioned workspace");
  assert.deepEqual(await decide("pyw_wrong", WS_LHDM), { status: 401 }, "unknown token");
  assert.deepEqual(await decide("", WS_LHDM), { status: 401 }, "missing token");
  // A workspace that never provisioned a token keeps the env fallback.
  const open = await resolveWorkerTokenOrdered(ENV_TOKEN, { envToken: ENV_TOKEN, lookupWorkspace });
  const pin = await enforceWorkerWorkspacePin({ workspaceHasOwnToken: async () => false }, open.ws ?? null, "ws-env-only");
  assert.equal(pin.ok, true);
});

// ── route wiring (source scans) ──────────────────────────────────────────────

test("tool-exec authenticates the worker token BEFORE reading any data", () => {
  const code = src("src/app/api/agents/tool-exec/route.ts");
  const authAt = code.indexOf("resolveWorkerToken(");
  const readAt = code.indexOf('.from("agents")');
  assert.ok(authAt > 0 && readAt > 0 && authAt < readAt, "token check must precede the agents read");
  assert.ok(code.includes("enforceWorkerWorkspacePin("), "workspace pin enforced");
  assert.match(code, /\{\s*agentId,\s*name,\s*args,\s*token\s*\}/, "token comes from the request body");
  assert.ok(code.includes("status: 401"), "unauthenticated calls are refused");
});

test("agent-config enforces the workspace pin (global token cannot read provisioned clinics)", () => {
  const code = src("src/app/api/livekit/agent-config/route.ts");
  assert.ok(code.includes("enforceWorkerWorkspacePin("), "workspace pin enforced");
  assert.ok(code.includes("workspaceHasOwnWorkerToken"), "pin is wired to livekit_config");
});

test("livekit/session authorizes the signed-in session BEFORE reading the agent, and scopes it to the caller's workspace", () => {
  const code = src("src/app/api/livekit/session/route.ts");
  const authAt = code.indexOf("authorizeRequest(");
  const readAt = code.indexOf('.from("agents")');
  assert.ok(authAt > 0 && readAt > 0 && authAt < readAt, "session auth must precede the agents read");
  assert.ok(code.includes("auth.workspaceId"), "agent is checked against the caller's workspace");
  assert.match(code, /!==\s*auth\.workspaceId/, "foreign agents are refused");
});

test("the Pydent worker's join token carries only dispatch ids — never instructions/knowledge", () => {
  const code = src("src/app/api/livekit/session/route.ts");
  // builderMetadata (which embeds the compiled instructions incl. the knowledge
  // base) may only be produced for a console-built Builder agent; the Pydent
  // worker path uses the id-only dispatchMetadata.
  assert.match(code, /bound\.external\s*\?\s*builderMetadata\(/, "instructions metadata only for external Builder agents");
  assert.match(code, /:\s*dispatchMetadata\(/, "worker path uses id-only dispatch metadata");
  const uses = code.match(/builderMetadata\(/g) ?? [];
  assert.equal(uses.length, 1, "no other builderMetadata call in the session route");
});

test("the browser starts test calls through authFetch (bearer session), never bare fetch", () => {
  const code = src("src/lib/livekit-web-call.ts");
  assert.ok(code.includes('authFetch("/api/livekit/session"'), "authFetch carries the session token");
  assert.doesNotMatch(code, /(^|[^a-zA-Z])fetch\("\/api\/livekit\/session"/, "no unauthenticated fetch remains");
});

test("the deployed worker presents its token to tool-exec (same credential as agent-config)", () => {
  const code = src("livekit-agent/agent.py");
  assert.ok(
    code.includes('"/api/agents/tool-exec", {"token": WORKER_TOKEN'),
    "run_tool must send the worker token"
  );
});

test("SIP/telephony dispatch still carries agent metadata (preserved by Phase 0)", () => {
  // The phone route's SIP dispatch rules are stored server-side at LiveKit —
  // they are not exposed in any client token — and must keep working unchanged.
  const phone = src("src/app/api/livekit/phone/route.ts");
  assert.ok(phone.includes("builderMetadata(") || phone.includes("dispatchMetadata("), "phone route still dispatches with metadata");
});
