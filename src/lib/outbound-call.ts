// LiveKit outbound campaign calls (Phase 2A) — pure decision/mapping logic.
//
// Every rule here FAILS CLOSED, in the approved order: a lead with no verified
// marketing eligibility is never dialed, an opted-out number is never dialed,
// and — because the mandatory opening discloses that the call IS recorded — a
// call whose recording cannot start is never placed either (the disclosure is
// kept true by construction, not by prompt luck; policy P2).
//
// Three consent facts stay separate and none is inferred from another:
//   marketing_eligible_at  — verified promotional-call eligibility (pre-dial);
//   opening_consent        — the recipient's recorded answer to the opening
//                            disclosure (post-answer, from the worker);
//   voice_dnc              — permanent opt-outs (survive campaign deletion).
// Recording consent/configuration is a fourth, independent concern (0063).
//
// outbound-call-server.ts binds LiveKit + Azure + Supabase to these rules.
// This file deliberately imports nothing with secrets or network access.

// ── gate (runs before ANY external call) ─────────────────────────────────────

/** Consecutive recording-blocked attempts that halt a campaign (policy P2). */
export const RECORDING_HALT_THRESHOLD = 3;

/** status_detail written when recording infrastructure refused pre-dial. */
export const RECORDING_BLOCK_DETAIL = "recording_unavailable";

export type OutboundRefusal =
  | "campaign_not_outbound"
  | "campaign_not_active"
  | "campaign_not_approved"
  | "campaign_halted"
  | "lead_not_pending"
  | "not_marketing_eligible"
  | "do_not_call"
  | "external_agent"
  | "no_outbound_trunk"
  | "recording_unavailable"
  | "another_call_live";

export interface OutboundGateInput {
  campaign: {
    direction: string;
    status: string;
    /** The explicit human approval (campaigns.approved_at). */
    approvedAt: string | null;
    haltedReason: string;
  };
  lead: {
    status: string;
    phone: string;
    /** Verified promotional-call eligibility — null = never dial. */
    marketingEligibleAt: string | null;
  };
  /** The lead's phone appears in voice_dnc. */
  dnc: boolean;
  /** The campaign's agent is bound to an external (console-built) LiveKit
   *  agent — the outbound opening/consent flow lives in the Pydent worker. */
  externalAgent: boolean;
  /** voice_numbers.livekit_outbound_trunk_id for the campaign's number. */
  outboundTrunkId: string;
  /** All three RECORDING_AZURE_* present (recording can be attempted). */
  recordingEnvReady: boolean;
  /** Live outbound LiveKit calls in this workspace right now. */
  liveOutboundCalls: number;
  /** Trailing consecutive recording-blocked attempts (see below). */
  consecutiveRecordingBlocks: number;
}

/** The fail-closed pre-dial gate. Checked in this order; first refusal wins. */
export function outboundCallGate(i: OutboundGateInput): { ok: true } | { ok: false; reason: OutboundRefusal } {
  const no = (reason: OutboundRefusal) => ({ ok: false as const, reason });
  if (i.campaign.direction !== "outbound") return no("campaign_not_outbound");
  if (i.campaign.status !== "active") return no("campaign_not_active");
  if (!i.campaign.approvedAt) return no("campaign_not_approved");
  if (i.campaign.haltedReason || i.consecutiveRecordingBlocks >= RECORDING_HALT_THRESHOLD) return no("campaign_halted");
  if (i.lead.status !== "pending") return no("lead_not_pending");
  if (!i.lead.marketingEligibleAt) return no("not_marketing_eligible");
  if (i.dnc) return no("do_not_call");
  if (i.externalAgent) return no("external_agent");
  if (!String(i.outboundTrunkId || "").trim()) return no("no_outbound_trunk");
  if (!i.recordingEnvReady) return no("recording_unavailable");
  if (i.liveOutboundCalls > 0) return no("another_call_live"); // single-call concurrency
  return { ok: true };
}

/** Refusals that mark the LEAD blocked (vs. leaving it pending for later).
 *  recording_unavailable blocks the lead too: each pre-dial recording refusal
 *  is a visible attempt that feeds the P2 halt streak instead of silently
 *  retrying forever. Campaign-state refusals leave the lead untouched. */
export function leadBlockDetailFor(reason: OutboundRefusal): string | null {
  if (reason === "not_marketing_eligible") return "not_marketing_eligible";
  if (reason === "do_not_call") return "do_not_call";
  if (reason === "recording_unavailable") return RECORDING_BLOCK_DETAIL;
  return null;
}

// ── campaign halt counting (policy P2) ───────────────────────────────────────

/**
 * Count the TRAILING consecutive attempts blocked/failed on recording, from
 * lead rows ordered most-recent-first. Any other outcome breaks the streak.
 */
export function consecutiveRecordingBlocks(
  recentFirst: readonly { status: string; statusDetail: string }[]
): number {
  let n = 0;
  for (const l of recentFirst) {
    if (l.status === "pending") continue; // never attempted — not part of the streak
    const recording = l.statusDetail === RECORDING_BLOCK_DETAIL || l.statusDetail === "recording_failed";
    if ((l.status === "blocked" || l.status === "failed") && recording) n += 1;
    else break;
  }
  return n;
}

// ── opening consent (requirement: tracked separately, recorded in Pydent) ────

export const OPENING_CONSENT_VALUES = ["accepted", "declined", "opt_out", "no_answer", "unclear"] as const;
export type OpeningConsent = (typeof OPENING_CONSENT_VALUES)[number];

/** Normalize a worker-reported opening outcome; anything else = "" (unset). */
export function normalizeOpeningConsent(v: unknown): OpeningConsent | "" {
  const s = String(v ?? "").trim().toLowerCase();
  return (OPENING_CONSENT_VALUES as readonly string[]).includes(s) ? (s as OpeningConsent) : "";
}

export interface LeadCallEndPatch {
  status: "done" | "failed";
  status_detail: string;
  opening_consent?: OpeningConsent;
  opening_consent_at?: string;
  /** The phone must be added to voice_dnc (permanent, campaign-independent). */
  dnc: boolean;
}

/** How a finished call updates its lead. Refusal/opt-out → permanent DNC. */
export function leadPatchForCallEnd(opts: {
  openingConsent: unknown;
  endedReason?: string;
  now?: string;
}): LeadCallEndPatch {
  const consent = normalizeOpeningConsent(opts.openingConsent);
  const patch: LeadCallEndPatch = {
    status: "done",
    status_detail: consent ? `opening:${consent}` : "",
    dnc: consent === "declined" || consent === "opt_out",
  };
  if (consent) {
    patch.opening_consent = consent;
    patch.opening_consent_at = opts.now ?? new Date().toISOString();
  }
  if (String(opts.endedReason ?? "").startsWith("no_answer")) {
    patch.status = "failed";
    patch.status_detail = "no_answer";
  }
  return patch;
}

// ── recording capture verification (acceptance requirement) ──────────────────

/**
 * The smallest blob that can plausibly hold any spoken audio. A COMPLETE
 * egress with fewer bytes means no usable audio was captured (e.g. instant
 * hangup or a one-sided stream) and is flagged, not accepted. NOTE: a size
 * check proves non-empty capture only — TWO-WAY audio is proven by a human
 * listening to the staged pilot recording, never by this number.
 */
export const MIN_CAPTURED_RECORDING_BYTES = 4096;

export function capturedRecordingOk(sizeBytes: number | null | undefined): boolean {
  return typeof sizeBytes === "number" && Number.isFinite(sizeBytes) && sizeBytes >= MIN_CAPTURED_RECORDING_BYTES;
}

// ── dispatch metadata shape (what the worker receives for an outbound call) ──

export interface OutboundDispatchMeta extends Record<string, unknown> {
  source: "campaign";
  campaignId: string;
  leadId: string;
  /** The number being dialed — the worker's call log echoes it as toPhone. */
  toPhone: string;
  outbound: true;
}

export function outboundDispatchExtra(campaignId: string, leadId: string, toPhone: string): OutboundDispatchMeta {
  return { source: "campaign", campaignId, leadId, toPhone, outbound: true };
}
