// Doctor → calendar mapping management (Smart Scheduling Day 2).
//
// Calendar ids are tenant-scoped CONFIGURATION, managed by a clinic admin
// through /api/scheduling/doctors — never hardcoded in application logic.
// This module is pure (injected persistence, repo's builder-tools pattern):
// it validates and shapes a mapping; the route wires realDoctorCalendarDeps.
//
// Multi-tenant rule: `ws` always comes from the caller's VERIFIED session
// (authorizeRequest) and every write filters by workspace_id — a mapping can
// never be created for, read from, or removed from another clinic.
//
// Test calendars: a mapping flagged is_test marks the dedicated Pydent
// DEVELOPMENT calendar. The flag travels through availability results and AI
// tool output so test availability is never presented as confirmed clinical
// availability. Production/Callab.AI calendars are never imported or modified
// here — a mapping row only stores an id for read-only FreeBusy lookups.

import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { isValidTimeZone } from "@/lib/availability";

export const CALENDAR_PROVIDERS = ["google"] as const;

export interface DoctorCalendarInput {
  doctor?: unknown;
  calendar_id?: unknown;
  provider?: unknown;
  timezone?: unknown;
  active?: unknown;
  is_test?: unknown;
}

export interface DoctorCalendarUpsertRow {
  doctor_name: string;
  calendar_id: string;
  provider: string;
  timezone: string | null;
  active: boolean;
  is_test: boolean;
}

export interface DoctorCalendarWriteDeps {
  upsert(ws: string, row: DoctorCalendarUpsertRow): Promise<{ ok: true } | { ok: false; error: string }>;
  remove(ws: string, doctor: string, provider: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

export type MappingResult =
  | { ok: true; mapping: DoctorCalendarUpsertRow }
  | { ok: false; status: number; error: string };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

// Validate a mapping without touching any service — shared by the API route
// and tests. Nothing clinic-specific is assumed: any syntactically valid
// Google calendar address is accepted; WHICH calendar belongs to WHICH doctor
// is the clinic's configuration decision.
export function validateDoctorCalendar(input: DoctorCalendarInput): MappingResult {
  const doctor_name = str(input.doctor).slice(0, 120);
  if (doctor_name.length < 2) return { ok: false, status: 400, error: "doctor is required (the doctor's display name, e.g. 'Dr. Leila Hariri')." };

  const provider = (str(input.provider) || "google").toLowerCase();
  if (!(CALENDAR_PROVIDERS as readonly string[]).includes(provider)) {
    return { ok: false, status: 400, error: `provider must be one of: ${CALENDAR_PROVIDERS.join(", ")}.` };
  }

  // Google calendar ids are email-shaped addresses (user@... or
  // ...@group.calendar.google.com) — reject anything that can't be one so a
  // typo is caught at configuration time, not as a FreeBusy notFound later.
  const calendar_id = str(input.calendar_id);
  if (!/^[^\s@]+@[^\s@]+$/.test(calendar_id) || calendar_id.length > 255) {
    return { ok: false, status: 400, error: "calendar_id must be a calendar address like …@group.calendar.google.com." };
  }

  const tzRaw = str(input.timezone);
  if (tzRaw && !isValidTimeZone(tzRaw)) {
    return { ok: false, status: 400, error: `"${str(input.timezone).slice(0, 60)}" is not a valid IANA timezone (e.g. Asia/Dubai).` };
  }

  return {
    ok: true,
    mapping: {
      doctor_name,
      calendar_id,
      provider,
      timezone: tzRaw || null,
      active: input.active === undefined ? true : input.active === true || input.active === "true",
      is_test: input.is_test === true || input.is_test === "true",
    },
  };
}

export async function upsertDoctorCalendar(deps: DoctorCalendarWriteDeps, ws: string, input: DoctorCalendarInput): Promise<MappingResult> {
  const v = validateDoctorCalendar(input);
  if (!v.ok) return v;
  const saved = await deps.upsert(ws, v.mapping);
  if (!saved.ok) return { ok: false, status: 500, error: saved.error };
  return v;
}

export async function removeDoctorCalendar(
  deps: DoctorCalendarWriteDeps,
  ws: string,
  input: { doctor?: unknown; provider?: unknown }
): Promise<{ ok: true; doctor: string; provider: string } | { ok: false; status: number; error: string }> {
  const doctor = str(input.doctor);
  if (!doctor) return { ok: false, status: 400, error: "doctor is required." };
  const provider = (str(input.provider) || "google").toLowerCase();
  const r = await deps.remove(ws, doctor, provider);
  if (!r.ok) return { ok: false, status: 500, error: r.error };
  return { ok: true, doctor, provider };
}

// ---- Real persistence -------------------------------------------------------

export const realDoctorCalendarDeps: DoctorCalendarWriteDeps = {
  upsert: async (ws, row) => {
    try {
      const write = (r: Record<string, unknown>) =>
        supabase.from("doctor_calendars").upsert({ workspace_id: ws, ...r, updated_at: new Date().toISOString() }, { onConflict: "workspace_id,provider,doctor_name" });
      const full = await write(row as unknown as Record<string, unknown>);
      if (!full.error) return { ok: true };
      // Between migrations (0065 applied, 0066 not): the Day-2 columns don't
      // exist. Retry without them ONLY when they carry their defaults —
      // silently dropping a requested timezone or test flag would misconfigure
      // the clinic.
      if (row.timezone === null && row.is_test === false) {
        const legacy = await write({ doctor_name: row.doctor_name, calendar_id: row.calendar_id, provider: row.provider, active: row.active });
        if (!legacy.error) return { ok: true };
        return { ok: false, error: "doctor_calendars is not available (apply migration 0065 first)." };
      }
      return { ok: false, error: "Could not save timezone/is_test — apply migration 0066 first, or omit those fields." };
    } catch {
      return { ok: false, error: "doctor_calendars write failed." };
    }
  },
  remove: async (ws, doctor, provider) => {
    try {
      const { error } = await supabase
        .from("doctor_calendars")
        .delete()
        .eq("workspace_id", ws)
        .eq("provider", provider)
        .eq("doctor_name", doctor);
      return error ? { ok: false, error: "doctor_calendars is not available (apply migration 0065 first)." } : { ok: true };
    } catch {
      return { ok: false, error: "doctor_calendars delete failed." };
    }
  },
};
