import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { getSlots, bookAppointment, type BookingCtx } from "@/lib/booking-server";
import { sendAgentEmail } from "@/lib/email-send";
import {
  lookupPatientCore, lookupPatientSpoken,
  createPatientCore, createPatientSpoken,
  searchKnowledgeCore, searchKnowledgeSpoken,
} from "@/lib/agent-tools-core";
import { manageAppointmentFlow, listUpcomingFlow, voiceSpoken, type BuilderAgentRow } from "@/lib/builder-tools";
import { realBuilderToolDeps } from "@/lib/builder-tools-deps";

/* eslint-disable @typescript-eslint/no-explicit-any */
// search_knowledge / lookup_patient / create_patient — real backends for the
// tools the voice worker registers. The logic lives in lib/agent-tools-core.ts
// (shared with the Builder HTTP tool adapter); the *Spoken formatters return
// the exact strings this endpoint has always produced, so the worker's
// behaviour is unchanged.
async function searchKnowledge(agent: any, a: any): Promise<string> {
  return searchKnowledgeSpoken(await searchKnowledgeCore(agent, a, "voice"));
}

async function lookupPatient(agent: any, a: any): Promise<string> {
  return lookupPatientSpoken(await lookupPatientCore(agent.workspace_id ?? null, a));
}

async function createPatient(agent: any, a: any): Promise<string> {
  return createPatientSpoken(await createPatientCore(agent.workspace_id ?? null, agent.name, a));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// Executes one agent tool call from a live in-browser Grok voice session. The
// realtime model calls a function on the client; the browser posts it here so
// the actual booking/email runs server-side with the same code path as every
// other channel (Calendar + Open Dental + workflows).
export const runtime = "nodejs";

// Real service wiring for the shared appointment flows (same logic the
// Builder HTTP adapter runs; this endpoint renders the results as prose).
const workerDeps = realBuilderToolDeps("voice");

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function POST(req: NextRequest) {
  const { agentId, name, args } = await req.json().catch(() => ({}));
  if (!agentId || !name) return NextResponse.json({ error: "agentId and name are required." }, { status: 400 });

  const { data: agent } = await supabase.from("agents").select("*").eq("id", agentId).maybeSingle();
  if (!agent) return NextResponse.json({ error: "Agent not found." }, { status: 404 });

  const a: any = args ?? {};
  const ctx: BookingCtx = {
    ws: agent.workspace_id ?? null,
    patientId: null,
    name: String(a.name ?? ""),
    phone: String(a.phone ?? ""),
    source: "voice",
    bookedBy: agent.name,
  };

  let result: string;
  try {
    switch (name) {
      case "get_available_slots":
        result = await getSlots(ctx.ws, a);
        break;
      case "book_appointment":
        result = await bookAppointment(ctx, a);
        break;
      // Reschedule / cancel / list run the SAME Pydent-only flows as the
      // Builder HTTP adapter (exact appointment_id validated against the
      // patient and workspace; several upcoming appointments come back as
      // choices and nothing is auto-selected), rendered as voice prose.
      case "reschedule_appointment":
      case "cancel_appointment": {
        const out = await manageAppointmentFlow(workerDeps, agent as BuilderAgentRow, name, a);
        result = voiceSpoken(out.body);
        break;
      }
      case "list_upcoming_appointments": {
        const out = await listUpcomingFlow(workerDeps, agent as BuilderAgentRow, a);
        result = voiceSpoken(out.body);
        break;
      }
      case "send_email":
        result = await sendAgentEmail({ to: String(a.to ?? ""), subject: String(a.subject ?? ""), body: String(a.body ?? ""), ws: agent.workspace_id ?? undefined, fromName: agent.name });
        break;
      case "search_knowledge":
        result = await searchKnowledge(agent, a);
        break;
      case "lookup_patient":
        result = await lookupPatient(agent, a);
        break;
      case "create_patient":
        result = await createPatient(agent, a);
        break;
      default:
        result = "Unsupported tool.";
    }
  } catch (e) {
    result = `Error: ${e instanceof Error ? e.message : "tool failed"}`;
  }
  return NextResponse.json({ result });
}
