// Server-side data layer for booking connections + external mappings
// (migration 0066 — M1B). This is the DATA FOUNDATION of the multi-PMS
// architecture only: no BookingConnector interface (M1C), no sync engine, and
// no wiring into the existing Open Dental path — opendental_config,
// getOdConfig(), odForward() and appointments.external_id all keep operating
// exactly as before.
//
// Every function takes the workspace id EXPLICITLY and FAILS CLOSED without
// one — no "first workspace", no `.limit(1)` without a workspace filter, no
// cross-workspace fallback, ever. Uses the service-role client (bypasses
// RLS), so the explicit workspace_id filter on every query IS the isolation
// boundary, exactly like booking-server.ts and providers-server.ts.
//
// Secrets: booking_connection_secrets is server-only (RLS with no policy —
// the oauth_tokens pattern) and deliberately has NO helper here yet; nothing
// consumes it in M1B, and connection rows returned by this module never
// contain credentials.

import { supabaseAdmin as supabase } from "@/lib/supabase-admin";

// ── Connector + entity vocabularies ─────────────────────────────────────────
// connector_type / entity_type are free text in the schema ON PURPOSE (adding
// a PMS must never need a migration); THIS is the validation layer. A future
// connector only extends these lists.

export const KNOWN_CONNECTOR_TYPES = ["pydent_native", "opendental", "d4w"] as const;
export type KnownConnectorType = (typeof KNOWN_CONNECTOR_TYPES)[number];
// Open set: known values today, any app-validated identifier tomorrow.
export type BookingConnectionType = KnownConnectorType | (string & {});

export const MAPPING_ENTITY_TYPES = ["provider", "operatory", "appointment", "patient", "service"] as const;
export type KnownMappingEntityType = (typeof MAPPING_ENTITY_TYPES)[number];
export type MappingEntityType = KnownMappingEntityType | (string & {});

export const SYNC_RUN_TYPES = ["initial_import", "incremental", "reconciliation", "provider_import", "appointment_push", "appointment_pull"] as const;
export const SYNC_RUN_STATUSES = ["running", "succeeded", "failed", "partial"] as const;

// ── Types (rows as the app sees them) ───────────────────────────────────────

export interface BookingConnection {
  id: string;
  workspaceId: string;
  connectorType: BookingConnectionType;
  displayName: string;
  enabled: boolean;
  isPrimary: boolean;
  config: Record<string, unknown>; // NON-SECRET configuration only
  lastSyncAt: string | null;
  syncStatus: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalMapping {
  id: string;
  workspaceId: string;
  connectionId: string;
  entityType: MappingEntityType;
  pydentEntityId: string;
  externalId: string;
  externalType: string | null;
  externalUpdatedAt: string | null;
  lastSyncedAt: string | null;
  syncStatus: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BookingSyncRun {
  id: string;
  workspaceId: string;
  connectionId: string;
  syncType: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  recordsRead: number;
  recordsWritten: number;
  recordsFailed: number;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface ExternalMappingInput {
  connectionId: string;
  entityType: MappingEntityType;
  pydentEntityId: string;
  externalId: string;
  externalType?: string | null;
  externalUpdatedAt?: string | null;
  syncStatus?: string | null;
  metadata?: Record<string, unknown>;
}

// ── Pure normalization/validation (tested in tests/booking-connections) ─────

// Lowercased snake_case identifier, e.g. "opendental", "d4w", "pydent_native"
// or a future "dentrix". Anything else (empty, spaces inside, SQL noise,
// uppercase symbols) → null. Unknown-but-well-formed values are ACCEPTED so a
// new PMS needs no schema or code change here.
export function normalizeConnectorType(v: unknown): string | null {
  const s = String(v ?? "").trim().toLowerCase();
  return /^[a-z][a-z0-9_]{0,63}$/.test(s) ? s : null;
}

// Same shape rule as connector types: a lowercase identifier naming what the
// mapping points at ('provider', 'appointment', … or a future entity type).
export function normalizeEntityType(v: unknown): string | null {
  const s = String(v ?? "").trim().toLowerCase();
  return /^[a-z][a-z0-9_]{0,63}$/.test(s) ? s : null;
}

// A valid mapping needs the full identity 4-tuple; external ids are trimmed
// non-empty text (any PMS format — ProvNum-style numbers, GUIDs, composites).
export function normalizeExternalMappingInput(input: Partial<ExternalMappingInput> | null | undefined): ExternalMappingInput | null {
  const connectionId = String(input?.connectionId ?? "").trim();
  const entityType = normalizeEntityType(input?.entityType);
  const pydentEntityId = String(input?.pydentEntityId ?? "").trim();
  const externalId = String(input?.externalId ?? "").trim();
  if (!connectionId || !entityType || !pydentEntityId || !externalId) return null;
  return {
    connectionId,
    entityType,
    pydentEntityId,
    externalId,
    externalType: String(input?.externalType ?? "").trim() || null,
    externalUpdatedAt: input?.externalUpdatedAt ?? null,
    syncStatus: String(input?.syncStatus ?? "").trim() || null,
    metadata: input?.metadata && typeof input.metadata === "object" ? input.metadata : {},
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToConnection(r: any): BookingConnection {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    connectorType: r.connector_type ?? "",
    displayName: r.display_name ?? "",
    enabled: r.enabled !== false,
    isPrimary: !!r.is_primary,
    config: r.config && typeof r.config === "object" ? r.config : {},
    lastSyncAt: r.last_sync_at ?? null,
    syncStatus: r.sync_status ?? null,
    lastError: r.last_error ?? null,
    createdAt: r.created_at ?? "",
    updatedAt: r.updated_at ?? "",
  };
}

function rowToMapping(r: any): ExternalMapping {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    connectionId: r.connection_id,
    entityType: r.entity_type ?? "",
    pydentEntityId: r.pydent_entity_id,
    externalId: r.external_id ?? "",
    externalType: r.external_type ?? null,
    externalUpdatedAt: r.external_updated_at ?? null,
    lastSyncedAt: r.last_synced_at ?? null,
    syncStatus: r.sync_status ?? null,
    metadata: r.metadata && typeof r.metadata === "object" ? r.metadata : {},
    createdAt: r.created_at ?? "",
    updatedAt: r.updated_at ?? "",
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Booking connections ─────────────────────────────────────────────────────

export async function listBookingConnections(workspaceId: string, opts?: { includeDisabled?: boolean }): Promise<BookingConnection[]> {
  if (!workspaceId) return []; // fail closed — never list across workspaces
  try {
    let q = supabase.from("booking_connections").select("*").eq("workspace_id", workspaceId).order("created_at");
    if (!opts?.includeDisabled) q = q.eq("enabled", true);
    const { data, error } = await q;
    if (error || !data) return [];
    return data.map(rowToConnection);
  } catch {
    return []; // table absent until migration 0066 is applied
  }
}

export async function getBookingConnection(workspaceId: string, connectionId: string): Promise<BookingConnection | null> {
  if (!workspaceId || !connectionId) return null;
  try {
    const { data } = await supabase.from("booking_connections").select("*").eq("workspace_id", workspaceId).eq("id", connectionId).maybeSingle();
    return data ? rowToConnection(data) : null;
  } catch {
    return null;
  }
}

// The workspace's one enabled primary booking system, or null. The partial
// unique index guarantees at most one row can match.
export async function getPrimaryBookingConnection(workspaceId: string): Promise<BookingConnection | null> {
  if (!workspaceId) return null; // fail closed
  try {
    const { data } = await supabase
      .from("booking_connections")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("enabled", true)
      .eq("is_primary", true)
      .maybeSingle();
    return data ? rowToConnection(data) : null;
  } catch {
    return null;
  }
}

// ── External mappings ───────────────────────────────────────────────────────

export async function getExternalMapping(
  workspaceId: string,
  connectionId: string,
  entityType: MappingEntityType,
  pydentEntityId: string
): Promise<ExternalMapping | null> {
  const et = normalizeEntityType(entityType);
  if (!workspaceId || !connectionId || !et || !pydentEntityId) return null;
  try {
    const { data } = await supabase
      .from("external_mappings")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("connection_id", connectionId)
      .eq("entity_type", et)
      .eq("pydent_entity_id", pydentEntityId)
      .maybeSingle();
    return data ? rowToMapping(data) : null;
  } catch {
    return null;
  }
}

export async function getExternalMappingByExternalId(
  workspaceId: string,
  connectionId: string,
  entityType: MappingEntityType,
  externalId: string
): Promise<ExternalMapping | null> {
  const et = normalizeEntityType(entityType);
  const ext = String(externalId ?? "").trim();
  if (!workspaceId || !connectionId || !et || !ext) return null;
  try {
    const { data } = await supabase
      .from("external_mappings")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("connection_id", connectionId)
      .eq("entity_type", et)
      .eq("external_id", ext)
      .maybeSingle();
    return data ? rowToMapping(data) : null;
  } catch {
    return null;
  }
}

// ── Patient mapping establishment (M1E-C-B) ─────────────────────────────────
// The ONE sanctioned write path for patient identity: inserts exactly one
// entity_type='patient' row for (workspace, connection, Pydent patient).
// INSERT-NOT-OVERWRITE semantics: an identical existing mapping is reported
// as already established (idempotent re-runs), a DIFFERENT existing external
// identity is a conflict that nothing here will silently replace —
// re-pointing a patient's external identity is a deliberate human/migration
// action, never a side effect. metadata carries provenance only (how the
// match was established): no secrets, no clinical data.
export async function insertPatientMapping(
  workspaceId: string,
  input: { connectionId: string; pydentPatientId: string; externalId: string; metadata?: Record<string, unknown> }
): Promise<{ ok: boolean; status?: "created" | "existing"; conflictingExternalId?: string; message: string }> {
  if (!workspaceId) return { ok: false, message: "A workspace id is required." };
  const connectionId = String(input?.connectionId ?? "").trim();
  const patientId = String(input?.pydentPatientId ?? "").trim();
  const externalId = String(input?.externalId ?? "").trim();
  if (!connectionId || !patientId || !externalId) {
    return { ok: false, message: "connectionId, pydentPatientId and externalId are all required." };
  }
  const conn = await getBookingConnection(workspaceId, connectionId);
  if (!conn) return { ok: false, message: "Booking connection not found." };
  try {
    const existing = await getExternalMapping(workspaceId, connectionId, "patient", patientId);
    if (existing) {
      if (existing.externalId === externalId) return { ok: true, status: "existing", message: "Patient mapping already established." };
      return { ok: false, conflictingExternalId: existing.externalId, message: "This patient already has a DIFFERENT external identity mapped for this connection — not overwritten." };
    }
    const now = new Date().toISOString();
    const { error } = await supabase.from("external_mappings").insert({
      workspace_id: workspaceId,
      connection_id: connectionId,
      entity_type: "patient",
      pydent_entity_id: patientId,
      external_id: externalId,
      sync_status: "established",
      metadata: input?.metadata && typeof input.metadata === "object" ? input.metadata : {},
      last_synced_at: now,
      updated_at: now,
    });
    if (error) return { ok: false, message: error.message };
    return { ok: true, status: "created", message: "Patient mapping established." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not persist the patient mapping (is migration 0066 applied?)." };
  }
}

// Create or update the mapping for (connection, entity type, Pydent entity).
// Matches on that triple — the same key as the external_mappings_pydent_uq
// unique index — and updates in place, so re-syncs never accumulate duplicate
// rows. No ON CONFLICT (house style: works whether or not the index exists
// yet on an old deployment).
export async function upsertExternalMapping(
  workspaceId: string,
  input: Partial<ExternalMappingInput>
): Promise<{ ok: boolean; mapping?: ExternalMapping; message: string }> {
  if (!workspaceId) return { ok: false, message: "A workspace id is required." };
  const norm = normalizeExternalMappingInput(input);
  if (!norm) return { ok: false, message: "connectionId, entityType, pydentEntityId and externalId are all required." };
  // The connection must belong to THIS workspace — a foreign connection id is
  // indistinguishable from a missing one.
  const conn = await getBookingConnection(workspaceId, norm.connectionId);
  if (!conn) return { ok: false, message: "Booking connection not found." };
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    external_id: norm.externalId,
    external_type: norm.externalType,
    external_updated_at: norm.externalUpdatedAt,
    sync_status: norm.syncStatus,
    metadata: norm.metadata ?? {},
    last_synced_at: now,
    updated_at: now,
  };
  try {
    const { data: existing } = await supabase
      .from("external_mappings")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("connection_id", norm.connectionId)
      .eq("entity_type", norm.entityType)
      .eq("pydent_entity_id", norm.pydentEntityId)
      .maybeSingle();
    if (existing?.id) {
      const { data, error } = await supabase.from("external_mappings").update(row).eq("id", existing.id).eq("workspace_id", workspaceId).select("*").single();
      if (error || !data) return { ok: false, message: error?.message ?? "Could not update the mapping." };
      return { ok: true, mapping: rowToMapping(data), message: "Mapping updated." };
    }
    const { data, error } = await supabase
      .from("external_mappings")
      .insert({
        workspace_id: workspaceId,
        connection_id: norm.connectionId,
        entity_type: norm.entityType,
        pydent_entity_id: norm.pydentEntityId,
        ...row,
      })
      .select("*")
      .single();
    if (error || !data) return { ok: false, message: error?.message ?? "Could not create the mapping." };
    return { ok: true, mapping: rowToMapping(data), message: "Mapping created." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not save the mapping (is migration 0066 applied?)." };
  }
}
