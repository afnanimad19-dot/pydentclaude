// Pure scheduling helpers shared by the booking engine (booking-server.ts)
// and its tests. No database, no network — everything here is deterministic
// so timezone handling and overlap rules can be regression-tested directly.

// The clinic's "today" is its own wall-clock date, not the server's UTC date
// (a Dubai clinic is 4 hours ahead of UTC — between midnight Dubai and
// midnight UTC the two dates differ). en-CA formats as YYYY-MM-DD.
export function todayInTz(tz: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export const DEFAULT_CLINIC_TZ = process.env.CLINIC_TIMEZONE ?? "Asia/Dubai";

// Scheduling settings with safe defaults for every existing workspace: the
// clinic_settings columns behind them arrive with migration 0061 (NOT yet
// applied anywhere); until then — and for any workspace that never configures
// them — these defaults reproduce the historical 09:00–17:00 / 30-minute grid.
export interface SchedulingSettings {
  openTime: string;           // "HH:MM"
  closeTime: string;          // "HH:MM"
  slotMinutes: number;        // grid step for offered slots
  defaultDurationMin: number; // duration used when a booking doesn't specify one
  closedDays: string[];       // lowercase weekday names, e.g. ["sunday"]
}

export const DEFAULT_SCHEDULING: SchedulingSettings = {
  openTime: "09:00",
  closeTime: "17:00",
  slotMinutes: 30,
  defaultDurationMin: 30,
  closedDays: [],
};

export function normalizeSchedulingSettings(raw: unknown): SchedulingSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const time = (v: unknown, def: string) => (/^\d{2}:\d{2}$/.test(String(v ?? "")) ? String(v) : def);
  const num = (v: unknown, def: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : def;
  };
  const days = String(r.closed_days ?? r.closedDays ?? "")
    .split(/[,\s]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const s: SchedulingSettings = {
    openTime: time(r.open_time ?? r.openTime, DEFAULT_SCHEDULING.openTime),
    closeTime: time(r.close_time ?? r.closeTime, DEFAULT_SCHEDULING.closeTime),
    slotMinutes: num(r.slot_minutes ?? r.slotMinutes, DEFAULT_SCHEDULING.slotMinutes, 5, 120),
    defaultDurationMin: num(r.default_duration_min ?? r.defaultDurationMin, DEFAULT_SCHEDULING.defaultDurationMin, 5, 240),
    closedDays: days,
  };
  if (timeToMinutes(s.closeTime) <= timeToMinutes(s.openTime)) return { ...s, openTime: DEFAULT_SCHEDULING.openTime, closeTime: DEFAULT_SCHEDULING.closeTime };
  return s;
}

export function timeToMinutes(t: string): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t ?? "").trim());
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Appointment duration in minutes: the stored value when sane, else the
// schema's historical default of 60 (rows Pydent inserted before durations
// were handled carry the DB default).
export function apptDuration(v: unknown, fallback = 60): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 5 && n <= 480 ? Math.round(n) : fallback;
}

export function clampDuration(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 5 && n <= 240 ? Math.round(n) : def;
}

export function rangesOverlap(startA: number, durA: number, startB: number, durB: number): boolean {
  return startA < startB + durB && startB < startA + durA;
}

// Loose provider match, so "Dr. Anmol", "Anmol Batria" and "Dr. Anmol Batria"
// count as the same doctor when checking clashes.
export function sameProvider(a?: string | null, b?: string | null): boolean {
  const x = String(a ?? "").toLowerCase().replace(/^dr\.?\s*/, "").trim();
  const y = String(b ?? "").toLowerCase().replace(/^dr\.?\s*/, "").trim();
  if (!x && !y) return true; // both unassigned → same "slot owner"
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

export interface BookedSlot {
  time: string;
  provider?: string | null;
  duration_min?: unknown;
}

// Would an appointment at `time` for `durationMin` minutes overlap any booked
// appointment FOR THE SAME PROVIDER? Duration-aware: a 60-minute cleaning at
// 10:00 blocks 10:30, not only 10:00.
export function conflictsWithBooked(booked: BookedSlot[], time: string, durationMin: number, doctor?: string | null): boolean {
  const start = timeToMinutes(time);
  return booked.some((b) => {
    if (!sameProvider(b.provider, doctor)) return false;
    return rangesOverlap(start, durationMin, timeToMinutes(String(b.time ?? "")), apptDuration(b.duration_min));
  });
}

// Grid of open start times for one day under the given settings.
export function openSlotsForDay(
  booked: BookedSlot[],
  settings: SchedulingSettings,
  opts: { doctor?: string | null; durationMin?: number; weekday?: string }
): string[] {
  if (opts.weekday && settings.closedDays.includes(opts.weekday.toLowerCase())) return [];
  const dur = opts.durationMin ?? settings.defaultDurationMin;
  const open: string[] = [];
  const close = timeToMinutes(settings.closeTime);
  for (let m = timeToMinutes(settings.openTime); m + dur <= close; m += settings.slotMinutes) {
    const t = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    if (!conflictsWithBooked(booked, t, dur, opts.doctor)) open.push(t);
  }
  return open;
}

// Weekday name (lowercase English) of a YYYY-MM-DD date in a timezone.
export function weekdayInTz(date: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(new Date(`${date}T12:00:00Z`)).toLowerCase();
  } catch {
    return "";
  }
}
