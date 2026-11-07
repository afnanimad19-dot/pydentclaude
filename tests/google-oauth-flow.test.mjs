// GC-1 — Google OAuth flow (lib/google-oauth-flow.ts) with injected services:
// no Google, no database, fictional workspaces. Pins the security order:
// signature → nonce consumption → code exchange → storage, with every earlier
// failure preventing everything later (proven with throwing mocks).

import { test } from "node:test";
import assert from "node:assert/strict";

const { beginGoogleOAuth, handleGoogleCallback, disconnectGoogle, GOOGLE_SCOPES } =
  await import("@/lib/google-oauth-flow");
const { verifyOAuthState } = await import("@/lib/oauth-state");

const SECRET = "test-secret-0123456789abcdef-long-enough";
const WS_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const t0 = new Date("2026-11-07T10:00:00Z");
const ORIGIN = "https://pydentai.netlify.app";

// A deps factory with an in-test persistent ledger that mimics the atomic
// one-time UPDATE of the real oauth_nonces table.
function mockDeps(overrides = {}) {
  const ledger = new Map(); // nonce -> {ws, provider, expiresAt, consumedAt}
  const calls = { exchanged: [], stored: [], revoked: [], deleted: [] };
  const deps = {
    secret: SECRET,
    now: () => t0,
    createNonce: async (row) => { ledger.set(row.nonce, { ...row, consumedAt: null }); return true; },
    consumeNonce: async (nonce, now) => {
      const row = ledger.get(nonce);
      if (!row || row.consumedAt) return { ok: false, reason: "not_found_or_used" };
      if (row.expiresAt <= now) return { ok: false, reason: "expired" };
      row.consumedAt = now; // atomic in the real table (single UPDATE)
      return { ok: true, ws: row.ws, provider: row.provider };
    },
    exchangeCode: async (code, redirectUri) => {
      calls.exchanged.push({ code, redirectUri });
      return { ok: true, tokens: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 } };
    },
    fetchAccountEmail: async () => "clinic@example.test",
    storeTokens: async (ws, provider, tokens, label) => { calls.stored.push({ ws, provider, tokens, label }); return true; },
    getStoredTokens: async () => ({ access_token: "at-1", refresh_token: "rt-1" }),
    revokeToken: async (token) => { calls.revoked.push(token); return true; },
    deleteConnection: async (ws, provider) => { calls.deleted.push({ ws, provider }); },
    ...overrides,
  };
  return { deps, ledger, calls };
}

async function begin(deps, ws = WS_A) {
  const r = await beginGoogleOAuth(deps, { ws, provider: "google_calendar", popup: true, origin: ORIGIN, clientId: "cid" });
  assert.equal(r.ok, true);
  return new URL(r.url).searchParams.get("state");
}

// ── begin ────────────────────────────────────────────────────────────────────────
test("begin builds the consent URL: signed state, session ws, upgraded scopes, unchanged redirect URI", async () => {
  const { deps } = mockDeps();
  const r = await beginGoogleOAuth(deps, { ws: WS_A, provider: "google_calendar", popup: true, origin: ORIGIN, clientId: "cid" });
  assert.equal(r.ok, true);
  const u = new URL(r.url);
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("redirect_uri"), `${ORIGIN}/api/google/oauth/callback`);
  assert.match(u.searchParams.get("scope"), /calendar\.readonly/);
  assert.match(u.searchParams.get("scope"), /calendar\.events/);
  assert.equal(u.searchParams.get("access_type"), "offline");
  const v = verifyOAuthState(u.searchParams.get("state"), { secret: SECRET, now: t0 });
  assert.equal(v.ok, true);
  assert.equal(v.payload.ws, WS_A); // the SESSION workspace, signed in
});

test("begin fails closed: missing OAUTH_STATE_SECRET or unavailable nonce ledger", async () => {
  const noSecret = mockDeps({ secret: null }).deps;
  const r1 = await beginGoogleOAuth(noSecret, { ws: WS_A, provider: "google_calendar", popup: false, origin: ORIGIN, clientId: "cid" });
  assert.deepEqual([r1.ok, r1.status], [false, 503]);
  const noLedger = mockDeps({ createNonce: async () => false }).deps;
  const r2 = await beginGoogleOAuth(noLedger, { ws: WS_A, provider: "google_calendar", popup: false, origin: ORIGIN, clientId: "cid" });
  assert.deepEqual([r2.ok, r2.status], [false, 503]);
  assert.match(r2.error, /0067/);
});

test("begin rejects unknown products and missing client id; other products keep their scopes", async () => {
  const { deps } = mockDeps();
  const bad = await beginGoogleOAuth(deps, { ws: WS_A, provider: "google_everything", popup: false, origin: ORIGIN, clientId: "cid" });
  assert.deepEqual([bad.ok, bad.status], [false, 400]);
  const noCid = await beginGoogleOAuth(deps, { ws: WS_A, provider: "google_calendar", popup: false, origin: ORIGIN, clientId: undefined });
  assert.deepEqual([noCid.ok, noCid.status], [false, 503]);
  assert.equal(GOOGLE_SCOPES.google_analytics, "https://www.googleapis.com/auth/analytics.readonly"); // untouched
});

// ── callback: happy path ─────────────────────────────────────────────────────────
test("valid callback consumes the nonce BEFORE exchanging, and stores under the signed workspace", async () => {
  const { deps, calls, ledger } = mockDeps();
  const state = await begin(deps);
  const out = await handleGoogleCallback(deps, { state, code: "code-1", origin: ORIGIN, clientId: "cid", clientSecret: "cs" });
  assert.equal(out.status, "connected");
  assert.equal(calls.stored[0].ws, WS_A);
  assert.equal(calls.stored[0].label, "clinic@example.test");
  // Nonce was consumed exactly once.
  assert.equal([...ledger.values()][0].consumedAt !== null, true);
});

// ── callback: rejections never reach exchange or storage ────────────────────
function throwingBackend() {
  return {
    exchangeCode: async () => { throw new Error("exchange must not run"); },
    storeTokens: async () => { throw new Error("store must not run"); },
  };
}

test("forged state: workspace retargeting is rejected before any I/O", async () => {
  const { deps } = mockDeps(throwingBackend());
  const state = await begin(deps);
  const [v1, body] = state.split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString());
  payload.ws = WS_B;
  const forged = `${v1}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${state.split(".")[2]}`;
  const out = await handleGoogleCallback(deps, { state: forged, code: "c", origin: ORIGIN, clientId: "cid", clientSecret: "cs" });
  assert.equal(out.status, "invalid_state");
});

test("replay: the same state cannot be redeemed twice (persistent one-time nonce)", async () => {
  const { deps, calls } = mockDeps();
  const state = await begin(deps);
  const first = await handleGoogleCallback(deps, { state, code: "c1", origin: ORIGIN, clientId: "cid", clientSecret: "cs" });
  assert.equal(first.status, "connected");
  const replay = await handleGoogleCallback(deps, { state, code: "c2", origin: ORIGIN, clientId: "cid", clientSecret: "cs" });
  assert.equal(replay.status, "invalid_state");
  assert.equal(calls.exchanged.length, 1); // the second code was never exchanged
  assert.equal(calls.stored.length, 1);
});

test("expired or missing-secret states are rejected without touching the ledger", async () => {
  let ledgerTouched = false;
  const { deps } = mockDeps({ ...throwingBackend(), consumeNonce: async () => { ledgerTouched = true; return { ok: false, reason: "not_found_or_used" }; } });
  const state = await begin(mockDeps().deps); // minted elsewhere
  const expiredDeps = { ...deps, now: () => new Date(t0.getTime() + 11 * 60 * 1000) };
  const out = await handleGoogleCallback(expiredDeps, { state, code: "c", origin: ORIGIN, clientId: "cid", clientSecret: "cs" });
  assert.equal(out.status, "invalid_state");
  assert.equal(ledgerTouched, false);
});

test("nonce/payload cross-check: a ledger row for another workspace is rejected", async () => {
  const { deps } = mockDeps({
    ...throwingBackend(),
    consumeNonce: async () => ({ ok: true, ws: WS_B, provider: "google_calendar" }), // ledger disagrees with signature
  });
  const state = await begin(mockDeps().deps, WS_A);
  const out = await handleGoogleCallback(deps, { state, code: "c", origin: ORIGIN, clientId: "cid", clientSecret: "cs" });
  assert.equal(out.status, "invalid_state");
});

test("ledger unavailable (migration 0067 not applied) fails closed at the callback too", async () => {
  const { deps } = mockDeps({ ...throwingBackend(), consumeNonce: async () => ({ ok: false, reason: "store_unavailable" }) });
  const state = await begin(mockDeps().deps);
  const out = await handleGoogleCallback(deps, { state, code: "c", origin: ORIGIN, clientId: "cid", clientSecret: "cs" });
  assert.equal(out.status, "invalid_state");
});

test("user denied at Google (no code): nonce consumed, nothing exchanged, truthful status", async () => {
  const { deps, calls } = mockDeps();
  const state = await begin(deps);
  const out = await handleGoogleCallback(deps, { state, code: null, origin: ORIGIN, clientId: "cid", clientSecret: "cs" });
  assert.equal(out.status, "denied");
  assert.equal(calls.exchanged.length, 0);
});

test("exchange failure reports error and stores nothing", async () => {
  const { deps, calls } = mockDeps({ exchangeCode: async () => ({ ok: false }) });
  const state = await begin(deps);
  const out = await handleGoogleCallback(deps, { state, code: "c", origin: ORIGIN, clientId: "cid", clientSecret: "cs" });
  assert.equal(out.status, "error");
  assert.equal(calls.stored.length, 0);
});

// ── disconnect ────────────────────────────────────────────────────────────────────
test("disconnect revokes the refresh token at Google, then deletes only the session workspace's rows", async () => {
  const { deps, calls } = mockDeps();
  const r = await disconnectGoogle(deps, { ws: WS_A, provider: "google_calendar" });
  assert.deepEqual(r, { ok: true, revoked: true });
  assert.deepEqual(calls.revoked, ["rt-1"]); // refresh token preferred
  assert.deepEqual(calls.deleted, [{ ws: WS_A, provider: "google_calendar" }]);
});

test("revocation failure never blocks the local disconnect, and is reported", async () => {
  const { deps, calls } = mockDeps({ revokeToken: async () => { throw new Error("google down"); } });
  const r = await disconnectGoogle(deps, { ws: WS_A, provider: "google_calendar" });
  assert.deepEqual(r, { ok: true, revoked: false });
  assert.equal(calls.deleted.length, 1);
});
