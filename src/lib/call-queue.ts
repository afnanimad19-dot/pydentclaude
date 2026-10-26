// Outbound call queue (Phase 4) — pure scheduling logic, no I/O.
//
// The queue never dials by itself: a due item is handed to the guarded path
// (campaign gates + shared FXO line controller), and this module only decides
// WHEN an item is eligible (calling hours, schedule, expiry) and WHAT happens
// after an attempt (retry with backoff vs. terminal). Everything fails
// closed: unparseable hours fall back to the conservative default window,
// and an outcome that is not explicitly retryable is terminal.

export const CALL_QUEUE_KINDS = ["campaign", "reminder", "confirmation", "followup", "callback", "outreach"] as const;
export type CallQueueKind = (typeof CALL_QUEUE_KINDS)[number];

export function normalizeCallKind(v: unknown): CallQueueKind | "" {
  const s = String(v ?? "").trim().toLowerCase();
  return (CALL_QUEUE_KINDS as readonly string[]).includes(s) ? (s as CallQueueKind) : "";
}

// ── calling hours ─────────────────────────────────────────────────────────────
// Conservative default for the clinic: Asia/Dubai wall clock, Monday–Saturday
// 09:00–18:00. A campaign can narrow or shift this via campaigns.calling_hours
// {tz, start, end, days}; malformed values fall back field-by-field.

export interface CallingHours {
  tz: string;
  start: string; // "HH:MM" inclusive
  end: string;   // "HH:MM" exclusive
  days: number[]; // 0=Sunday … 6=Saturday
}

export const DEFAULT_CALLING_HOURS: CallingHours = {
  tz: "Asia/Dubai",
  start: "09:00",
  end: "18:00",
  days: [1, 2, 3, 4, 5, 6],
};

const HHMM_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export function normalizeCallingHours(raw: unknown): CallingHours {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const tz = String(r.tz ?? "").trim() || DEFAULT_CALLING_HOURS.tz;
  const start = HHMM_RE.test(String(r.start ?? "")) ? String(r.start) : DEFAULT_CALLING_HOURS.start;
  const end = HHMM_RE.test(String(r.end ?? "")) ? String(r.end) : DEFAULT_CALLING_HOURS.end;
  const days = Array.isArray(r.days)
    ? r.days.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    : DEFAULT_CALLING_HOURS.days;
  return { tz, start, end, days: days.length ? days : DEFAULT_CALLING_HOURS.days };
}

/** Local wall-clock parts in the policy's timezone. Exported for tests. */
export function localParts(now: Date, tz: string): { day: number; minutes: number } | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
    const dayIdx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(parts.weekday));
    const minutes = Number(parts.hour) * 60 + Number(parts.minute);
    if (dayIdx < 0 || !Number.isFinite(minutes)) return null;
    return { day: dayIdx, minutes };
  } catch {
    return null; // unknown timezone: the gate below fails closed
  }
}

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** May an outbound call be placed RIGHT NOW under this policy? An unreadable
 *  clock/timezone refuses (fail closed). */
export function callingHoursGate(hours: CallingHours, now: Date = new Date()): { ok: true } | { ok: false; reason: "outside_calling_hours" } {
  const h = normalizeCallingHours(hours);
  const local = localParts(now, h.tz);
  if (!local) return { ok: false, reason: "outside_calling_hours" };
  if (!h.days.includes(local.day)) return { ok: false, reason: "outside_calling_hours" };
  const start = toMin(h.start);
  const end = toMin(h.end);
  if (end <= start) return { ok: false, reason: "outside_calling_hours" }; // inverted window: never call
  if (local.minutes < start || local.minutes >= end) return { ok: false, reason: "outside_calling_hours" };
  return { ok: true };
}

// ── queue item eligibility & retry policy ─────────────────────────────────────

export interface QueueItemInput {
  status: string;
  scheduledAt: string | null;
  notAfter: string | null;
  attempts: number;
  maxAttempts: number;
  retryBackoffMinutes: number;
}

export type QueueEligibility = "due" | "not_yet" | "expired" | "not_runnable";

export function queueItemEligibility(i: QueueItemInput, now: Date = new Date()): QueueEligibility {
  if (String(i.status) !== "scheduled") return "not_runnable";
  const at = i.scheduledAt ? Date.parse(i.scheduledAt) : NaN;
  if (!Number.isFinite(at)) return "not_runnable"; // unparseable schedule never runs
  if (i.notAfter) {
    const na = Date.parse(i.notAfter);
    if (Number.isFinite(na) && na <= now.getTime()) return "expired";
  }
  return at <= now.getTime() ? "due" : "not_yet";
}

/** Outcomes that justify ANOTHER attempt. Everything else is terminal: a
 *  reached human (whatever they answered), a DNC/eligibility block, or an
 *  unknown outcome never auto-redials. */
export const RETRYABLE_OUTCOMES = ["no_answer", "sip_failed"] as const;

export interface RetryDecision {
  action: "retry" | "done" | "failed" | "cancelled";
  nextAttemptAtMs?: number;
}

export function retryDecision(i: { attempts: number; maxAttempts: number; retryBackoffMinutes: number }, outcome: string, now: Date = new Date()): RetryDecision {
  const o = String(outcome ?? "").trim();
  if (o.startsWith("opening:") || o === "done") return { action: "done" }; // the person was reached
  if (o === "do_not_call" || o === "not_marketing_eligible" || o === "invalid_phone" || o.startsWith("destination_policy:")) {
    return { action: "cancelled" };
  }
  const retryable = (RETRYABLE_OUTCOMES as readonly string[]).includes(o);
  if (!retryable) return { action: "failed" };
  const attempts = Number(i.attempts) || 0;
  const max = Number(i.maxAttempts) > 0 ? Number(i.maxAttempts) : 1;
  if (attempts >= max) return { action: "failed" };
  const backoff = Number(i.retryBackoffMinutes) > 0 ? Number(i.retryBackoffMinutes) : 120;
  return { action: "retry", nextAttemptAtMs: now.getTime() + backoff * 60_000 };
}

/** Idempotency key for one queue attempt: stable per (item, attempt), so a
 *  crashed/retried runner can never double-dial the same attempt. */
export function queueAttemptIdempotencyKey(itemId: string, attempt: number): string {
  return `queue:${itemId}:a${attempt}`;
}
