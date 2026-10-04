// M1B booking connections + external mappings: connector/entity-type
// normalization, mapping input validation, fail-closed workspace handling,
// and the schema guarantees of migration 0066 (verified against the actual
// migration file — no database, no network, fictional data only).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const {
  normalizeConnectorType, normalizeEntityType, normalizeExternalMappingInput,
  KNOWN_CONNECTOR_TYPES, MAPPING_ENTITY_TYPES,
  listBookingConnections, getBookingConnection, getPrimaryBookingConnection,
  getExternalMapping, getExternalMappingByExternalId, upsertExternalMapping,
} = await import("@/lib/booking-connections-server");

const sql = await readFile(new URL("../supabase/migrations/0066_booking_connections.sql", import.meta.url), "utf8");

// ── Connector type validation (extensible, app-layer) ───────────────────────
test("known connector types normalize and future PMS types are accepted", () => {
  assert.deepEqual([...KNOWN_CONNECTOR_TYPES], ["pydent_native", "opendental", "d4w"]);
  for (const t of KNOWN_CONNECTOR_TYPES) assert.equal(normalizeConnectorType(t), t);
  assert.equal(normalizeConnectorType("  OpenDental "), "opendental");
  assert.equal(normalizeConnectorType("dentrix"), "dentrix");         // future PMS: no migration, no code change
  assert.equal(normalizeConnectorType("softdent_v2"), "softdent_v2");
});

test("malformed connector types are rejected", () => {
  for (const bad of ["", "   ", "open dental", "d4w!", "1d4w", "_x", null, undefined, "drop table;", "a".repeat(80)]) {
    assert.equal(normalizeConnectorType(bad), null, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("entity types: the known set normalizes, future types allowed, junk rejected", () => {
  assert.deepEqual([...MAPPING_ENTITY_TYPES], ["provider", "operatory", "appointment", "patient", "service"]);
  for (const t of MAPPING_ENTITY_TYPES) assert.equal(normalizeEntityType(t), t);
  assert.equal(normalizeEntityType(" Provider "), "provider");
  assert.equal(normalizeEntityType("insurance_plan"), "insurance_plan");
  assert.equal(normalizeEntityType("no spaces here"), null);
  assert.equal(normalizeEntityType(""), null);
});

// ── Mapping input validation ────────────────────────────────────────────────
test("external mapping input needs the full identity 4-tuple", () => {
  const good = normalizeExternalMappingInput({
    connectionId: "conn-fict-1", entityType: "Provider", pydentEntityId: "prov-fict-1", externalId: " 12 ",
  });
  assert.equal(good.entityType, "provider");
  assert.equal(good.externalId, "12"); // an Open Dental ProvNum lives in external_id — never in its own column
  assert.equal(good.externalType, null);
  assert.deepEqual(good.metadata, {});
  for (const missing of [
    {},
    { connectionId: "c", entityType: "provider", pydentEntityId: "p" },               // no externalId
    { connectionId: "c", entityType: "provider", externalId: "1" },                   // no pydentEntityId
    { connectionId: "c", pydentEntityId: "p", externalId: "1" },                      // no entityType
    { entityType: "provider", pydentEntityId: "p", externalId: "1" },                 // no connectionId
    { connectionId: "c", entityType: "bad type", pydentEntityId: "p", externalId: "1" },
  ]) {
    assert.equal(normalizeExternalMappingInput(missing), null);
  }
});

// ── Patient mapping establishment (M1E-C-B) ─────────────────────────────────
test("insertPatientMapping fails closed on missing workspace or identity fields", async () => {
  const { insertPatientMapping } = await import("@/lib/booking-connections-server");
  assert.equal((await insertPatientMapping("", { connectionId: "c", pydentPatientId: "p", externalId: "1" })).ok, false);
  for (const bad of [{}, { connectionId: "c", pydentPatientId: "p" }, { connectionId: "c", externalId: "1" }, { pydentPatientId: "p", externalId: "1" }]) {
    const r = await insertPatientMapping("ws-fict-A", bad);
    assert.equal(r.ok, false);
    assert.match(r.message, /required/);
  }
  // The function is hard-scoped to patient rows: its source writes
  // entity_type "patient" literally and accepts no entity-type input.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/lib/booking-connections-server.ts", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("export async function insertPatientMapping"), src.indexOf("// Create or update the mapping"));
  assert.match(block, /entity_type: "patient"/);
  assert.equal(block.includes("entityType"), false, "no caller-supplied entity type — this is not a generic write");
});

// ── Appointment mapping + intent ledger (M1E-C-C) ───────────────────────────
test("insertAppointmentMapping fails closed and is hard-scoped to appointment rows", async () => {
  const { insertAppointmentMapping } = await import("@/lib/booking-connections-server");
  assert.equal((await insertAppointmentMapping("", { connectionId: "c", pydentAppointmentId: "a", externalId: "900" })).ok, false);
  for (const bad of [{}, { connectionId: "c", pydentAppointmentId: "a" }, { connectionId: "c", externalId: "900" }, { pydentAppointmentId: "a", externalId: "900" }]) {
    const r = await insertAppointmentMapping("ws-fict-A", bad);
    assert.equal(r.ok, false);
    assert.match(r.message, /required/);
  }
  // Hard-scoped like the patient writer: entity_type "appointment" is a
  // literal in the source and no caller-supplied entity type exists.
  const src = await readFile(new URL("../src/lib/booking-connections-server.ts", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("export async function insertAppointmentMapping"), src.indexOf("export interface SyncIntent"));
  assert.match(block, /entity_type: "appointment"/);
  assert.equal(block.includes("entityType"), false, "no caller-supplied entity type — this is not a generic write");
  // Insert-not-overwrite: a differing existing identity is refused, never replaced.
  assert.match(block, /conflictingExternalId: existing\.externalId/);
  assert.equal(/\.update\(|upsert/.test(block), false, "the appointment mapping writer must only insert");
});

test("intent ledger helpers fail closed without workspace/identity, and 'unknown' is a first-class status", async () => {
  const { createSyncIntent, updateSyncIntent, latestAppointmentIntent, writeLegacyAppointmentExternalRef, getWorkspaceAppointmentRow, SYNC_RUN_STATUSES } =
    await import("@/lib/booking-connections-server");
  // The app vocabulary extends 0066's free-text status column — no migration
  // needed, and the unknown-outcome state is explicit, never conflated with
  // failed (failed = definitely did not happen; unknown = must reconcile).
  assert.deepEqual([...SYNC_RUN_STATUSES], ["running", "succeeded", "failed", "partial", "unknown"]);
  // 0066 really does leave status free text (no CHECK constraint to violate):
  assert.match(sql, /status text not null default 'running'/);
  assert.doesNotMatch(sql, /status text not null default 'running'[^,\n]*check/i);
  // Fail-closed inputs:
  assert.equal((await createSyncIntent("", { connectionId: "c", syncType: "appointment_push", detail: {} })).ok, false);
  assert.equal((await createSyncIntent("ws-fict-A", { connectionId: "", syncType: "appointment_push", detail: {} })).ok, false);
  assert.equal((await createSyncIntent("ws-fict-A", { connectionId: "c", syncType: "", detail: {} })).ok, false);
  assert.equal((await updateSyncIntent("", "intent-fict-1", { status: "failed" })).ok, false);
  assert.equal((await updateSyncIntent("ws-fict-A", "", { status: "failed" })).ok, false);
  assert.equal(await latestAppointmentIntent("", "c", "appt-fict-1"), null);
  assert.equal(await latestAppointmentIntent("ws-fict-A", "", "appt-fict-1"), null);
  assert.equal(await latestAppointmentIntent("ws-fict-A", "c", ""), null);
  assert.equal(await writeLegacyAppointmentExternalRef("", "appt-fict-1", "900"), false);
  assert.equal(await writeLegacyAppointmentExternalRef("ws-fict-A", "", "900"), false);
  assert.equal(await writeLegacyAppointmentExternalRef("ws-fict-A", "appt-fict-1", ""), false);
  assert.equal(await getWorkspaceAppointmentRow("", "appt-fict-1"), null);
  assert.equal(await getWorkspaceAppointmentRow("ws-fict-A", ""), null);
});

// ── Fail-closed workspace handling ──────────────────────────────────────────
test("every helper fails closed without an explicit workspace id", async () => {
  assert.deepEqual(await listBookingConnections(""), []);
  assert.equal(await getBookingConnection("", "conn-fict-1"), null);
  assert.equal(await getPrimaryBookingConnection(""), null);
  assert.equal(await getExternalMapping("", "c", "provider", "p"), null);
  assert.equal(await getExternalMappingByExternalId("", "c", "provider", "12"), null);
  const r = await upsertExternalMapping("", { connectionId: "c", entityType: "provider", pydentEntityId: "p", externalId: "1" });
  assert.equal(r.ok, false);
});

// ── Schema guarantees, pinned against the real migration file ───────────────
test("0066: one enabled primary connection per workspace (partial unique index)", () => {
  assert.match(sql, /create unique index if not exists booking_connections_one_primary_idx\s+on public\.booking_connections \(workspace_id\) where \(is_primary and enabled\)/);
});

test("0066: mapping uniqueness on (connection, entity_type, external_id) AND (connection, entity_type, pydent_entity_id)", () => {
  assert.match(sql, /create unique index if not exists external_mappings_external_uq\s+on public\.external_mappings \(connection_id, entity_type, external_id\)/);
  assert.match(sql, /create unique index if not exists external_mappings_pydent_uq\s+on public\.external_mappings \(connection_id, entity_type, pydent_entity_id\)/);
});

test("0066: secrets table is server-only — RLS enabled, zero policies", () => {
  assert.match(sql, /alter table public\.booking_connection_secrets enable row level security/);
  assert.doesNotMatch(sql, /create policy[^;]*booking_connection_secrets/i, "no browser policy may exist on the secrets table");
});

test("0066: workspace-isolation policy on every browser-visible table", () => {
  for (const t of ["booking_connections", "external_mappings", "booking_sync_runs"]) {
    assert.match(sql, new RegExp(`create policy "workspace isolation" on public\\.${t}\\s+for all using \\(workspace_id = current_workspace\\(\\)\\) with check \\(workspace_id = current_workspace\\(\\)\\)`));
  }
});

test("0066: composite workspace-consistency FKs on every child table", () => {
  // The referenced pair exists as a real UNIQUE constraint (the supported
  // form for composite FK targets), not merely an index.
  assert.match(sql, /constraint booking_connections_id_ws_uq unique \(id, workspace_id\)/);
  // Each child table references (id, workspace_id) with ON DELETE CASCADE, so
  // a row can never pair workspace A with workspace B's connection.
  for (const [table, cname] of [
    ["booking_connection_secrets", "booking_connection_secrets_conn_ws_fk"],
    ["external_mappings", "external_mappings_conn_ws_fk"],
    ["booking_sync_runs", "booking_sync_runs_conn_ws_fk"],
  ]) {
    const block = sql.slice(sql.indexOf(`create table if not exists public.${table}`));
    assert.match(
      block.slice(0, block.indexOf(");") + 2),
      new RegExp(`constraint ${cname}\\s+foreign key \\(connection_id, workspace_id\\)\\s+references public\\.booking_connections \\(id, workspace_id\\) on delete cascade`),
      `${table} must carry the composite workspace-consistency FK`
    );
  }
  // The composite FK fully replaces the old single-column connection FK.
  assert.doesNotMatch(sql, /references public\.booking_connections\(id\)/, "no single-column booking_connections(id) FK may remain");
});

test("0066: generic schema — no PMS-specific columns, no connector_type CHECK", () => {
  for (const forbidden of ["open_dental_id", "prov_num", "op_num", "apt_num", "d4w_id", "opendental_id", "dentrix"]) {
    assert.equal(sql.toLowerCase().includes(forbidden), false, `schema must not contain "${forbidden}"`);
  }
  // connector_type is free text — extending to a new PMS must never need a migration.
  assert.doesNotMatch(sql, /connector_type text not null[^,\n]*check/i);
  // secrets never live in booking_connections.config (non-secret only, per comment + secrets table).
  assert.match(sql, /config jsonb not null default '\{\}'::jsonb,\s+-- NON-SECRET/);
});
