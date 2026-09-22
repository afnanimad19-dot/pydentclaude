// Worker-token resolution ordering: the workspace binding must win over the
// global env token, so a token that is BOTH stored for a workspace and set as
// LIVEKIT_WORKER_TOKEN still resolves to its workspace (the production 403
// unbound_token bug). Pure resolver, mocked lookups, fictional values only.

import { test } from "node:test";
import assert from "node:assert/strict";

const { resolveWorkerTokenOrdered } = await import("@/lib/worker-token");
const { handleBuilderToolRequest } = await import("@/lib/builder-tools");

const WS = "ws-lhdm-test";
const TOKEN = "pyw_fictional_workspace_token";

// Mimics livekit_config.worker_token rows.
const lookupWorkspace = async (t) => (t === TOKEN ? WS : t === "pyw_other_ws_token" ? "ws-OTHER" : null);

test("workspace token resolves to its workspace", async () => {
  const r = await resolveWorkerTokenOrdered(TOKEN, { envToken: "", lookupWorkspace });
  assert.deepEqual(r, { ok: true, ws: WS });
});

test("identical global env + workspace token resolves to the WORKSPACE (no shadowing)", async () => {
  // The production bug: the same value in LIVEKIT_WORKER_TOKEN must not
  // shadow the workspace binding.
  const r = await resolveWorkerTokenOrdered(TOKEN, { envToken: TOKEN, lookupWorkspace });
  assert.deepEqual(r, { ok: true, ws: WS });
});

test("env-only token (owned by no workspace) still resolves globally — worker compatibility", async () => {
  const r = await resolveWorkerTokenOrdered("pyw_env_only", { envToken: "pyw_env_only", lookupWorkspace });
  assert.deepEqual(r, { ok: true });
});

test("invalid and missing tokens are rejected with the existing messages", async () => {
  const bad = await resolveWorkerTokenOrdered("pyw_wrong", { envToken: TOKEN, lookupWorkspace });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Unauthorized worker/);
  const missing = await resolveWorkerTokenOrdered("", { envToken: TOKEN, lookupWorkspace });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "Missing worker token.");
});

test("a throwing workspace lookup falls back to the env token (worker keeps working)", async () => {
  const boom = async () => { throw new Error("db down"); };
  const viaEnv = await resolveWorkerTokenOrdered(TOKEN, { envToken: TOKEN, lookupWorkspace: boom });
  assert.deepEqual(viaEnv, { ok: true }); // unbound — the Builder adapter then fails closed
  const rejected = await resolveWorkerTokenOrdered("pyw_wrong", { envToken: TOKEN, lookupWorkspace: boom });
  assert.equal(rejected.ok, false);
});

// ── End-to-end through the Builder adapter, using the REAL ordering ─────────
const AGENT = { id: "agent-1", name: "Test Receptionist", workspace_id: WS, voice_settings: {}, can_book: true, can_reschedule: true, can_cancel: true, knowledge_base: "" };
const OTHER_AGENT = { ...AGENT, id: "agent-2", workspace_id: "ws-SOMEONE-ELSE" };

// Deps wired with the real resolver (env identical to the workspace token,
// as in production) — only the data services are mocked.
const deps = {
  resolveToken: (t) => resolveWorkerTokenOrdered(t, { envToken: TOKEN, lookupWorkspace }),
  getSlots: async () => ({ success: true, date: "2099-01-10", slots: [], source: "local", spoken: "Fully booked." }),
  book: async () => { throw new Error("must not be called"); },
  findPatientId: async () => null,
  getPatient: async () => null,
  listUpcoming: async () => [],
  findAppointment: async () => ({ ok: false, error: "appointment_not_found" }),
  rescheduleRow: async () => { throw new Error("must not be called"); },
  cancelRow: async () => { throw new Error("must not be called"); },
  lookupPatient: async () => ({ success: true, found: false, patients: [] }),
  createPatient: async () => { throw new Error("must not be called"); },
  searchKnowledge: async () => ({ success: true, found: false, text: "", sources: [] }),
  sendEmail: async () => ({ sent: false, message: "" }),
};

const lookupCall = (authHeader, agent = AGENT) =>
  handleBuilderToolRequest(deps, { authHeader, agent, tool: "lookup_patient", args: { phone: "+15550001111" } });

test("Builder lookup with the correct workspace token passes authentication", async () => {
  const r = await lookupCall(`Bearer ${TOKEN}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true); // reached the handler: truthful not-found
  assert.equal(r.body.found, false);
});

test("Builder lookup for an agent of ANOTHER workspace → 403", async () => {
  const r = await lookupCall(`Bearer ${TOKEN}`, OTHER_AGENT);
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, "forbidden_workspace");
});

test("Builder lookup with another workspace's token against the LHDM agent → 403", async () => {
  const r = await lookupCall("Bearer pyw_other_ws_token");
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, "forbidden_workspace");
});

test("Builder lookup with an invalid token → 401", async () => {
  const r = await lookupCall("Bearer pyw_wrong");
  assert.equal(r.status, 401);
  assert.equal(r.body.reason, "unauthorized");
});

test("an env-only unbound token still cannot reach Builder tools (fail closed)", async () => {
  const envOnly = { ...deps, resolveToken: (t) => resolveWorkerTokenOrdered(t, { envToken: "pyw_env_only", lookupWorkspace: async () => null }) };
  const r = await handleBuilderToolRequest(envOnly, { authHeader: "Bearer pyw_env_only", agent: AGENT, tool: "lookup_patient", args: { phone: "+15550001111" } });
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, "unbound_token");
});
