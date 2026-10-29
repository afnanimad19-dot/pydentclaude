// Shared AI tool contracts for Smart Scheduling — ONE definition and ONE
// executor used by every channel (Laura Voice AI via /api/agents/tool-exec or
// the Builder HTTP adapter, and the WhatsApp agent via its webhook tool loop),
// so scheduling logic is never duplicated per channel.
//
// Day 1: the backend interfaces exist and are tested; production agent
// configurations (LiveKit workers, WhatsApp prompts) are NOT changed — a tool
// only runs when an agent's configuration later registers it.

import { getClinicAvailability, getDoctorAvailability, realAvailabilityDeps, type AvailabilityDeps, type ClinicAvailabilityResult, type DoctorAvailability } from "@/lib/availability-server";

export const SCHEDULING_TOOL_NAMES = ["check_doctor_availability", "find_available_doctors"] as const;
export type SchedulingToolName = (typeof SCHEDULING_TOOL_NAMES)[number];

// OpenAI-style function schemas, consumable by both the LiveKit voice worker's
// tool registration and the WhatsApp LLM tool list.
export const SCHEDULING_TOOL_CONTRACTS = [
  {
    name: "check_doctor_availability",
    description:
      "Check a specific doctor's open appointment start times on a date (optionally a short date range). Times are in the clinic's local timezone. Returns real calendar availability; if availability cannot be verified it says so instead of guessing.",
    parameters: {
      type: "object",
      properties: {
        doctor: { type: "string", description: "Doctor's name, e.g. 'Dr. Leila Hariri'" },
        date: { type: "string", description: "Requested date, YYYY-MM-DD (clinic-local)" },
        date_end: { type: "string", description: "Optional end of a date range, YYYY-MM-DD" },
        duration_min: { type: "number", description: "Appointment length in minutes (default: clinic's standard duration)" },
      },
      required: ["doctor", "date"],
    },
  },
  {
    name: "find_available_doctors",
    description:
      "Find which of the clinic's doctors have openings on a date, with their open start times (clinic-local). Use when the patient has no doctor preference.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Requested date, YYYY-MM-DD (clinic-local)" },
        duration_min: { type: "number", description: "Appointment length in minutes (default: clinic's standard duration)" },
      },
      required: ["date"],
    },
  },
] as const;

export interface SchedulingToolOutput {
  structured: ClinicAvailabilityResult;
  spoken: string; // sentence an agent can relay verbatim
}

const offerList = (slots: { start: string }[], max = 6) =>
  slots.slice(0, max).map((s) => s.start).join(", ") + (slots.length > max ? `, and ${slots.length - max} more` : "");

// Test-calendar mappings (doctor_calendars.is_test) must never read as
// confirmed clinical availability — the label travels with every sentence.
const TEST_NOTE = " [TEST calendar — demo data, not confirmed clinical availability]";

function spokenForDoctor(d: DoctorAvailability, date: string): string {
  const test = d.test ? TEST_NOTE : "";
  if (d.status === "closed") return `The clinic is closed on ${date}.`;
  if (d.status === "unavailable") return `I can't verify ${d.doctor}'s calendar right now, so I won't guess times — please try again shortly.`;
  if (!d.slots.length) return `${d.doctor} has no openings on ${date} — offer another day.${test}`;
  return `${d.doctor} is available on ${date} at: ${offerList(d.slots)}.${test}`;
}

// Executes one scheduling tool for an authenticated workspace. `ws` MUST come
// from the server-resolved tenant context (worker token / webhook / session) —
// never from AI-supplied arguments.
export async function executeSchedulingTool(
  ws: string,
  name: SchedulingToolName,
  args: Record<string, unknown>,
  deps: AvailabilityDeps = realAvailabilityDeps
): Promise<SchedulingToolOutput> {
  if (name === "check_doctor_availability") {
    const r = await getDoctorAvailability(deps, ws, {
      doctor: String(args.doctor ?? ""),
      date: String(args.date ?? ""),
      dateEnd: args.date_end ? String(args.date_end) : undefined,
      durationMin: args.duration_min,
    });
    const d = r.doctors[0];
    const spoken = r.success && d ? spokenForDoctor(d, r.date) : failureSpoken(r);
    return { structured: r, spoken };
  }

  // find_available_doctors
  const r = await getClinicAvailability(deps, ws, {
    date: String(args.date ?? ""),
    durationMin: args.duration_min,
  });
  let spoken: string;
  if (!r.success) spoken = failureSpoken(r);
  else {
    const open = r.doctors.filter((d) => d.status === "ok" && d.slots.length);
    const closed = r.doctors.every((d) => d.status === "closed");
    const unverified = r.doctors.filter((d) => d.status === "unavailable");
    if (closed) spoken = `The clinic is closed on ${r.date}.`;
    else if (!open.length) spoken = `No doctor has openings on ${r.date} — offer another day.`;
    else {
      spoken = `Available on ${r.date}: ` + open.map((d) => `${d.doctor} at ${offerList(d.slots, 4)}`).join("; ") + ".";
      if (unverified.length) spoken += ` (Could not verify: ${unverified.map((d) => d.doctor).join(", ")}.)`;
      if (open.some((d) => d.test)) spoken += TEST_NOTE;
    }
  }
  return { structured: r, spoken };
}

function failureSpoken(r: ClinicAvailabilityResult): string {
  switch (r.error) {
    case "invalid_date": return "Ask the patient for the date first (year, month and day).";
    case "no_mapping": return `I don't have a calendar configured for that doctor. ${r.detail ?? ""}`.trim();
    case "not_configured": return "Calendar availability isn't connected yet, so I can't check live times.";
    default: return "I couldn't verify the calendar right now, so I won't guess times — please try again shortly.";
  }
}
