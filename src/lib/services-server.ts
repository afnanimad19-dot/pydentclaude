// Server-side data layer for the first-class service/procedure catalog
// (migration 0067 — M1E-A). PMS-neutral: external service identities live
// ONLY in external_mappings (entity_type = 'service'); the resolver below
// reuses the generic M1B mapping helper rather than duplicating queries.
//
// Every function takes the workspace id EXPLICITLY and fails closed without
// one — no first-workspace, no unscoped limit-one lookup, no cross-workspace
// fallback — same pattern as providers-server.ts and
// booking-connections-server.ts. Reads are defensive: before migration 0067
// is applied they return empty/null, never throw. FOUNDATION ONLY: no API
// routes, no UI, and no booking flow consumes this module yet (M1E-B wires
// service resolution into connector orchestration after review).

import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { getExternalMapping } from "@/lib/booking-connections-server";

// ── Types ───────────────────────────────────────────────────────────────────

export interface Service {
  id: string;
  workspaceId: string;
  name: string;
  displayName: string | null;  // null = not provided
  code: string | null;         // Pydent-INTERNAL label — never an external PMS identity; null = not provided
  description: string | null;  // null = not provided
  defaultDurationMin: number | null; // null = unknown; never fabricated
  active: boolean;
  bookingEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceInput {
  name: string;
  displayName?: string | null;
  code?: string | null;
  description?: string | null;
  defaultDurationMin?: number | null;
  active?: boolean;
  bookingEnabled?: boolean;
}

// Optional text: trimmed, and blank ("", "   ", null, undefined) becomes
// NULL — the single representation of "not provided".
function optionalText(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

// ── Pure normalization (tested in tests/services.test.mjs) ──────────────────

// Trims text fields and enforces: non-empty name; duration either absent
// (null) or a POSITIVE integer — a supplied non-positive/garbage duration
// rejects the whole input (null return) instead of being silently replaced
// with a fabricated default.
export function normalizeServiceInput(input: Partial<ServiceInput> | null | undefined): ServiceInput | null {
  const name = String(input?.name ?? "").trim();
  if (!name) return null;
  let defaultDurationMin: number | null = null;
  if (input?.defaultDurationMin !== undefined && input?.defaultDurationMin !== null && String(input.defaultDurationMin) !== "") {
    const n = Number(input.defaultDurationMin);
    if (!Number.isFinite(n) || n <= 0 || n > 480) return null; // supplied but invalid → reject, never fabricate
    defaultDurationMin = Math.round(n);
  }
  return {
    name,
    displayName: optionalText(input?.displayName),
    code: optionalText(input?.code),
    description: optionalText(input?.description),
    defaultDurationMin,
    active: input?.active !== false,
    bookingEnabled: input?.bookingEnabled !== false,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToService(r: any): Service {
  const dur = Number(r.default_duration_min);
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name ?? "",
    displayName: optionalText(r.display_name),
    code: optionalText(r.code),
    description: optionalText(r.description),
    defaultDurationMin: Number.isFinite(dur) && dur > 0 ? dur : null,
    active: r.active !== false,
    bookingEnabled: r.booking_enabled !== false,
    createdAt: r.created_at ?? "",
    updatedAt: r.updated_at ?? "",
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Reads (workspace-explicit, fail closed) ─────────────────────────────────

export async function listServices(workspaceId: string, opts?: { includeInactive?: boolean }): Promise<Service[]> {
  if (!workspaceId) return []; // fail closed — never list across workspaces
  try {
    let q = supabase.from("services").select("*").eq("workspace_id", workspaceId).order("name");
    if (!opts?.includeInactive) q = q.eq("active", true);
    const { data, error } = await q;
    if (error || !data) return [];
    return data.map(rowToService);
  } catch {
    return []; // table absent until migration 0067 is applied
  }
}

export async function getService(workspaceId: string, serviceId: string): Promise<Service | null> {
  if (!workspaceId || !serviceId) return null;
  try {
    const { data } = await supabase.from("services").select("*").eq("workspace_id", workspaceId).eq("id", serviceId).maybeSingle();
    return data ? rowToService(data) : null;
  } catch {
    return null;
  }
}

// The service only when it may be offered for booking: existing, active AND
// booking-enabled — anything else is null, so callers cannot accidentally
// book a retired or non-bookable service.
export async function getBookableService(workspaceId: string, serviceId: string): Promise<Service | null> {
  const s = await getService(workspaceId, serviceId);
  if (!s || !s.active || !s.bookingEnabled) return null;
  return s;
}

// ── External identity (via the generic M1B mapping helper) ──────────────────

// Pydent service id → the external PMS's service/procedure identity for one
// booking connection, through external_mappings (entity_type = 'service').
// No mapping → null, fail closed: the internal `code` field is NEVER used as
// a substitute external identity, and there is no first-service fallback.
// `deps` exists for deterministic tests; production uses the real M1B helper.
export async function getServiceExternalId(
  workspaceId: string,
  connectionId: string,
  serviceId: string,
  deps: { getMapping: typeof getExternalMapping } = { getMapping: getExternalMapping }
): Promise<string | null> {
  const sid = String(serviceId ?? "").trim();
  if (!workspaceId || !connectionId || !sid) return null;
  const mapping = await deps.getMapping(workspaceId, connectionId, "service", sid);
  const ext = String(mapping?.externalId ?? "").trim();
  return ext || null;
}
