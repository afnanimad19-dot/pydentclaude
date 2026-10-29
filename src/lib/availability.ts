// Pure calendar-availability math shared by the Smart Scheduling service
// (availability-server.ts) and its tests. No database, no network — mirrors
// the src/lib/scheduling.ts convention so timezone handling, busy-interval
// merging and slot generation can be regression-tested directly.
//
// All interval arithmetic happens in epoch milliseconds (UTC instants);
// clinic-local wall-clock times are converted at the edges with Intl, so
// daylight-saving transitions in any future clinic timezone resolve to the
// real instants rather than naive offsets.

export interface BusyInterval {
  start: number; // epoch ms, inclusive
  end: number;   // epoch ms, exclusive
}

export interface AvailabilitySlot {
  start: string; // clinic-local "HH:MM"
  end: string;   // clinic-local "HH:MM"
}

// Offset of `tz` from UTC at the instant `at` (local − UTC, in ms).
function tzOffsetMs(tz: string, at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value])
  );
  // hour12:false can render midnight as "24".
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
  );
  return asUtc - at.getTime();
}

// The UTC instant of a wall-clock date+time in a timezone. Two-pass offset
// resolution so dates near a DST transition land on the correct instant
// (Asia/Dubai has no DST, but future clinics may).
export function zonedTimeToUtcMs(date: string, time: string, tz: string): number {
  const guess = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(guess)) return NaN;
  const off1 = tzOffsetMs(tz, new Date(guess));
  const ts = guess - off1;
  const off2 = tzOffsetMs(tz, new Date(ts));
  return off2 === off1 ? ts : guess - off2;
}

// Clinic-local "HH:MM" of a UTC instant.
export function formatTimeInTz(ms: number, tz: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value])
  );
  return `${String(Number(parts.hour) % 24).padStart(2, "0")}:${parts.minute}`;
}

// Parse Google FreeBusy busy entries ({start,end} RFC3339 strings) into epoch
// intervals, dropping anything malformed or empty rather than guessing.
export function parseBusyIntervals(raw: Array<{ start?: unknown; end?: unknown }> | undefined | null): BusyInterval[] {
  const out: BusyInterval[] = [];
  for (const b of raw ?? []) {
    const start = Date.parse(String(b?.start ?? ""));
    const end = Date.parse(String(b?.end ?? ""));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) out.push({ start, end });
  }
  return out;
}

// Merge overlapping AND adjacent busy intervals (10:00–10:30 + 10:30–11:00
// becomes 10:00–11:00) so free-window subtraction sees each blocked stretch once.
export function mergeBusyIntervals(busy: BusyInterval[]): BusyInterval[] {
  const sorted = [...busy].sort((a, b) => a.start - b.start);
  const out: BusyInterval[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else out.push({ ...b });
  }
  return out;
}

// Free windows inside [openMs, closeMs) after subtracting merged busy periods.
export function freeWindows(openMs: number, closeMs: number, busy: BusyInterval[]): BusyInterval[] {
  const merged = mergeBusyIntervals(busy);
  const out: BusyInterval[] = [];
  let cursor = openMs;
  for (const b of merged) {
    if (b.end <= cursor || b.start >= closeMs) continue;
    if (b.start > cursor) out.push({ start: cursor, end: Math.min(b.start, closeMs) });
    cursor = Math.max(cursor, b.end);
    if (cursor >= closeMs) break;
  }
  if (cursor < closeMs) out.push({ start: cursor, end: closeMs });
  return out;
}

export interface DayAvailabilityInput {
  date: string;        // clinic-local YYYY-MM-DD
  timezone: string;    // IANA, e.g. Asia/Dubai
  openTime: string;    // "HH:MM" clinic-local
  closeTime: string;   // "HH:MM" clinic-local
  slotMinutes: number; // start-time grid, e.g. 5
  durationMin: number; // requested appointment length
  busy: BusyInterval[];
}

// Available start times for one day: a grid anchored at opening time; a start
// is offered only when the FULL duration fits inside one free window (so an
// interval shorter than the requested duration yields nothing).
export function computeDaySlots(input: DayAvailabilityInput): AvailabilitySlot[] {
  const { date, timezone, slotMinutes, durationMin } = input;
  const openMs = zonedTimeToUtcMs(date, input.openTime, timezone);
  const closeMs = zonedTimeToUtcMs(date, input.closeTime, timezone);
  if (!Number.isFinite(openMs) || !Number.isFinite(closeMs) || closeMs <= openMs) return [];
  const windows = freeWindows(openMs, closeMs, input.busy);
  const durMs = durationMin * 60_000;
  const stepMs = Math.max(1, slotMinutes) * 60_000;
  const out: AvailabilitySlot[] = [];
  for (const w of windows) {
    // First grid point at or after the window start (grid anchored at opening).
    const firstStep = Math.ceil((w.start - openMs) / stepMs);
    for (let t = openMs + firstStep * stepMs; t + durMs <= w.end; t += stepMs) {
      out.push({ start: formatTimeInTz(t, timezone), end: formatTimeInTz(t + durMs, timezone) });
    }
  }
  return out;
}

// Is `tz` an IANA timezone Intl can resolve? Used to validate per-doctor
// timezone overrides before they ever reach slot math (an invalid stored
// value must fall back to the clinic timezone, never throw mid-request).
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isValidDateStr(d: unknown): d is string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d ?? ""))) return false;
  return Number.isFinite(Date.parse(`${d}T00:00:00Z`));
}
