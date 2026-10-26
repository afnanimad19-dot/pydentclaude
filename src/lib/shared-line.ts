// Shared FXO line controller (Phase 2B) — pure decision logic, no I/O.
//
// The clinic has exactly ONE analog line (D-Link DVX-2005F Trunk1, FXO port 1,
// +971 4 398 5241). It carries production INBOUND calls (Etisalat → D-Link →
// Raspberry Pi Asterisk → LiveKit → Laura) and, in this phase, Pydent OUTBOUND
// campaign calls. One analog loop cannot carry two calls, and the carrier line
// gives us NO reliable machine-readable availability signal today, so every
// rule here FAILS CLOSED:
//
//   * UNKNOWN is never treated as idle. The line is dialable only in the
//     exact state "idle", and "idle" is reachable only through a FRESH
//     observation from a TRUSTED source (today: an operator attestation made
//     seconds before a supervised call; a D-Link read-only status API is a
//     documented, unverified future source).
//   * Inbound has absolute scheduling priority: any live inbound call blocks
//     outbound admission. (Software cannot PREEMPT the analog line — see
//     docs/phase2b-shared-fxo — it can only refuse to occupy it.)
//   * A database reservation is a SCHEDULING control, not proof of physical
//     line availability; the physical check is a separate, explicit input.
//
// shared-line-server.ts binds Supabase + the existing outbound dialer to these
// rules. This file deliberately imports nothing with secrets or network access.

// ── line state model ─────────────────────────────────────────────────────────

export const SHARED_LINE_STATES = [
  "idle",
  "inbound_active",
  "outbound_reserved",
  "outbound_dialing",
  "outbound_active",
  "cooldown",
  "unknown",
  "unavailable",
] as const;
export type SharedLineState = (typeof SHARED_LINE_STATES)[number];

/** Sources whose "idle" observation may admit an outbound call. 'dlink_api'
 *  is deliberately ABSENT until a supported, authenticated, read-only D-Link
 *  FXO-state interface has been verified on the real hardware (deliverable K). */
export const TRUSTED_LINE_OBSERVATION_SOURCES = ["operator_attested"] as const;

/** How long a trusted idle observation stays fresh. Short on purpose: the
 *  line's state can change the moment a patient dials in. */
export const DEFAULT_OBSERVATION_TTL_SECONDS = 120;

/** Post-call quiet period before the next outbound admission: lets the FXO
 *  loop settle (disconnect supervision on analog lines is slow) and gives
 *  inbound callers a window. */
export const DEFAULT_COOLDOWN_SECONDS = 60;

/** A 'reserved' reservation that has not started dialing within this TTL is
 *  reclaimable (worker crash / abandoned attempt). */
export const RESERVATION_TTL_SECONDS = 120;

/** TTL once a call is in flight — longer than the proposed Asterisk
 *  absolute max call duration (15 min) so expiry can never race a real call. */
export const ACTIVE_RESERVATION_TTL_SECONDS = 25 * 60;

/** A live INBOUND voice_calls row younger than this blocks outbound. Wide on
 *  purpose (fail closed): a stale row blocks calls, never permits them. */
export const INBOUND_LIVE_WINDOW_MIN = 60;

export interface LineObservationInput {
  /** Last observed physical state as recorded ('idle', 'unavailable', …). */
  state: string;
  /** ISO timestamp of the observation; null = never observed. */
  at: string | null;
  /** Who observed it (must be in TRUSTED_LINE_OBSERVATION_SOURCES to count). */
  source: string;
  ttlSeconds: number;
}

/** True only for a FRESH 'idle' observation from a TRUSTED source. A missing,
 *  stale, future-dated or untrusted observation NEVER verifies idle. */
export function observationVerifiesIdle(o: LineObservationInput, now: Date = new Date()): boolean {
  if (String(o.state) !== "idle") return false;
  if (!(TRUSTED_LINE_OBSERVATION_SOURCES as readonly string[]).includes(String(o.source))) return false;
  if (!o.at) return false;
  const at = Date.parse(o.at);
  if (!Number.isFinite(at)) return false;
  const ageMs = now.getTime() - at;
  const ttl = Number(o.ttlSeconds) > 0 ? Number(o.ttlSeconds) : DEFAULT_OBSERVATION_TTL_SECONDS;
  // A future-dated observation is invalid, not "extra fresh" (clock skew must
  // fail closed, within a small tolerance for same-host jitter).
  return ageMs >= -5_000 && ageMs <= ttl * 1_000;
}

export interface DeriveLineStateInput {
  /** shared_lines.maintenance — staff switch; blocks everything. */
  maintenance: boolean;
  /** Live inbound LiveKit calls for this workspace right now. */
  liveInboundCalls: number;
  /** Status of the line's single active reservation ('' = none). */
  activeReservationStatus: "" | "reserved" | "dialing" | "active";
  /** shared_lines.cooldown_until (ISO) — quiet period after a call ends. */
  cooldownUntil: string | null;
  observation: LineObservationInput;
  now?: Date;
}

/**
 * Deterministic state derivation, in strict precedence order:
 *   unavailable (maintenance) > inbound_active > outbound_* (reservation) >
 *   cooldown > idle (verified only) > unknown.
 * The same inputs always give the same state, so every admission decision is
 * reproducible from the audit record.
 */
export function deriveLineState(i: DeriveLineStateInput): SharedLineState {
  const now = i.now ?? new Date();
  if (i.maintenance) return "unavailable";
  if (i.liveInboundCalls > 0) return "inbound_active";
  if (i.activeReservationStatus === "reserved") return "outbound_reserved";
  if (i.activeReservationStatus === "dialing") return "outbound_dialing";
  if (i.activeReservationStatus === "active") return "outbound_active";
  if (i.cooldownUntil) {
    const until = Date.parse(i.cooldownUntil);
    if (Number.isFinite(until) && until > now.getTime()) return "cooldown";
  }
  if (observationVerifiesIdle(i.observation, now)) return "idle";
  return "unknown";
}

// ── admission (the shared-line gate; runs BEFORE the campaign dial gate) ─────

export type LineAdmissionRefusal =
  | "line_maintenance"
  | "inbound_active"
  | "line_busy_outbound"
  | "line_cooldown"
  | "line_state_unknown"
  | "line_unavailable";

/** Outbound admission: the line must be in EXACTLY the state "idle". Every
 *  other state — including unknown — refuses (fail closed). */
export function lineAdmission(state: SharedLineState): { ok: true } | { ok: false; reason: LineAdmissionRefusal } {
  const no = (reason: LineAdmissionRefusal) => ({ ok: false as const, reason });
  switch (state) {
    case "idle":
      return { ok: true };
    case "inbound_active":
      return no("inbound_active");
    case "outbound_reserved":
    case "outbound_dialing":
    case "outbound_active":
      return no("line_busy_outbound");
    case "cooldown":
      return no("line_cooldown");
    case "unavailable":
      return no("line_unavailable");
    default:
      return no("line_state_unknown");
  }
}

/**
 * The FINAL pre-dial re-check, run after a reservation is acquired (and the
 * one-shot attestation consumed) but before anything dials. It does not
 * require a fresh idle observation — the reservation holds the slot — but any
 * newly arrived blocker (inbound call, maintenance, cooldown, a competing
 * reservation that somehow holds the line) refuses and releases.
 */
export function preDialRecheck(i: {
  maintenance: boolean;
  liveInboundCalls: number;
  /** Another reservation (not ours) holds the line, or its state is unreadable. */
  otherReservationHolds: boolean;
  cooldownUntil: string | null;
  now?: Date;
}): { ok: true } | { ok: false; reason: LineAdmissionRefusal } {
  const no = (reason: LineAdmissionRefusal) => ({ ok: false as const, reason });
  const now = i.now ?? new Date();
  if (i.maintenance) return no("line_unavailable");
  if (i.liveInboundCalls > 0) return no("inbound_active");
  if (i.otherReservationHolds) return no("line_busy_outbound");
  if (i.cooldownUntil) {
    const until = Date.parse(i.cooldownUntil);
    if (Number.isFinite(until) && until > now.getTime()) return no("line_cooldown");
  }
  return { ok: true };
}

// ── destination policy (application copy; Asterisk enforces it AGAIN) ────────
// Approved calling policy for this phase: UAE MOBILE numbers only, in the
// canonical digits form (canonicalPhone output). Everything else — landlines,
// international, toll-free, short/emergency/special services, and the
// clinic's own number — is refused. The proposed [from-pydent-outbound]
// Asterisk context re-enforces the same policy at the telephony boundary; a
// number is never trusted merely because Pydent validated it.

/** Canonical UAE mobile: 971 + 5[0/2/4/5/6/8] + 7 digits. */
export const UAE_MOBILE_RE = /^9715[024568][0-9]{7}$/;

/** Canonical prefixes that are emergency / special / premium services. These
 *  rarely survive canonicalPhone, but are rejected explicitly anyway. */
export const SPECIAL_SERVICE_PREFIXES = ["999", "998", "997", "996", "995", "991", "992", "901", "112", "800", "600", "900"] as const;

export type DestinationRefusal = "invalid" | "own_number" | "special_service" | "not_uae_mobile";

export function outboundDestinationPolicy(
  canonical: string,
  ownNumbers: readonly string[]
): { ok: true; destClass: "uae_mobile" } | { ok: false; reason: DestinationRefusal } {
  const no = (reason: DestinationRefusal) => ({ ok: false as const, reason });
  const d = String(canonical ?? "");
  if (!/^[0-9]{7,15}$/.test(d)) return no("invalid");
  if (ownNumbers.some((n) => String(n) === d)) return no("own_number");
  if (SPECIAL_SERVICE_PREFIXES.some((p) => d.startsWith(p) || d.startsWith(`971${p}`))) return no("special_service");
  if (!UAE_MOBILE_RE.test(d)) return no("not_uae_mobile");
  return { ok: true, destClass: "uae_mobile" };
}

// ── reservations (scheduling control — never proof of line availability) ────

export const RESERVATION_STATUSES = ["reserved", "dialing", "active", "released", "expired", "failed"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** Statuses that hold the single per-line slot (the partial unique index). */
export const HOLDING_RESERVATION_STATUSES = ["reserved", "dialing", "active"] as const;

/** Legal reservation transitions — anything else is refused and audited. */
export const RESERVATION_TRANSITIONS: Record<ReservationStatus, readonly ReservationStatus[]> = {
  reserved: ["dialing", "released", "expired", "failed"],
  dialing: ["active", "released", "expired", "failed"],
  active: ["released"],
  released: [],
  expired: [],
  failed: [],
};

export function canTransitionReservation(from: string, to: string): boolean {
  const allowed = RESERVATION_TRANSITIONS[from as ReservationStatus];
  return Array.isArray(allowed) && (allowed as readonly string[]).includes(to);
}

/** Idempotency keys: 8–128 chars of safe characters; anything else is "" and
 *  the request is refused (an attempt without a usable key cannot dedupe). */
export function normalizeIdempotencyKey(v: unknown): string {
  const s = String(v ?? "").trim();
  return /^[A-Za-z0-9._:-]{8,128}$/.test(s) ? s : "";
}

export interface ReservationSweepInput {
  status: string;
  /** ISO expiry written when the reservation was created/last extended. */
  expiresAt: string | null;
  /** The reservation's call (by call_key) is verifiably still in progress. */
  callInProgress: boolean;
  /** The reservation's call is verifiably ENDED (voice_calls says so). */
  callEnded: boolean;
}

export type ReservationSweepAction = "keep" | "expire" | "extend" | "release_reconciled";

/**
 * What the cleanup sweep does with one reservation. Core invariant: an
 * expired TTL NEVER releases a reservation whose call is verifiably still in
 * progress — it extends instead ("never allow an expired reservation to
 * release an active call"). Crash cleanup therefore reclaims only
 * reservations with no live call behind them.
 */
export function reservationSweepAction(r: ReservationSweepInput, now: Date = new Date()): ReservationSweepAction {
  if (!(HOLDING_RESERVATION_STATUSES as readonly string[]).includes(String(r.status))) return "keep";
  if (r.status !== "reserved" && r.callEnded) return "release_reconciled"; // verified termination
  const exp = r.expiresAt ? Date.parse(r.expiresAt) : NaN;
  const expired = !Number.isFinite(exp) || exp <= now.getTime(); // unparseable expiry = expired (fail closed)
  if (!expired) return "keep";
  if (r.callInProgress) return "extend"; // in-flight call: never reclaimed by a timer
  return "expire";
}

/** A call-end event releases a reservation ONLY when it names that
 *  reservation's own call. A late or replayed event for an older call can
 *  never touch a newer reservation (different call_key), and terminal
 *  reservations are immutable. */
export function callEndReleases(r: { status: string; callKey: string }, endedCallKey: string): boolean {
  if (!(HOLDING_RESERVATION_STATUSES as readonly string[]).includes(String(r.status))) return false;
  const key = String(r.callKey ?? "");
  return !!key && key === String(endedCallKey ?? "");
}

// ── refusal surface (what the route reports) ─────────────────────────────────

export type SharedLineRefusal =
  | LineAdmissionRefusal
  | DestinationRefusal
  | "bad_idempotency_key"
  | "duplicate_request"
  | "reservation_conflict";
