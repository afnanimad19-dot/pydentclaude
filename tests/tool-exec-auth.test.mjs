// Phase 2A — worker authentication for /api/agents/tool-exec. Pure logic with
// an injected token resolver (no DB, no network, fictional workspaces).
//
// Dual-mode contract under test:
//  * MONITOR mode (default, pre-rollout): tokenless calls pass with a warning,
//    but any PRESENTED credential is fully verified — an invalid token or a
//    cross-workspace token is rejected even here.
//  * STRICT mode (TOOL_EXEC_REQUIRE_AUTH=1, post-rollout): no token → 401
//    before any agent lookup.

import { test } from "node:test";
import assert from "node:assert/strict";

const { authorizeToolExec, extractWorkerToken, toolExecAuthRequired } = await import("@/lib/tool-exec-auth");

const WS_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

// Fictional token table: tok-a is bound to workspace A, tok-env is a valid but
// unbound global env token, everything else is invalid.
const resolveToken = async (token) => {
  if (token === "tok-a") return { ok: true, ws: WS_A };
  if (token === "tok-env") return { ok: true };
  return { ok: false, error: "unknown token" };
};
const monitor = { resolveToken, requireAuth: false };
const strict = { resolveToken, requireAuth: true };

// ── Token extraction ──────────────────────────────────────────────────────────
test("token comes from the body `token` field (worker convention) or a Bearer header", () => {
  assert.equal(extractWorkerToken({ token: " tok-a " }, null), "tok-a");
  assert.equal(extractWorkerToken({}, "Bearer tok-a"), "tok-a");
  assert.equal(extractWorkerToken({ token: "tok-a" }, "Bearer other"), "tok-a"); // body wins
  assert.equal(extractWorkerToken(null, undefined), "");
  assert.equal(extractWorkerToken({ token: 42 }, "Basic abc"), "");
});

// ── Unauthenticated requests ──────────────────────────────────────────────────
test("strict mode rejects a missing token with 401 (before any agent lookup)", async () => {
  const r = await authorizeToolExec(strict, { token: "", agentWorkspace: undefined });
  assert.deepEqual(r, { ok: false, status: 401, error: "Missing worker token." });
});

test("monitor mode lets a tokenless call through, flagged for logging", async () => {
  const r = await authorizeToolExec(monitor, { token: "", agentWorkspace: WS_A });
  assert.equal(r.ok, true);
  assert.equal(r.warn, "unauthenticated");
});

// ── Invalid credentials ────────────────────────────────────────────────────────
test("an invalid token is 401 in BOTH modes — a bad credential is never a free pass", async () => {
  for (const deps of [monitor, strict]) {
    const r = await authorizeToolExec(deps, { token: "tok-wrong", agentWorkspace: WS_A });
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
  }
});

test("a resolver crash reads as invalid credentials, not as access", async () => {
  const r = await authorizeToolExec({ resolveToken: async () => { throw new Error("db down"); }, requireAuth: false }, { token: "tok-a", agentWorkspace: WS_A });
  assert.deepEqual([r.ok, r.status], [false, 401]);
});

// ── Cross-workspace access ────────────────────────────────────────────────────
test("workspace-bound token cannot act on another workspace's agent (both modes)", async () => {
  for (const deps of [monitor, strict]) {
    const r = await authorizeToolExec(deps, { token: "tok-a", agentWorkspace: WS_B });
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  }
});

test("bound token fails closed against an agent with NO workspace", async () => {
  const r = await authorizeToolExec(strict, { token: "tok-a", agentWorkspace: null });
  assert.deepEqual([r.ok, r.status], [false, 403]);
});

test("patient-data paths are unreachable cross-tenant: rejection happens before any tool runs", async () => {
  // The route dispatches tools only after authorizeToolExec returns ok — this
  // pins the contract that a cross-workspace credential never yields ok.
  const r = await authorizeToolExec(strict, { token: "tok-a", agentWorkspace: WS_B });
  assert.equal(r.ok, false);
});

// ── Authorized requests ────────────────────────────────────────────────────────
test("matching workspace-bound token is authorized and carries its workspace", async () => {
  for (const deps of [monitor, strict]) {
    const r = await authorizeToolExec(deps, { token: "tok-a", agentWorkspace: WS_A });
    assert.deepEqual(r, { ok: true, tokenWorkspace: WS_A });
  }
});

test("pre-lookup pass (agentWorkspace undefined) verifies the credential but defers the workspace check", async () => {
  const r = await authorizeToolExec(strict, { token: "tok-a", agentWorkspace: undefined });
  assert.equal(r.ok, true);
  const bad = await authorizeToolExec(strict, { token: "tok-wrong", agentWorkspace: undefined });
  assert.equal(bad.ok, false);
});

test("valid unbound env token authenticates but is flagged (single-clinic fallback)", async () => {
  const r = await authorizeToolExec(strict, { token: "tok-env", agentWorkspace: WS_A });
  assert.equal(r.ok, true);
  assert.equal(r.tokenWorkspace, null);
  assert.equal(r.warn, "unbound_token");
});

// ── Mode flag ──────────────────────────────────────────────────────────────────
test("strict mode is opt-in via TOOL_EXEC_REQUIRE_AUTH=1", () => {
  assert.equal(toolExecAuthRequired({}), false);
  assert.equal(toolExecAuthRequired({ TOOL_EXEC_REQUIRE_AUTH: "" }), false);
  assert.equal(toolExecAuthRequired({ TOOL_EXEC_REQUIRE_AUTH: "0" }), false);
  assert.equal(toolExecAuthRequired({ TOOL_EXEC_REQUIRE_AUTH: "1" }), true);
});
