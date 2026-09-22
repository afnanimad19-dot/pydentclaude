// The REAL service wiring for the Builder-tool flows (src/lib/builder-tools.ts
// stays pure). Shared by the Builder HTTP adapter route and the worker's
// tool-exec endpoint so both channels run the exact same Pydent-only logic.

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
import type { BuilderToolDeps } from "@/lib/builder-tools";

export function realBuilderToolDeps(channel: string): BuilderToolDeps {
  return {
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
    searchKnowledge: (agent, a) => searchKnowledgeCore(agent, a, channel),
    sendEmail: sendAgentEmailDetailed,
  };
}
