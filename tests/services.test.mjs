// M1E-A service foundation: input normalization, honest duration semantics,
// workspace-explicit fail-closed helpers, external identity via
// external_mappings only, and the 0067 schema contract pinned against the
// migration file. Deterministic, fictional data — no database, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";

const { normalizeServiceInput, listServices, getService, getBookableService, getServiceExternalId } =
  await import("@/lib/services-server");

const sql = await readFile(new URL("../supabase/migrations/0067_service_foundation.sql", import.meta.url), "utf8");
const await_src = await readFile(new URL("../src/lib/services-server.ts", import.meta.url), "utf8");

// ── 2/6/7. Input normalization and duration honesty ─────────────────────────
test("service input requires a name; flags default on; fields are trimmed", () => {
  assert.equal(normalizeServiceInput({ name: "  " }), null);
  assert.equal(normalizeServiceInput(null), null);
  const s = normalizeServiceInput({ name: " Cleaning ", code: " CLN ", description: " basic " });
  assert.deepEqual(s, { name: "Cleaning", displayName: null, code: "CLN", description: "basic", defaultDurationMin: null, active: true, bookingEnabled: true });
});

test("optional text fields: NULL means not provided, blanks normalize to null", () => {
  // display_name / code / description may all be null…
  const bare = normalizeServiceInput({ name: "X" });
  assert.equal(bare.displayName, null);
  assert.equal(bare.code, null);
  assert.equal(bare.description, null);
  // …and blank/whitespace input becomes null, never an empty string:
  const blanks = normalizeServiceInput({ name: "X", displayName: "   ", code: "", description: " \t " });
  assert.deepEqual([blanks.displayName, blanks.code, blanks.description], [null, null, null]);
  // The schema matches: nullable columns with no fabricated '' default.
  assert.match(sql, /\n  display_name text,\n/);
  assert.match(sql, /\n  code text,\s+--/);
  assert.match(sql, /\n  description text,\n/);
  assert.doesNotMatch(sql, /default ''/);
});

test("no uniqueness is imposed on service name or code", () => {
  // Multiple services may share a customer-facing name (differing duration/
  // config), and code is a non-unique internal label.
  assert.doesNotMatch(sql, /unique/i);
});

test("duration: null when unknown, positive integer when supplied, never fabricated", () => {
  assert.equal(normalizeServiceInput({ name: "X" }).defaultDurationMin, null);                      // unknown stays null
  assert.equal(normalizeServiceInput({ name: "X", defaultDurationMin: 45 }).defaultDurationMin, 45);
  for (const bad of [0, -30, "soon", NaN, 10000]) {
    assert.equal(normalizeServiceInput({ name: "X", defaultDurationMin: bad }), null, `${bad} must reject the input, not become a default`);
  }
  // No 30/60 fabrication anywhere in the module or the migration:
  const src = await_src;
  assert.doesNotMatch(src, /defaultDurationMin.*(=|\?\?)\s*(30|60)/);
  assert.doesNotMatch(sql, /default_duration_min integer (not null )?default/);
});

// ── 1/11/12/13/14. Workspace-explicit, fail-closed helpers ──────────────────
test("every helper requires an explicit workspace and fails closed without one", async () => {
  assert.deepEqual(await listServices(""), []);
  assert.equal(await getService("", "svc-fict-1"), null);
  assert.equal(await getBookableService("", "svc-fict-1"), null);
  assert.equal(await getServiceExternalId("", "conn-fict-1", "svc-fict-1"), null);
  // No first-workspace fallback exists in the module source:
  assert.equal(/firstWorkspace|limit\(1\)/.test(await_src), false);
  // And every query the module makes is workspace-filtered:
  assert.equal((await_src.match(/from\("services"\)/g) ?? []).length, (await_src.match(/eq\("workspace_id", workspaceId\)/g) ?? []).length);
});

// ── 15. Bookable gate ───────────────────────────────────────────────────────
test("getBookableService rejects inactive and non-bookable services", async () => {
  // Pure-logic check via the exported gate semantics: the function returns
  // null unless active AND bookingEnabled — proven against its source
  // (DB-independent), plus the live behavior for the fail-closed path above.
  assert.match(await_src, /if \(!s \|\| !s\.active \|\| !s\.bookingEnabled\) return null;/);
});

// ── 8/9/10. PMS-neutral schema; code is internal; mappings carry identity ───
test("0067 schema: workspace-scoped, required name, true defaults, no PMS identity columns", () => {
  assert.match(sql, /workspace_id uuid not null default current_workspace\(\) references public\.workspaces\(id\) on delete cascade/);
  assert.match(sql, /name text not null/);
  assert.match(sql, /active boolean not null default true/);
  assert.match(sql, /booking_enabled boolean not null default true/);
  assert.match(sql, /default_duration_min integer check \(default_duration_min is null or default_duration_min > 0\)/);
  assert.match(sql, /create policy "workspace isolation" on public\.services/);
  for (const forbidden of ["opendental", "d4w_", "apt_num", "proc_num", "procnum", "codenum", "code_num", "external_service_id", "opendental_service_id"]) {
    assert.equal(sql.toLowerCase().includes(forbidden), false, `0067 must not contain "${forbidden}"`);
  }
  // `code` is documented as Pydent-internal, never an external identity:
  assert.match(sql, /code text,\s+-- Pydent-internal label ONLY — never an external PMS identity/);
});

test("external service identity resolves through external_mappings (entity_type 'service'), never through code", async () => {
  const calls = [];
  const deps = {
    getMapping: async (ws, connId, entityType, pydentId) => {
      calls.push({ ws, connId, entityType, pydentId });
      return pydentId === "svc-fict-mapped"
        ? { externalId: "D1110-ext", entityType, pydentEntityId: pydentId }
        : null;
    },
  };
  assert.equal(await getServiceExternalId("ws-fict-A", "conn-fict-1", "svc-fict-mapped", deps), "D1110-ext");
  assert.deepEqual(calls[0], { ws: "ws-fict-A", connId: "conn-fict-1", entityType: "service", pydentId: "svc-fict-mapped" });
  // Unmapped → null (fail closed), even though such a service could carry an
  // internal code — the code is never consulted as a substitute identity:
  assert.equal(await getServiceExternalId("ws-fict-A", "conn-fict-1", "svc-fict-with-code-but-unmapped", deps), null);
  assert.equal(await_src.includes("s.code") || /code[^\n]*external/i.test(await_src.replace(/\/\/[^\n]*/g, "")), false, "code must never feed external identity");
});

// ── 16/17/18/19. Nothing else changed ───────────────────────────────────────
test("no public services API route exists", async () => {
  await assert.rejects(access(new URL("../src/app/api/services", import.meta.url).pathname), /ENOENT/);
});

test("no production code imports services-server yet; M1D-B create remains locked", async () => {
  // The booking-connectors layer is the SANCTIONED consumer (M1E-B service
  // resolution) and is itself policed by its own import-scan; every other
  // file under src/ is a production caller and must not touch the module.
  const offenders = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name === "node_modules" || p.includes("booking-connectors")) continue; await walk(p); }
      else if (/\.(ts|tsx)$/.test(e.name) && !p.endsWith("services-server.ts")) {
        if ((await readFile(p, "utf8")).includes("services-server")) offenders.push(p);
      }
    }
  }
  await walk(new URL("../src", import.meta.url).pathname);
  assert.deepEqual(offenders, [], "no production file may import services-server");
  // appointments.procedure untouched: the module never references the
  // appointments table at all.
  assert.equal(await_src.includes("appointments"), false);
  // The fail-closed create is NOT unlocked: the orchestration service still
  // returns config_missing. (Since M1E-B it DOES import services-server —
  // that import is the sanctioned service-resolution path, covered in
  // tests/booking-connector-service.test.mjs.)
  const orchestration = await readFile(new URL("../src/lib/booking-connectors/service.ts", import.meta.url), "utf8");
  assert.match(orchestration, /connectorFail\("config_missing", CREATE_UNAVAILABLE_REASON\)/);
  assert.match(orchestration, /from "@\/lib\/services-server"/);
});
