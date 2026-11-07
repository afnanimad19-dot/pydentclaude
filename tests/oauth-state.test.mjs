// GC-1 — signed OAuth state (lib/oauth-state.ts). Pure crypto, no network.
// Pins the fail-closed contract: no secret ⇒ nothing mints or verifies; any
// tamper, truncation, or expiry ⇒ rejected.

import { test } from "node:test";
import assert from "node:assert/strict";

const { mintOAuthState, verifyOAuthState, newOAuthNonce, oauthStateSecret, OAUTH_STATE_TTL_SEC } =
  await import("@/lib/oauth-state");

const SECRET = "test-secret-0123456789abcdef-long-enough";
const WS = "11111111-1111-1111-1111-111111111111";
const base = { ws: WS, provider: "google_calendar", popup: true, nonce: "n-1" };
const t0 = new Date("2026-11-07T10:00:00Z");

test("round-trip: minted state verifies and carries the exact payload", () => {
  const s = mintOAuthState(base, { secret: SECRET, now: t0 });
  const v = verifyOAuthState(s, { secret: SECRET, now: t0 });
  assert.equal(v.ok, true);
  assert.equal(v.payload.ws, WS);
  assert.equal(v.payload.provider, "google_calendar");
  assert.equal(v.payload.popup, true);
  assert.equal(v.payload.nonce, "n-1");
  assert.equal(v.payload.exp - v.payload.iat, OAUTH_STATE_TTL_SEC);
});

test("fail closed: missing secret mints nothing and verifies nothing", () => {
  assert.equal(oauthStateSecret({}), null);
  assert.equal(oauthStateSecret({ OAUTH_STATE_SECRET: "short" }), null); // too weak = missing
  assert.equal(oauthStateSecret({ OAUTH_STATE_SECRET: SECRET }), SECRET);
  const s = mintOAuthState(base, { secret: SECRET, now: t0 });
  assert.deepEqual(verifyOAuthState(s, { secret: null, now: t0 }), { ok: false, reason: "missing_secret" });
});

test("tampered payload is rejected (signature no longer matches)", () => {
  const s = mintOAuthState(base, { secret: SECRET, now: t0 });
  const [v1, body, sig] = s.split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString());
  payload.ws = "22222222-2222-2222-2222-222222222222"; // attacker retargets the workspace
  const forged = `${v1}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;
  assert.deepEqual(verifyOAuthState(forged, { secret: SECRET, now: t0 }), { ok: false, reason: "bad_signature" });
});

test("wrong secret, truncated and garbage states are rejected without throwing", () => {
  const s = mintOAuthState(base, { secret: SECRET, now: t0 });
  assert.equal(verifyOAuthState(s, { secret: "another-secret-also-long-enough!", now: t0 }).ok, false);
  for (const bad of ["", "v1", "v1.abc", s.slice(0, -4), "v2." + s.slice(3), "not-a-state", null, undefined]) {
    assert.equal(verifyOAuthState(bad, { secret: SECRET, now: t0 }).ok, false);
  }
});

test("expiry is strict: valid just before, rejected at and after exp", () => {
  const s = mintOAuthState(base, { secret: SECRET, now: t0 });
  const justBefore = new Date(t0.getTime() + (OAUTH_STATE_TTL_SEC - 1) * 1000);
  const atExp = new Date(t0.getTime() + OAUTH_STATE_TTL_SEC * 1000);
  assert.equal(verifyOAuthState(s, { secret: SECRET, now: justBefore }).ok, true);
  assert.deepEqual(verifyOAuthState(s, { secret: SECRET, now: atExp }), { ok: false, reason: "expired" });
});

test("a signed payload with an absurd lifetime is rejected even when 'unexpired'", () => {
  // Defence in depth: even a validly signed state cannot claim a multi-day TTL.
  const s = mintOAuthState(base, { secret: SECRET, now: t0, ttlSec: 7 * 24 * 3600 });
  assert.deepEqual(verifyOAuthState(s, { secret: SECRET, now: t0 }), { ok: false, reason: "expired" });
});

test("payload shape is validated: missing ws/nonce/provider rejected", () => {
  for (const payload of [{}, { ws: WS }, { ws: WS, provider: "p" }, { ws: "", provider: "p", nonce: "n", iat: 1, exp: 2 }]) {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = createHmac("sha256", SECRET).update(body).digest("base64url");
    assert.equal(verifyOAuthState(`v1.${body}.${sig}`, { secret: SECRET, now: t0 }).ok, false);
  }
});

test("nonces are unique and non-trivial", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const n = newOAuthNonce();
    assert.ok(n.length >= 16);
    assert.ok(!seen.has(n));
    seen.add(n);
  }
});

import { createHmac } from "node:crypto";
