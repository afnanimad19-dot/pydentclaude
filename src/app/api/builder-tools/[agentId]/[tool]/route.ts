// HTTP endpoint for LiveKit Builder HTTP Actions (Tools → Add tool → HTTP).
//
// Builder sends tool parameters as a FLAT JSON body (no nesting, no fixed
// fields), so the agent id and tool name live in the path:
//   POST /api/builder-tools/<pydent agent uuid>/<tool>
//   Authorization: Bearer {{secrets.PYDENT_TOOL_KEY}}   (the worker token)
//
// All decisions — authentication, workspace matching, enabled-tool gating,
// exact-appointment validation, truthful structured responses — live in
// src/lib/builder-tools.ts; this file only wires the real services and logs
// agent/tool/status/latency (never credentials, arguments, or patient details).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { resolveWorkerToken } from "@/lib/livekit";
import {
  getSlotsStructured,
  bookAppointmentStructured,
  findExistingPatientId,
  listUpcomingAppointments,
  findAppointmentRef,
  rescheduleApptRow,
  cancelApptRow,
} from "@/lib/booking-server";
import { lookupPatientCore, createPatientCore, searchKnowledgeCore, getPatientById } from "@/lib/agent-tools-core";
import { sendAgentEmailDetailed } from "@/lib/email-send";
import { handleBuilderToolRequest, type BuilderToolDeps, type BuilderAgentRow } from "@/lib/builder-tools";

export const runtime = "nodejs";

const deps: BuilderToolDeps = {
  resolveToken: resolveWorkerToken,
  getSlots: getSlotsStructured,
  book: bookAppointmentStructured,
  findPatientId: findExistingPatientId,
  getPatient: getPatientById,
  listUpcoming: listUpcomingAppointments,
  findAppointment: findAppointmentRef,
  rescheduleRow: rescheduleApptRow,
  cancelRow: cancelApptRow,
  lookupPatient: lookupPatientCore,
  createPatient: createPatientCore,
  searchKnowledge: (agent, a) => searchKnowledgeCore(agent, a, "builder-http"),
  sendEmail: sendAgentEmailDetailed,
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ agentId: string; tool: string }> }) {
  const started = Date.now();
  const { agentId, tool } = await ctx.params;

  // Empty body → no arguments; anything non-empty must be valid JSON.
  let args: unknown = {};
  const raw = await req.text().catch(() => "");
  if (raw.trim()) {
    try {
      args = JSON.parse(raw);
    } catch {
      return NextResponse.json({ success: false, error: "Request body must be valid JSON." }, { status: 400 });
    }
  }

  // Skip the DB entirely for requests with no credentials at all;
  // handleBuilderToolRequest answers 401 before revealing whether the agent
  // exists either way.
  const authHeader = req.headers.get("authorization") ?? req.headers.get("x-pydent-token");
  let agent: BuilderAgentRow | null = null;
  if (authHeader) {
    const { data } = await supabase
      .from("agents")
      .select("id, name, workspace_id, voice_settings, can_book, can_reschedule, can_cancel, knowledge_base")
      .eq("id", agentId)
      .maybeSingle()
      .then((r) => r, () => ({ data: null }));
    agent = (data as BuilderAgentRow | null) ?? null;
  }

  const out = await handleBuilderToolRequest(deps, { authHeader, agent, tool, args });

  console.log(
    `[builder-tools] agent=${String(agentId).slice(0, 40)} tool=${String(tool).slice(0, 40)} status=${out.status} ok=${out.body.success === true} ms=${Date.now() - started}`
  );
  return NextResponse.json(out.body, { status: out.status });
}
