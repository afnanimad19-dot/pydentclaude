// Server-side authorization for the provider-routing routes: the workspace is
// derived from the verified session (never from the request), membership is
// required, and routing mutations need an owner/admin role. Synthetic ids only.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { authorizeWorkspaceRequest, bearerToken, isAdminRole } = await import("@/lib/server-auth");

const WS_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const WS_B = "bbbbbbbb-0000-4000-8000-00000000000b";

function deps({ users = { "tok-admin": "u-admin", "tok-agent": "u-agent", "tok-editor": "u-editor", "tok-outsider": "u-out", "tok-nows": "u-nows" } } = {}) {
  const active = { "u-admin": WS_A, "u-agent": WS_A, "u-editor": WS_A, "u-out": WS_B, "u-nows": null };
  const roles = { [`u-admin|${WS_A}`]: "owner", [`u-agent|${WS_A}`]: "agent", [`u-editor|${WS_A}`]: "editor" };
  return {
    getUserId: async (t) => users[t] ?? null,
    getActiveWorkspace: async (u) => active[u] ?? null,
    getMembershipRole: async (u, ws) => roles[`${u}|${ws}`] ?? null,
  };
}

test("unauthenticated: no token or an invalid token → 401", async () => {
  assert.deepEqual(await authorizeWorkspaceRequest(deps(), null), { ok: false, status: 401, error: "Sign in first." });
  const r = await authorizeWorkspaceRequest(deps(), "tok-forged");
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  const throws = await authorizeWorkspaceRequest({ ...deps(), getUserId: async () => { throw new Error("network"); } }, "tok-admin");
  assert.equal(throws.status, 401);
});

test("workspace comes from the session; a user outside the workspace is not a member", async () => {
  const ok = await authorizeWorkspaceRequest(deps(), "tok-admin");
  assert.equal(ok.ok, true);
  assert.equal(ok.workspaceId, WS_A);
  const outsider = await authorizeWorkspaceRequest(deps(), "tok-outsider");
  assert.equal(outsider.ok, false);
  assert.equal(outsider.status, 403);
  const noWs = await authorizeWorkspaceRequest(deps(), "tok-nows");
  assert.equal(noWs.status, 403);
});

test("non-admin members can read but not mutate routing", async () => {
  for (const tok of ["tok-agent", "tok-editor"]) {
    const read = await authorizeWorkspaceRequest(deps(), tok);
    assert.equal(read.ok, true);
    assert.equal(read.isAdmin, false);
    const write = await authorizeWorkspaceRequest(deps(), tok, { requireAdmin: true });
    assert.equal(write.ok, false);
    assert.equal(write.status, 403);
  }
  const admin = await authorizeWorkspaceRequest(deps(), "tok-admin", { requireAdmin: true });
  assert.equal(admin.ok, true);
  assert.equal(isAdminRole("owner"), true);
  assert.equal(isAdminRole("admin"), true);
  assert.equal(isAdminRole("agent"), false);
});

test("bearer parsing", () => {
  assert.equal(bearerToken("Bearer abc.def"), "abc.def");
  assert.equal(bearerToken("bearer  xyz "), "xyz");
  assert.equal(bearerToken("Basic abc"), null);
  assert.equal(bearerToken(null), null);
});

// ── the affected routes are actually wired to it (static guard) ──────────────
const root = path.resolve(import.meta.dirname, "..");
const src = (p) => fs.readFileSync(path.join(root, p), "utf8");

test("protected provider routes authorize server-side and never trust a browser-supplied ws", () => {
  const routes = {
    "src/app/api/livekit/phone/route.ts": 2, // POST + DELETE
    "src/app/api/vapi/phone-numbers/route.ts": 1,
    "src/app/api/livekit/agents/route.ts": 1,
    "src/app/api/livekit/alignment/route.ts": 1,
  };
  for (const [file, n] of Object.entries(routes)) {
    const s = src(file);
    assert.equal((s.match(/authorizeRequest\(req/g) ?? []).length, n, `${file} authorizes every handler`);
    assert.doesNotMatch(s, /searchParams\.get\("ws"\)/, `${file} ignores ?ws=`);
    assert.doesNotMatch(s, /const \{[^}]*\bws\b[^}]*\} = await req\.json/, `${file} ignores body ws`);
  }
  assert.match(src("src/app/api/livekit/phone/route.ts"), /authorizeRequest\(req, \{ requireAdmin: true \}\)/);
  assert.match(src("src/app/api/vapi/phone-numbers/route.ts"), /authorizeRequest\(req, \{ requireAdmin: true \}\)/);
  assert.doesNotMatch(src("src/app/api/vapi/phone-numbers/route.ts"), /export async function PATCH|slice\(-9\)|findVapiNumberId/);
});

test("the /api/voice-numbers routes: mutations require admin, status requires membership", () => {
  const assign = src("src/app/api/voice-numbers/[id]/assign/route.ts");
  const rollback = src("src/app/api/voice-numbers/[id]/rollback/route.ts");
  const routing = src("src/app/api/voice-numbers/[id]/routing/route.ts");
  assert.match(assign, /withRouting\(req, \{ requireAdmin: true \}/);
  assert.match(rollback, /withRouting\(req, \{ requireAdmin: true \}/);
  assert.match(routing, /GET[\s\S]*withRouting\(req, \{ requireAdmin: false \}/);
  assert.match(routing, /POST[\s\S]*withRouting\(req, \{ requireAdmin: true \}/);
  assert.match(src("src/lib/number-routing-route.ts"), /authorizeRequest\(req, \{ requireAdmin: opts\.requireAdmin \}\)/);
});

test("the browser no longer sends ws to the protected routes", () => {
  const pages = ["src/components/dashboard/agents-shared.tsx", "src/app/dashboard/agents/phone-numbers/page.tsx", "src/lib/voice-binding.ts"];
  for (const p of pages) {
    const s = src(p);
    assert.doesNotMatch(s, /\/api\/livekit\/agents\?ws=/, p);
    assert.doesNotMatch(s, /fetch\("\/api\/(livekit\/phone|vapi\/phone-numbers)"/, `${p} uses authFetch`);
  }
});
