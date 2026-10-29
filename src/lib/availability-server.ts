// Smart Scheduling availability service — tenant-scoped, channel-agnostic.
//
// One shared backend for every caller (dashboard API routes today; Laura
// Voice AI and the WhatsApp agent through the same tool contracts later), so
// scheduling logic is never duplicated per channel. Follows the repo's
// builder-tools pattern: the logic is pure with injected services
// (AvailabilityDeps), and `realAvailabilityDeps` wires Supabase + the Google
// FreeBusy client for production use.
//
// Truthfulness rules (non-negotiable):
//  * A failed FreeBusy call is NEVER an empty calendar — the result says
//    "unavailable" and no slots are offered.
//  * A calendar Google reports an error for (notFound / accessDenied) makes
//    only THAT doctor unavailable; other doctors in the same batch still work.
//  * No patient event details exist in free/busy data, and no credentials or
//    calendar ids appear in results.

import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { freeBusyQuery, googleCalendarConfigured, type FreeBusyQuery, type FreeBusyResponse } from "@/lib/google-freebusy";
import {
  computeDaySlots, parseBusyIntervals, zonedTimeToUtcMs, isValidDateStr, isValidTimeZone,
  type AvailabilitySlot,
} from "@/lib/availability";
import {
  normalizeSchedulingSettings, DEFAULT_SCHEDULING, DEFAULT_CLINIC_TZ,
  sameProvider, weekdayInTz, todayInTz, clampDuration, timeToMinutes,
  type SchedulingSettings,
} from "@/lib/scheduling";

export interface DoctorCalendarRow {
  doctor_name: string;
  calendar_id: string;
  provider: string;
  active: boolean;
  /** Optional per-doctor IANA timezone override (migration 0066); null/absent = clinic timezone. */
  timezone?: string | null;
  /** True for development/test calendar mappings (migration 0066): availability
   *  from them is labelled test data, never confirmed clinical availability. */
  is_test?: boolean | null;
}

export interface ClinicConfig {
  timezone: string;
  settings: SchedulingSettings;
}

export interface AvailabilityDeps {
  configured(): boolean;
  listDoctorCalendars(ws: string): Promise<{ ok: true; rows: DoctorCalendarRow[] } | { ok: false; error: string }>;
  getClinicConfig(ws: string): Promise<ClinicConfig>;
  freeBusy(q: FreeBusyQuery): Promise<FreeBusyResponse>;
  now(): Date;
}

export type AvailabilityError =
  | "not_configured" | "no_mapping" | "auth_failed" | "calendar_error"
  | "api_error" | "timeout" | "invalid_date" | "invalid_duration";

export interface DoctorAvailability {
  doctor: string;
  // ok      → slots are real availability (possibly none: fully booked)
  // closed  → clinic closed that day (known-empty, not an error)
  // unavailable → availability could NOT be verified; never offer times
  status: "ok" | "closed" | "unavailable";
  error?: AvailabilityError;
  detail?: string;
  busyCount?: number;
  /** Timezone the slot times are expressed in (per-doctor override or clinic tz). */
  timezone?: string;
  /** Present and true ONLY for test-calendar mappings: these times are test
   *  data from the development calendar, NOT confirmed clinical availability. */
  test?: boolean;
  slots: AvailabilitySlot[];
}

export interface ClinicAvailabilityResult {
  success: boolean;            // false only when NOTHING could be answered
  clinicId: string;            // workspace id (tenant)
  date: string;
  timezone: string;
  durationMin: number;
  source: "google_freebusy";
  retrievedAt: string;         // ISO timestamp of the data retrieval
  tookMs?: number;
  error?: AvailabilityError;
  detail?: string;
  doctors: DoctorAvailability[];
}

const MAX_RANGE_DAYS = 14;

function failAll(base: Omit<ClinicAvailabilityResult, "success" | "doctors">, error: AvailabilityError, detail: string | undefined, doctors: string[]): ClinicAvailabilityResult {
  return {
    ...base, success: false, error, ...(detail ? { detail } : {}),
    doctors: doctors.map((doctor) => ({ doctor, status: "unavailable", error, slots: [] })),
  };
}

// Availability for every (or a filtered set of) doctor(s) of one clinic on one
// day — a single batched FreeBusy query, results mapped back per doctor.
export async function getClinicAvailability(
  deps: AvailabilityDeps,
  ws: string,
  args: { date: string; durationMin?: unknown; doctors?: string[] }
): Promise<ClinicAvailabilityResult> {
  const cfg = await deps.getClinicConfig(ws);
  const base = {
    clinicId: ws,
    date: String(args.date ?? ""),
    timezone: cfg.timezone,
    durationMin: clampDuration(args.durationMin, cfg.settings.defaultDurationMin),
    source: "google_freebusy" as const,
    retrievedAt: deps.now().toISOString(),
  };

  if (!isValidDateStr(args.date)) return failAll(base, "invalid_date", "date must be YYYY-MM-DD", []);
  if (!deps.configured()) {
    return failAll(base, "not_configured", "Google Calendar service-account key (GOOGLE_CALENDAR_SA_KEY_JSON) is not set.", []);
  }

  const mappings = await deps.listDoctorCalendars(ws);
  if (!mappings.ok) return failAll(base, "no_mapping", mappings.error, []);
  let rows = mappings.rows.filter((r) => r.active && r.provider === "google" && r.calendar_id);
  if (args.doctors?.length) {
    rows = rows.filter((r) => args.doctors!.some((d) => sameProvider(r.doctor_name, d)));
    if (!rows.length) {
      return failAll(base, "no_mapping", "No calendar mapping for the requested doctor(s).", args.doctors);
    }
  }
  if (!rows.length) return failAll(base, "no_mapping", "No doctor calendars are configured for this clinic.", []);

  // Clinic closed that day → known-empty for every doctor, not an error.
  const weekday = weekdayInTz(base.date, cfg.timezone);
  if (weekday && cfg.settings.closedDays.includes(weekday)) {
    return {
      ...base, success: true,
      doctors: rows.map((r) => ({ doctor: r.doctor_name, status: "closed", ...(r.is_test ? { test: true as const } : {}), slots: [] })),
    };
  }

  // A doctor's slot window is the clinic's opening hours expressed in that
  // doctor's timezone: the clinic timezone by default, or the mapping's
  // per-doctor override (0066) when valid — an invalid stored value falls
  // back to the clinic timezone rather than failing the request.
  const tzFor = (r: DoctorCalendarRow) => (isValidTimeZone(r.timezone) ? r.timezone : cfg.timezone);
  // For "today", never offer start times already in the past: push the
  // effective opening forward to the next grid point at or after now.
  const effectiveOpenFor = (tz: string, openMs: number) => {
    if (base.date !== todayInTz(tz, deps.now())) return cfg.settings.openTime;
    const sinceOpenMin = Math.max(0, Math.ceil((deps.now().getTime() - openMs) / 60_000));
    const grid = Math.max(1, cfg.settings.slotMinutes);
    const shifted = timeToMinutes(cfg.settings.openTime) + Math.ceil(sinceOpenMin / grid) * grid;
    return `${String(Math.floor(shifted / 60)).padStart(2, "0")}:${String(shifted % 60).padStart(2, "0")}`;
  };
  const windows = new Map<string, { openMs: number; closeMs: number; effectiveOpen: string }>();
  for (const tz of new Set(rows.map(tzFor))) {
    const openMs = zonedTimeToUtcMs(base.date, cfg.settings.openTime, tz);
    windows.set(tz, { openMs, closeMs: zonedTimeToUtcMs(base.date, cfg.settings.closeTime, tz), effectiveOpen: effectiveOpenFor(tz, openMs) });
  }
  // One batched query spanning every doctor's window, so a timezone override
  // can never push busy intervals outside the queried range (missed busy time
  // would read as fabricated availability).
  const all = [...windows.values()];
  const fb = await deps.freeBusy({
    timeMin: new Date(Math.min(...all.map((w) => w.openMs))).toISOString(),
    timeMax: new Date(Math.max(...all.map((w) => w.closeMs))).toISOString(),
    timeZone: cfg.timezone,
    calendarIds: rows.map((r) => r.calendar_id),
  });
  if (!fb.ok) {
    const err: AvailabilityError = fb.error === "auth_failed" || fb.error === "not_configured" || fb.error === "timeout"
      ? fb.error : "api_error";
    return { ...failAll(base, err, fb.detail, rows.map((r) => r.doctor_name)), tookMs: fb.tookMs };
  }

  const doctors: DoctorAvailability[] = rows.map((r) => {
    const tz = tzFor(r);
    const flags = { timezone: tz, ...(r.is_test ? { test: true as const } : {}) };
    const cal = fb.calendars[r.calendar_id];
    if (!cal) return { doctor: r.doctor_name, status: "unavailable", error: "calendar_error", detail: "calendar missing from FreeBusy response", ...flags, slots: [] };
    if (cal.errors?.length) {
      const reason = cal.errors.map((e) => e.reason ?? "error").join(",").slice(0, 80);
      return { doctor: r.doctor_name, status: "unavailable", error: "calendar_error", detail: reason, ...flags, slots: [] };
    }
    const busy = parseBusyIntervals(cal.busy);
    const w = windows.get(tz)!;
    const slots = computeDaySlots({
      date: base.date, timezone: tz,
      openTime: w.effectiveOpen, closeTime: cfg.settings.closeTime,
      slotMinutes: cfg.settings.slotMinutes, durationMin: base.durationMin,
      busy,
    });
    return { doctor: r.doctor_name, status: "ok", busyCount: busy.length, ...flags, slots };
  });

  return { ...base, success: doctors.some((d) => d.status !== "unavailable"), tookMs: fb.tookMs, doctors };
}

export interface DoctorAvailabilityResult extends ClinicAvailabilityResult {
  doctor: string;
  days?: ClinicAvailabilityResult[]; // present for date-range queries
}

// Availability for ONE doctor on a date (or a short date range).
export async function getDoctorAvailability(
  deps: AvailabilityDeps,
  ws: string,
  args: { doctor: string; date: string; durationMin?: unknown; dateEnd?: string }
): Promise<DoctorAvailabilityResult> {
  const doctor = String(args.doctor ?? "").trim();
  const first = await getClinicAvailability(deps, ws, { date: args.date, durationMin: args.durationMin, doctors: doctor ? [doctor] : [] });
  const result: DoctorAvailabilityResult = { ...first, doctor: doctor || "(unspecified)" };
  if (!doctor) return { ...result, success: false, error: "no_mapping", detail: "doctor is required" };

  if (args.dateEnd && isValidDateStr(args.dateEnd) && isValidDateStr(args.date) && args.dateEnd > args.date) {
    const days: ClinicAvailabilityResult[] = [first];
    const start = new Date(`${args.date}T00:00:00Z`);
    const end = new Date(`${args.dateEnd}T00:00:00Z`);
    const span = Math.min(MAX_RANGE_DAYS - 1, Math.round((end.getTime() - start.getTime()) / 86_400_000));
    for (let i = 1; i <= span; i++) {
      const d = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      days.push(await getClinicAvailability(deps, ws, { date: d, durationMin: args.durationMin, doctors: [doctor] }));
    }
    result.days = days;
    result.success = days.some((x) => x.success);
  }
  return result;
}

// ---- Real service wiring ----------------------------------------------------

export const realAvailabilityDeps: AvailabilityDeps = {
  configured: googleCalendarConfigured,
  listDoctorCalendars: async (ws) => {
    try {
      // Day-2 columns first (migration 0066); when they don't exist yet the
      // select errors, so retry with the 0065 column set — deployments between
      // migrations keep working with clinic-timezone, non-test semantics.
      const extended = await supabase
        .from("doctor_calendars")
        .select("doctor_name, calendar_id, provider, active, timezone, is_test")
        .eq("workspace_id", ws);
      if (!extended.error) return { ok: true, rows: (extended.data ?? []) as DoctorCalendarRow[] };
      const { data, error } = await supabase
        .from("doctor_calendars")
        .select("doctor_name, calendar_id, provider, active")
        .eq("workspace_id", ws);
      if (error) {
        // Missing table (migration 0065 not applied) reads as a clear mapping
        // problem, never a crash or a silently empty clinic.
        return { ok: false, error: "doctor_calendars is not available (apply migration 0065 and configure doctor mappings)." };
      }
      return { ok: true, rows: (data ?? []) as DoctorCalendarRow[] };
    } catch {
      return { ok: false, error: "doctor_calendars lookup failed." };
    }
  },
  getClinicConfig: async (ws) => {
    try {
      const { data, error } = await supabase
        .from("clinic_settings")
        .select("timezone, open_time, close_time, slot_minutes, default_duration_min, closed_days")
        .eq("workspace_id", ws)
        .maybeSingle();
      if (!error && data) {
        return {
          timezone: (data as { timezone?: string }).timezone || DEFAULT_CLINIC_TZ,
          settings: normalizeSchedulingSettings(data),
        };
      }
    } catch { /* defaults below */ }
    return { timezone: DEFAULT_CLINIC_TZ, settings: DEFAULT_SCHEDULING };
  },
  freeBusy: (q) => freeBusyQuery(q),
  now: () => new Date(),
};
