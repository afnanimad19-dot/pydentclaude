// OpenDentalBookingConnector (M1D-A): the existing Open Dental integration
// exposed through the generic BookingConnector contract. This is a pure
// TRANSLATION layer over the EXISTING gateway (src/lib/opendental-gateway.ts)
// — it adds no second Open Dental integration, no new OD endpoints, and no
// production wiring: nothing outside the connector registry and tests calls
// it, and every legacy booking path keeps using the gateway directly,
// unchanged.
//
// Configuration compatibility: migrations 0065/0066 are not applied and OD
// credentials live where they always have (opendental_config, loaded
// server-side by the gateway itself, keyed by workspace). The adapter simply
// passes ctx.workspaceId to the existing gateway functions; it NEVER reads
// BookingConnection.config, never touches booking_connection_secrets, and
// never sees a credential — so none can leak through it.
//
// OD terminology stays INSIDE this file: the external system's identifiers
// cross the generic boundary only as opaque `externalId` strings, exactly as
// the contract requires.

import { odForward, getOdConfig } from "@/lib/opendental-gateway";
import {
  type BookingConnector,
  type BookingConnectorContext,
  type BookingConnectorCapabilities,
  type ConnectorResult,
  type ConnectorProvider,
  type ConnectorAppointment,
  type ConnectorAvailabilityRequest,
  type ConnectorAvailabilitySlot,
  type ConnectorEntityRef,
  type CreateConnectorAppointmentInput,
  type UpdateConnectorAppointmentInput,
  type ConnectorHealthResult,
  connectorFail,
} from "@/lib/booking-connectors/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

// What the CURRENT gateway actually supports (both modes: direct OD API and
// the local clinic middleware). Everything else is honestly false: the
// gateway has no schedule, operatory-listing, appointment-read, or sync
// operation, and M1D-A invents no OD endpoints.
export const OPENDENTAL_CAPABILITIES: BookingConnectorCapabilities = {
  providers: true,          // /doctors (GET /providers in direct mode)
  schedules: false,
  operatories: false,
  appointments: false,      // no read/pull path exists in the gateway
  availability: true,       // /available-slots (times only — see translation notes)
  createAppointment: true,  // /create-appointment (duration not transmitted — OD picks slot/op)
  updateAppointment: true,  // /reschedule-appointment (DATE/TIME ONLY)
  cancelAppointment: true,  // /cancel-appointment (OD "Break")
  sync: false,
};

// Injectable seams so tests run with fictional data and no network/database.
// Production always uses the real gateway functions.
export interface OpenDentalConnectorDeps {
  forward: typeof odForward;
  getConfig: typeof getOdConfig;
}
const REAL_DEPS: OpenDentalConnectorDeps = { forward: odForward, getConfig: getOdConfig };

// ── Context guard (registry validates too; the adapter preserves it) ────────
function badCtx(ctx: BookingConnectorContext | null | undefined): boolean {
  return !String(ctx?.workspaceId ?? "").trim() || !String(ctx?.connectionId ?? "").trim();
}
const CTX_ERROR = "A workspace id and connection id are required.";

// ── Error translation ───────────────────────────────────────────────────────
// Gateway outcomes → generic connector errors. Auth/config/unreachable cases
// use FIXED adapter messages (never upstream text); only generic external
// errors carry a short, scrubbed upstream detail. Nothing here can contain a
// credential: the gateway's own error strings never include key values, and
// we additionally strip ODFHIR authorization fragments and cap the length.
export function scrubUpstreamDetail(v: unknown): string {
  return String(v ?? "")
    .replace(/ODFHIR\s+\S+/gi, "ODFHIR [redacted]")
    .slice(0, 160);
}

function mapGatewayError<T>(status: number, data: any): ConnectorResult<T> {
  const detail = typeof data?.error === "string" ? data.error : "";
  if (status === 401 || status === 403) {
    return connectorFail<T>("auth_failed", "Open Dental rejected the configured API credentials.");
  }
  if (status === 400 && /not connected/i.test(detail)) {
    return connectorFail<T>("config_missing", "Open Dental is not configured for this workspace.");
  }
  if (status === 400 && /turned off/i.test(detail)) {
    return connectorFail<T>("unavailable", "The Open Dental connection is disabled in this workspace's settings.");
  }
  if (status === 502) {
    return connectorFail<T>("unavailable", `Open Dental could not be reached: ${scrubUpstreamDetail(detail) || "network failure"}.`);
  }
  return connectorFail<T>("external_error", `Open Dental returned HTTP ${status}${detail ? `: ${scrubUpstreamDetail(detail)}` : ""}.`);
}

// ── DTO translation (pure, exported for tests) ──────────────────────────────

// Gateway doctor row ({id, name, specialty?|services?}) → generic provider.
// The OD identity (a ProvNum in direct mode, the middleware's doctor id in
// connector mode) becomes the opaque externalId; pydentProviderId stays null
// until external_mappings are wired (later milestone).
export function odDoctorToConnectorProvider(d: any): ConnectorProvider {
  return {
    pydentProviderId: null,
    externalId: d?.id != null ? String(d.id) : null,
    name: String(d?.name ?? "").trim() || "Unknown provider",
    specialty: String(d?.specialty ?? ""),
    bookingEnabled: true, // the gateway only returns bookable (non-hidden) doctors
  };
}

// Gateway slot times (["HH:MM", …]) → generic slots. The gateway reports
// start times only, so durationMin echoes the request (or null) and provider
// echoes the requested provider — PARTIAL fidelity, documented.
export function odSlotsToAvailability(slots: unknown, req: ConnectorAvailabilityRequest): ConnectorAvailabilitySlot[] {
  if (!Array.isArray(slots)) return [];
  return slots
    .map((t) => String(t ?? "").slice(0, 5))
    .filter((t) => /^\d{2}:\d{2}$/.test(t))
    .map((time) => ({
      date: req.date,
      time,
      durationMin: req.durationMin ?? null,
      provider: req.provider ?? null,
      operatory: null, // the gateway does not expose operatory identity
    }));
}

// Generic create input → the EXISTING gateway body shape (unchanged since
// booking-server.ts uses the same one). durationMin is NOT transmitted — the
// current gateway/OD path has no duration parameter (OD derives the slot).
export function createInputToOdBody(input: CreateConnectorAppointmentInput): Record<string, unknown> {
  return {
    name: String(input.patient?.name ?? "").trim(),
    phone: String(input.patient?.phone ?? "").trim(),
    email: String(input.patient?.email ?? "").trim(),
    doctorId: String(input.provider?.externalId ?? ""),
    serviceId: String(input.service ?? "").trim(),
    datetime: `${input.date}T${input.time}`,
    consent: true,
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// ── The adapter ─────────────────────────────────────────────────────────────

export function createOpenDentalConnector(deps: OpenDentalConnectorDeps = REAL_DEPS): BookingConnector {
  const unsupported = <T>(op: string): Promise<ConnectorResult<T>> =>
    Promise.resolve(connectorFail<T>("unsupported_capability", `The Open Dental connector does not support ${op}: the existing gateway has no such operation.`));

  // The one OD appointment reference the gateway understands: its own
  // appointment id, carried generically as externalId. A pydentId-only
  // reference cannot be resolved until external mappings are wired.
  const externalApptId = (ref: ConnectorEntityRef | null | undefined): string | null => {
    const ext = String(ref?.externalId ?? "").trim();
    return ext || null;
  };

  return {
    type: "opendental",

    getCapabilities: () => ({ ...OPENDENTAL_CAPABILITIES }),

    async testConnection(ctx): Promise<ConnectorResult<ConnectorHealthResult>> {
      if (badCtx(ctx)) return connectorFail("invalid_request", CTX_ERROR);
      // Read-only by construction: config lookup + the gateway's /health
      // (which in direct-OD-API mode maps to GET /providers). No writes.
      const cfg = await deps.getConfig(ctx.workspaceId);
      if (!cfg) return connectorFail("config_missing", "Open Dental is not configured for this workspace.");
      if (!cfg.enabled) return connectorFail("unavailable", "The Open Dental connection is disabled in this workspace's settings.");
      const r = await deps.forward(ctx.workspaceId, "/health", { method: "GET" });
      if (r.status === 200) {
        return { ok: true, data: { reachable: true, authenticated: true, detail: "Open Dental answered a read-only health check." } };
      }
      return mapGatewayError(r.status, r.data);
    },

    async getProviders(ctx): Promise<ConnectorResult<ConnectorProvider[]>> {
      if (badCtx(ctx)) return connectorFail("invalid_request", CTX_ERROR);
      const r = await deps.forward(ctx.workspaceId, "/doctors", { method: "GET" });
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      const doctors = (r.data as any)?.doctors;
      if (r.status === 200 && Array.isArray(doctors)) {
        return { ok: true, data: doctors.map(odDoctorToConnectorProvider) };
      }
      return mapGatewayError(r.status, r.data);
    },

    getSchedules: () => unsupported("schedules"),
    getOperatories: () => unsupported("operatories"),
    getAppointments: () => unsupported("reading appointments"),
    sync: () => unsupported("synchronization"),

    async getAvailability(ctx, req): Promise<ConnectorResult<ConnectorAvailabilitySlot[]>> {
      if (badCtx(ctx)) return connectorFail("invalid_request", CTX_ERROR);
      const date = String(req?.date ?? "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return connectorFail("invalid_request", "A date (YYYY-MM-DD) is required.");
      // Provider identity is exact or absent — never fuzzy-matched here. A
      // reference with no external identity cannot be sent to Open Dental
      // until external mappings are wired.
      if (req.provider && !String(req.provider.externalId ?? "").trim() && String(req.provider.pydentId ?? "").trim()) {
        return connectorFail("provider_not_found", "This provider has no Open Dental identity mapped yet.");
      }
      const r = await deps.forward(ctx.workspaceId, "/available-slots", {
        method: "POST",
        body: { doctorId: String(req.provider?.externalId ?? ""), serviceId: String(req.service ?? ""), date },
      });
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      const slots = (r.data as any)?.slots;
      if (r.status === 200 && Array.isArray(slots)) {
        return { ok: true, data: odSlotsToAvailability(slots, { ...req, date }) };
      }
      return mapGatewayError(r.status, r.data);
    },

    async createAppointment(ctx, input): Promise<ConnectorResult<ConnectorAppointment>> {
      if (badCtx(ctx)) return connectorFail("invalid_request", CTX_ERROR);
      const date = String(input?.date ?? "").slice(0, 10);
      const time = String(input?.time ?? "").slice(0, 5);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
        return connectorFail("invalid_request", "A date (YYYY-MM-DD) and time (HH:MM) are required.");
      }
      if (!String(input.patient?.name ?? "").trim() && !String(input.patient?.phone ?? "").trim()) {
        return connectorFail("invalid_request", "The patient needs at least a name or phone so Open Dental can find or create the record.");
      }
      if (input.provider && !String(input.provider.externalId ?? "").trim() && String(input.provider.pydentId ?? "").trim()) {
        return connectorFail("provider_not_found", "This provider has no Open Dental identity mapped yet.");
      }
      const r = await deps.forward(ctx.workspaceId, "/create-appointment", {
        method: "POST",
        body: createInputToOdBody({ ...input, date, time }),
      });
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      const extId = (r.data as any)?.appointmentId;
      if (r.status === 200 && extId) {
        // The gateway returns only the new external id. date/time, service,
        // provider and patient are ECHOES of the request Open Dental just
        // accepted (they were transmitted in the body). durationMin is NULL,
        // honestly: the existing gateway has no duration parameter, so the
        // requested duration never reached Open Dental and the external
        // appointment's duration is unknown here. The Pydent row (M1D-B)
        // remains the source of truth for duration.
        return {
          ok: true,
          data: {
            pydentAppointmentId: null,
            externalId: String(extId),
            date,
            time,
            durationMin: null,
            provider: input.provider ?? {},
            operatory: null,
            service: String(input.service ?? ""),
            status: "Scheduled",
            patient: input.patient ?? null,
          },
        };
      }
      return mapGatewayError(r.status, r.data);
    },

    async updateAppointment(ctx, input: UpdateConnectorAppointmentInput): Promise<ConnectorResult<ConnectorAppointment>> {
      if (badCtx(ctx)) return connectorFail("invalid_request", CTX_ERROR);
      const extId = externalApptId(input?.appointment);
      if (!extId) {
        if (String(input?.appointment?.pydentId ?? "").trim()) {
          return connectorFail("appointment_not_found", "This appointment has no Open Dental identity, so Open Dental cannot be asked to change it.");
        }
        return connectorFail("invalid_request", "An appointment reference is required.");
      }
      // The existing gateway supports EXACTLY a date/time move — nothing else.
      if (input.provider !== undefined || input.operatory !== undefined || input.durationMin !== undefined) {
        return connectorFail("unsupported_capability", "The Open Dental connector supports date/time reschedules only — provider, operatory and duration changes are not available through the existing gateway.");
      }
      const date = String(input.date ?? "").slice(0, 10);
      const time = String(input.time ?? "").slice(0, 5);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
        return connectorFail("invalid_request", "A new date (YYYY-MM-DD) and time (HH:MM) are both required for a reschedule.");
      }
      const r = await deps.forward(ctx.workspaceId, "/reschedule-appointment", {
        method: "POST",
        body: { appointmentId: extId, datetime: `${date}T${time}` },
      });
      if (r.status === 200) {
        // OD does not echo the appointment; date/time are the change it just
        // accepted, and every field it did not report is an honest unknown:
        // durationMin NULL (never fabricated), provider/patient/service
        // empty. The Pydent row remains the source of truth.
        return {
          ok: true,
          data: {
            pydentAppointmentId: String(input.appointment?.pydentId ?? "").trim() || null,
            externalId: extId,
            date,
            time,
            durationMin: null,
            provider: {},
            operatory: null,
            service: "",
            status: "Scheduled",
            patient: null,
          },
        };
      }
      if (r.status === 404) return connectorFail("appointment_not_found", "Open Dental has no appointment with that identity.");
      return mapGatewayError(r.status, r.data);
    },

    async cancelAppointment(ctx, appointment): Promise<ConnectorResult<{ cancelled: boolean }>> {
      if (badCtx(ctx)) return connectorFail("invalid_request", CTX_ERROR);
      const extId = externalApptId(appointment);
      if (!extId) {
        if (String(appointment?.pydentId ?? "").trim()) {
          return connectorFail("appointment_not_found", "This appointment has no Open Dental identity, so Open Dental cannot be asked to cancel it.");
        }
        return connectorFail("invalid_request", "An appointment reference is required.");
      }
      const r = await deps.forward(ctx.workspaceId, "/cancel-appointment", { method: "POST", body: { appointmentId: extId } });
      if (r.status === 200) return { ok: true, data: { cancelled: true } };
      if (r.status === 404) return connectorFail("appointment_not_found", "Open Dental has no appointment with that identity.");
      return mapGatewayError(r.status, r.data);
    },
  };
}
