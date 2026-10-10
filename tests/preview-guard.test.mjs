// Phase 2C — Netlify deploy-preview service-role guard. This file runs in its
// own process (node --test isolation), so it can set CONTEXT BEFORE importing
// the module and exercise the real blocked client. No network: the blocked
// proxy throws before any request could be built. Synthetic env only.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Simulate a Netlify deploy preview before the module under test loads.
process.env.CONTEXT = "deploy-preview";
delete process.env.PREVIEW_ALLOW_SERVICE_ROLE;

const { previewServiceRoleBlocked, supabaseAdmin } = await import("@/lib/supabase-admin");

const root = path.resolve(import.meta.dirname, "..");
const src = (p) => fs.readFileSync(path.join(root, p), "utf8");

test("blocked exactly in preview/branch contexts without the explicit override", () => {
  assert.equal(previewServiceRoleBlocked({ CONTEXT: "deploy-preview" }), true);
  assert.equal(previewServiceRoleBlocked({ CONTEXT: "branch-deploy" }), true);
  assert.equal(previewServiceRoleBlocked({ CONTEXT: "deploy-preview", PREVIEW_ALLOW_SERVICE_ROLE: "on" }), false);
  assert.equal(previewServiceRoleBlocked({ CONTEXT: "deploy-preview", PREVIEW_ALLOW_SERVICE_ROLE: "true" }), true, "only the exact value overrides");
  assert.equal(previewServiceRoleBlocked({ CONTEXT: "production" }), false);
  assert.equal(previewServiceRoleBlocked({ CONTEXT: "dev" }), false);
  assert.equal(previewServiceRoleBlocked({}), false, "local dev / tests have no CONTEXT and are untouched");
});

test("in a preview context the admin client fails CLOSED on first use — import alone is safe", () => {
  // Importing above did not throw (builds only import). Any USE must.
  assert.throws(() => supabaseAdmin.from("patients"), /disabled in Netlify deploy previews/);
  assert.throws(() => supabaseAdmin.rpc("knowledge_match_chunks", {}), /disabled/);
  assert.throws(() => supabaseAdmin.auth, /disabled/);
});

test("the block message names the remedy but never credentials or URLs", () => {
  try {
    supabaseAdmin.from("x");
    assert.fail("should have thrown");
  } catch (e) {
    assert.match(e.message, /PREVIEW_ALLOW_SERVICE_ROLE/);
    assert.ok(!/supabase\.co|key|token|eyJ/i.test(e.message), "no connection details in the error");
  }
});

test("source guard: the guard wraps the ONLY admin-client construction and throws on use, not at import", () => {
  const text = src("src/lib/supabase-admin.ts");
  assert.equal((text.match(/createClient\(/g) ?? []).length, 1, "exactly one client construction, inside the guard");
  assert.match(text, /if \(previewServiceRoleBlocked\(\)\)/);
  assert.match(text, /new Proxy\(/);
  assert.match(text, /Throw on first USE, not at import/);
});
