// Call Ending & Goodbye — pure settings/rules logic for the Voice Agent
// Builder's configurable call ending.
//
// This is Pydent-NATIVE configuration, deliberately separate from the
// `endCall` key (which preserves configuration imported from LiveKit Builder:
// conditions/finalResponse/deleteRoom/summary endpoint). Both can coexist;
// when this feature is ENABLED its generated rules take precedence in the
// compiled prompt, while the imported configuration stays stored untouched.
//
// Everything here is pure and dependency-free so normalization, prompt-rule
// generation and the silence-policy mapping are unit-testable. The worker
// receives the compiled result per call via /api/livekit/agent-config, so a
// save in the Builder changes the very next call — no sync step.

export interface ClosingMessages {
  /** General goodbye (empty = clinic-name default at compile time). */
  general: string;
  bookingConfirmed: string;
  bookingChanged: string;
  enquiry: string;
  unresolved: string;
}

export interface CallEndingSettings {
  /** Master switch. OFF for every existing agent until configured. */
  enabled: boolean;
  /** automatic: end when the caller is clearly finished; explicit: only on a
   *  clear goodbye / request to end; manual: never auto-terminate. */
  mode: "automatic" | "explicit" | "manual";
  messages: ClosingMessages;
  /** Ask "anything else?" once before ending — never when the caller already
   *  said they need nothing else. */
  confirmBeforeEnding: boolean;
  /** Seconds to wait AFTER the goodbye finished playing (0–3). */
  hangupDelaySec: number;
  /** End the call after this much caller inactivity (0 = disabled;
   *  15/30/45/60). A check-in always happens before a silence hang-up. */
  silenceTimeoutSec: number;
}

const MODES = ["automatic", "explicit", "manual"] as const;
export const HANGUP_DELAYS = [0, 1, 2, 3] as const;
export const SILENCE_TIMEOUTS = [0, 15, 30, 45, 60] as const;
const MESSAGE_MAX = 500;

export const CALL_ENDING_DEFAULT: CallEndingSettings = {
  enabled: false,
  mode: "explicit",
  messages: { general: "", bookingConfirmed: "", bookingChanged: "", enquiry: "", unresolved: "" },
  confirmBeforeEnding: true,
  hangupDelaySec: 1,
  silenceTimeoutSec: 0,
};

function msg(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, MESSAGE_MAX) : "";
}

function pick<T>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

/** Server-side validation-by-normalization (the same convention every other
 *  voice_settings key uses): anything malformed collapses to a safe value,
 *  and an agent saved before this feature existed reads as DISABLED. */
export function normalizeCallEnding(v: unknown): CallEndingSettings {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const m = (o.messages && typeof o.messages === "object" ? o.messages : {}) as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    mode: pick(o.mode, MODES, "explicit"),
    messages: {
      general: msg(m.general),
      bookingConfirmed: msg(m.bookingConfirmed),
      bookingChanged: msg(m.bookingChanged),
      enquiry: msg(m.enquiry),
      unresolved: msg(m.unresolved),
    },
    confirmBeforeEnding: o.confirmBeforeEnding !== false,
    hangupDelaySec: pick(Number(o.hangupDelaySec), HANGUP_DELAYS, 1),
    silenceTimeoutSec: pick(Number(o.silenceTimeoutSec), SILENCE_TIMEOUTS, 0),
  };
}

/** The default general goodbye, templated with the clinic's name at compile
 *  time (never hardcoded to one clinic in the repo). */
export function defaultGeneralGoodbye(clinicName?: string): string {
  const name = String(clinicName ?? "").trim();
  return name
    ? `Thank you for calling ${name}. Have a wonderful day!`
    : "Thank you for calling. Have a wonderful day!";
}

/** Messages the worker actually speaks: configured text, with the general
 *  goodbye defaulted from the clinic name when the admin left it empty. */
export function resolveClosingMessages(ce: CallEndingSettings, clinicName?: string): ClosingMessages {
  return { ...ce.messages, general: ce.messages.general || defaultGeneralGoodbye(clinicName) };
}

/**
 * Prompt rules injected into the compiled system prompt when the feature is
 * enabled. The LLM never speaks its own goodbye — it calls end_call with an
 * outcome and the WORKER speaks the exact configured message, waits for it to
 * finish, applies the hang-up delay and terminates. That keeps message text,
 * playout and disconnection deterministic.
 */
export function callEndingRules(ce: CallEndingSettings): string[] {
  if (!ce.enabled) return [];
  if (ce.mode === "manual") {
    return [
      "CALL ENDING: never end the call yourself — you have no end_call tool. When the caller is finished, thank them warmly and let THEM hang up.",
    ];
  }
  const rules: string[] = [];
  rules.push(
    ce.mode === "explicit"
      ? "CALL ENDING: end the call ONLY when the caller clearly says goodbye or clearly asks to end the call (\"that's all, goodbye\", \"no, I don't need anything else\", \"thank you, have a nice day\", \"okay, thank you so much\" as a clear wrap-up). A standalone \"thank you\" after an answer is NOT a goodbye — keep helping."
      : "CALL ENDING: when the caller clearly indicates the conversation is finished (a clear goodbye, or they confirm they need nothing else), end the call. A standalone \"thank you\" after an answer is NOT by itself the end — if it may just be politeness, continue normally."
  );
  if (ce.confirmBeforeEnding) {
    rules.push(
      "BEFORE ENDING: ask once whether the caller needs anything else — but NEVER ask if they already said they need nothing else, and never ask it twice in a call."
    );
  }
  rules.push(
    "TO END: first make sure nothing important is unfinished — a booking mid-way, an unanswered question, a promised action. If something is unclear, ask ONE clarifying question instead of ending. Then call the end_call tool with the outcome that matches the call (booking_confirmed only if a booking tool actually succeeded; booking_changed after a successful reschedule or cancellation; enquiry for an answered question; unresolved when follow-up is still needed; general otherwise). Do NOT speak a goodbye yourself — the system plays the clinic's configured closing message for you.",
    "IF THE CALLER SPEAKS during the closing message with a new request, the call stays open — continue helping them normally."
  );
  return rules;
}

/**
 * Map the silence-timeout setting onto the worker's existing lifecycle
 * limits. The caller ALWAYS gets a check-in ("Are you still there?") before a
 * silence hang-up, and 0 disables silence-based ending entirely. When the
 * feature is off, the legacy limits pass through unchanged.
 */
export interface LifecycleLimits {
  silenceBeforeCheck: number;
  maxCheckAttempts: number;
  maxSilenceDuration: number;
  maxCallMinutes: number;
}

const SILENCE_DISABLED_SECONDS = 24 * 60 * 60; // one day — effectively never

export function applySilencePolicy(limits: LifecycleLimits, ce: CallEndingSettings): LifecycleLimits {
  if (!ce.enabled) return limits;
  if (ce.silenceTimeoutSec > 0) {
    // Check in at half the timeout so the caller can respond before the cut.
    return {
      ...limits,
      silenceBeforeCheck: Math.max(5, Math.floor(ce.silenceTimeoutSec / 2)),
      maxCheckAttempts: Math.max(1, limits.maxCheckAttempts),
      maxSilenceDuration: ce.silenceTimeoutSec,
    };
  }
  // Disabled: silence never ends the call (check-ins become effectively moot).
  return { ...limits, maxSilenceDuration: SILENCE_DISABLED_SECONDS, maxCheckAttempts: 1_000_000 };
}
