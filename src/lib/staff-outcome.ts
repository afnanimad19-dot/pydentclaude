// Staff-confirmed Call Outcome (Stage B) — pure logic for the classification
// clinic staff attach to a call on the Call Details page.
//
// Separation of concerns (kept strictly):
//  - `voice_calls.outcome` stays the ENGINE's verdict (Vapi successEvaluation);
//  - `voice_calls.structured_data` stays AI extraction / worker tool data;
//  - staff classification lives in its own staff_outcome* columns, written
//    ONLY by the authenticated outcome route. buildStaffOutcomeUpdate is the
//    single source of that update payload, so tests can pin down that a staff
//    save touches staff columns and nothing else.
//
// Workspace authorization is the same ownership rule as the summary retry
// (signed-in user, call must belong to their workspace, foreign ids read as
// 404): the generic check from call-summary.ts is reused under a local name.

import { authorizeSummaryRetry, type RetryAuthDeps, type RetryAuthResult } from "@/lib/call-summary";

export const STAFF_OUTCOMES = ["potential", "non_potential", "closed", "cold_lead", "others"] as const;
export type StaffOutcome = (typeof STAFF_OUTCOMES)[number];

export const STAFF_OUTCOME_LABELS: Record<StaffOutcome, string> = {
  potential: "Potential",
  non_potential: "Non-Potential",
  closed: "Closed",
  cold_lead: "Cold Lead",
  others: "Others",
};

export const STAFF_NOTE_MAX = 2000;

/** The exact voice_calls columns a staff-outcome save writes — nothing else. */
export interface StaffOutcomeUpdate {
  staff_outcome: StaffOutcome;
  staff_outcome_note: string;
  staff_outcome_by: string;
  staff_outcome_at: string;
}

export interface StaffOutcomeInput {
  outcome: StaffOutcome;
  note: string;
}

/** Validate the request body: the outcome must be one of the five canonical
 *  values (anything else — labels, casing, empty — is rejected so the API
 *  fails loudly instead of storing junk); the note is optional, trimmed and
 *  length-capped. */
export function validateStaffOutcome(body: unknown): { ok: true; value: StaffOutcomeInput } | { ok: false; error: string } {
  const b = (body && typeof body === "object" ? body : {}) as { outcome?: unknown; note?: unknown };
  const outcome = typeof b.outcome === "string" ? b.outcome : "";
  if (!(STAFF_OUTCOMES as readonly string[]).includes(outcome)) {
    return { ok: false, error: `outcome must be one of: ${STAFF_OUTCOMES.join(", ")}.` };
  }
  if (b.note !== undefined && b.note !== null && typeof b.note !== "string") {
    return { ok: false, error: "note must be a string." };
  }
  const note = String(b.note ?? "").trim();
  if (note.length > STAFF_NOTE_MAX) return { ok: false, error: `note must be at most ${STAFF_NOTE_MAX} characters.` };
  return { ok: true, value: { outcome: outcome as StaffOutcome, note } };
}

/** Compose the update payload: classification + note + who + when. */
export function buildStaffOutcomeUpdate(
  input: StaffOutcomeInput,
  editor: { email?: string | null; id: string },
  now: Date = new Date()
): StaffOutcomeUpdate {
  return {
    staff_outcome: input.outcome,
    staff_outcome_note: input.note,
    staff_outcome_by: String(editor.email ?? "").trim() || editor.id,
    staff_outcome_at: now.toISOString(),
  };
}

/** Same signed-in + workspace-ownership rule as the AI-summary retry. */
export const authorizeStaffOutcome: (
  deps: RetryAuthDeps,
  token: string | null | undefined,
  callId: string
) => Promise<RetryAuthResult> = authorizeSummaryRetry;
