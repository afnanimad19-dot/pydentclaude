// Server-side data layer for the first-class provider/operatory entities
// (migration 0065 — M1A). PMS-independent by design: no Open Dental, no
// external ids here (those arrive with external_mappings in M1B).
//
// Every function takes the workspace id EXPLICITLY and refuses to run without
// one — there is no "first workspace" fallback and no cross-workspace lookup,
// ever. Uses the service-role client (RLS-bypassing), so the explicit
// workspace_id filter on every query IS the isolation boundary, exactly like
// booking-server.ts.
//
// Defensive reads, per house style: on a deployment where migration 0065 has
// not been applied, reads return empty results and writes fail with a clear
// message — nothing throws.

import { supabaseAdmin as supabase } from "@/lib/supabase-admin";

// ── Types (rows as the app sees them) ───────────────────────────────────────

export interface Provider {
  id: string;
  workspaceId: string;
  name: string;
  displayName: string;
  specialty: string;
  color: string;
  active: boolean;
  bookingEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderSchedule {
  id: string;
  workspaceId: string;
  providerId: string;
  weekday: Weekday;
  startTime: string; // "HH:MM"
  endTime: string;   // "HH:MM"
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleBlock {
  id: string;
  workspaceId: string;
  providerId: string | null; // null = clinic-wide block
  date: string;              // "YYYY-MM-DD"
  startTime: string;
  endTime: string;
  blockType: BlockType;
  reason: string;
  createdAt: string;
  updatedAt: string;
}

export interface Operatory {
  id: string;
  workspaceId: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// Lowercase English day names — the exact vocabulary weekdayInTz() and
// clinic_settings.closed_days already use (src/lib/scheduling.ts).
export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const BLOCK_TYPES = ["break", "leave", "blocked", "closure"] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export interface ProviderInput {
  name: string;
  displayName?: string;
  specialty?: string;
  color?: string;
  active?: boolean;
  bookingEnabled?: boolean;
}

// ── Pure input normalization (tested directly in tests/providers.test.mjs) ──

// Trims every text field and enforces a non-empty name. Returns null when the
// input cannot become a valid provider row.
export function normalizeProviderInput(input: Partial<ProviderInput> | null | undefined): ProviderInput | null {
  const name = String(input?.name ?? "").trim();
  if (!name) return null;
  return {
    name,
    displayName: String(input?.displayName ?? "").trim(),
    specialty: String(input?.specialty ?? "").trim(),
    color: String(input?.color ?? "").trim(),
    active: input?.active !== false,
    bookingEnabled: input?.bookingEnabled !== false,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToProvider(r: any): Provider {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name ?? "",
    displayName: r.display_name ?? "",
    specialty: r.specialty ?? "",
    color: r.color ?? "",
    active: r.active !== false,
    bookingEnabled: r.booking_enabled !== false,
    createdAt: r.created_at ?? "",
    updatedAt: r.updated_at ?? "",
  };
}

function rowToOperatory(r: any): Operatory {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name ?? "",
    active: r.active !== false,
    createdAt: r.created_at ?? "",
    updatedAt: r.updated_at ?? "",
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Providers ───────────────────────────────────────────────────────────────

export async function listProviders(workspaceId: string, opts?: { includeInactive?: boolean }): Promise<Provider[]> {
  if (!workspaceId) return [];
  try {
    let q = supabase.from("providers").select("*").eq("workspace_id", workspaceId).order("name");
    if (!opts?.includeInactive) q = q.eq("active", true);
    const { data, error } = await q;
    if (error || !data) return [];
    return data.map(rowToProvider);
  } catch {
    return []; // table absent until migration 0065 is applied
  }
}

export async function getProvider(workspaceId: string, providerId: string): Promise<Provider | null> {
  if (!workspaceId || !providerId) return null;
  try {
    const { data } = await supabase.from("providers").select("*").eq("workspace_id", workspaceId).eq("id", providerId).maybeSingle();
    return data ? rowToProvider(data) : null;
  } catch {
    return null;
  }
}

export async function createProvider(
  workspaceId: string,
  input: Partial<ProviderInput>
): Promise<{ ok: boolean; provider?: Provider; message: string }> {
  if (!workspaceId) return { ok: false, message: "A workspace id is required." };
  const norm = normalizeProviderInput(input);
  if (!norm) return { ok: false, message: "The provider needs a name." };
  try {
    const { data, error } = await supabase
      .from("providers")
      .insert({
        workspace_id: workspaceId,
        name: norm.name,
        display_name: norm.displayName,
        specialty: norm.specialty,
        color: norm.color,
        active: norm.active,
        booking_enabled: norm.bookingEnabled,
      })
      .select("*")
      .single();
    if (error || !data) return { ok: false, message: error?.message ?? "Could not create the provider." };
    return { ok: true, provider: rowToProvider(data), message: "Provider created." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not create the provider (is migration 0065 applied?)." };
  }
}

export async function updateProvider(
  workspaceId: string,
  providerId: string,
  patch: Partial<ProviderInput>
): Promise<{ ok: boolean; message: string }> {
  if (!workspaceId || !providerId) return { ok: false, message: "A workspace id and provider id are required." };
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name) return { ok: false, message: "The provider name cannot be empty." };
    row.name = name;
  }
  if (patch.displayName !== undefined) row.display_name = String(patch.displayName).trim();
  if (patch.specialty !== undefined) row.specialty = String(patch.specialty).trim();
  if (patch.color !== undefined) row.color = String(patch.color).trim();
  if (patch.active !== undefined) row.active = !!patch.active;
  if (patch.bookingEnabled !== undefined) row.booking_enabled = !!patch.bookingEnabled;
  try {
    // Both filters — the workspace check is the isolation boundary; a provider
    // in another workspace is indistinguishable from one that doesn't exist.
    const { data, error } = await supabase.from("providers").update(row).eq("workspace_id", workspaceId).eq("id", providerId).select("id");
    if (error) return { ok: false, message: error.message };
    if (!data?.length) return { ok: false, message: "Provider not found." };
    return { ok: true, message: "Provider updated." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not update the provider." };
  }
}

// ── Operatories ─────────────────────────────────────────────────────────────

export async function listOperatories(workspaceId: string, opts?: { includeInactive?: boolean }): Promise<Operatory[]> {
  if (!workspaceId) return [];
  try {
    let q = supabase.from("operatories").select("*").eq("workspace_id", workspaceId).order("name");
    if (!opts?.includeInactive) q = q.eq("active", true);
    const { data, error } = await q;
    if (error || !data) return [];
    return data.map(rowToOperatory);
  } catch {
    return [];
  }
}
