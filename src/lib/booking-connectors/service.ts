// Booking connector SERVICE (M1D-B): the orchestration boundary through
// which Pydent booking logic will eventually talk to an external PMS
// connector. Resolution → capability gate → identity mapping → connector
// call, failing CLOSED at every step. NO production caller uses it yet
// (enforced by the import-scan tests); legacy booking behavior is untouched.
//
// Hard rules, by design:
//  * No fallback, ever: not to another workspace/connection/connector, not
//    to legacy Open Dental, not to a provider name, a first provider, or a
//    first service. A resolution gap is a structured failure, never a guess
//    and never a silently-different booking. Legacy compatibility, when it
//    is needed, will be an EXPLICIT caller decision in a later milestone —
//    this module contains no try-new-catch-use-legacy path.
//  * Identity comes from external_mappings ONLY (read-only here): a Pydent
//    provider/appointment UUID resolves to the external system's identity
//    through a mapping row, or the operation fails closed. This module
//    never writes mappings, never touches the appointments table's legacy
//    external-id column, and
//    never talks to the database directly at all — its three dependencies
//    (primary-connection lookup, connector resolution, mapping lookup) are
//    injected, defaulting to the real M1B/M1C functions.
//  * Capability gating: a connector operation is invoked only after its
//    declared capability is checked; unsupported → unsupported_capability
//    without any call.

import {
  getPrimaryBookingConnection,
  getExternalMapping,
  type ExternalMapping,
} from "@/lib/booking-connections-server";
import { getPrimaryBookingConnector, type ResolvedConnector, type ResolveResult } from "@/lib/booking-connectors/registry";
import {
  type BookingConnectorCapabilities,
  type ConnectorResult,
  type ConnectorAvailabilitySlot,
  type ConnectorAppointment,
  connectorFail,
} from "@/lib/booking-connectors/types";

// ── Dependencies (injected for deterministic tests; real by default) ────────
export interface BookingConnectorServiceDeps {
  getPrimary: typeof getPrimaryBookingConnection;
  resolvePrimary: typeof getPrimaryBookingConnector;
  getMapping: (workspaceId: string, connectionId: string, entityType: string, pydentEntityId: string) => Promise<ExternalMapping | null>;
}

const REAL_DEPS: BookingConnectorServiceDeps = {
  getPrimary: getPrimaryBookingConnection,
  resolvePrimary: getPrimaryBookingConnector,
  getMapping: getExternalMapping,
};

// ── Resolution + capability gate ────────────────────────────────────────────

async function resolvePrimary(workspaceId: string, deps: BookingConnectorServiceDeps): Promise<ResolveResult> {
  // Delegates entirely to the M1C resolver (no duplicated registry logic):
  // it already fails closed on a missing workspace (invalid_request), no
  // enabled primary connection (config_missing), a disabled connection
  // (unavailable), and an unknown connector type (unsupported_connector).
  return deps.resolvePrimary(workspaceId, { getPrimary: deps.getPrimary });
}

function capabilityGate<T>(resolved: ResolvedConnector, cap: keyof BookingConnectorCapabilities): ConnectorResult<T> | null {
  if (!resolved.connector.getCapabilities()[cap]) {
    return connectorFail<T>("unsupported_capability", `The '${resolved.connector.type}' connector does not support ${String(cap)} — the operation was not attempted.`);
  }
  return null;
}

// ── Provider identity (mappings only — never names, never "first") ─────────

// Pydent provider UUID → the external system's provider identity, through an
// external_mappings row for THIS connection. No mapping → fail closed. The
// provider's NAME is never consulted and never sent as an identity.
export async function resolveProviderExternalId(
  workspaceId: string,
  connectionId: string,
  pydentProviderId: string,
  deps: BookingConnectorServiceDeps = REAL_DEPS
): Promise<ConnectorResult<string>> {
  const pid = String(pydentProviderId ?? "").trim();
  if (!workspaceId || !connectionId || !pid) return connectorFail("invalid_request", "A workspace, connection and Pydent provider id are all required.");
  const mapping = await deps.getMapping(workspaceId, connectionId, "provider", pid);
  const ext = String(mapping?.externalId ?? "").trim();
  if (!ext) {
    return connectorFail("provider_not_found", "This provider has no external identity mapped for the workspace's booking connection — map the provider before using it externally.");
  }
  return { ok: true, data: ext };
}

// ── Availability ────────────────────────────────────────────────────────────

export interface ServiceAvailabilityRequest {
  date: string;                       // "YYYY-MM-DD"
  pydentProviderId?: string | null;   // optional; when present it MUST map
  durationMin?: number | null;
}

// Connector availability for the workspace's primary booking connection.
// Provider identity is resolved through mappings when requested; a service/
// procedure filter is deliberately NOT exposed yet — Pydent has no service
// identity model, and forwarding free text would legitimize the clinic
// middleware's known silent first-service fallback (see M1E notes).
export async function connectorAvailability(
  workspaceId: string,
  req: ServiceAvailabilityRequest,
  deps: BookingConnectorServiceDeps = REAL_DEPS
): Promise<ConnectorResult<ConnectorAvailabilitySlot[]>> {
  const r = await resolvePrimary(workspaceId, deps);
  if (!r.ok) return r as ConnectorResult<ConnectorAvailabilitySlot[]>;
  const gate = capabilityGate<ConnectorAvailabilitySlot[]>(r.resolved, "availability");
  if (gate) return gate;
  const date = String(req?.date ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return connectorFail("invalid_request", "A date (YYYY-MM-DD) is required.");

  let provider: { pydentId: string; externalId: string } | null = null;
  const pid = String(req.pydentProviderId ?? "").trim();
  if (pid) {
    const mapped = await resolveProviderExternalId(workspaceId, r.resolved.connection.id, pid, deps);
    if (!mapped.ok) return mapped as ConnectorResult<ConnectorAvailabilitySlot[]>;
    provider = { pydentId: pid, externalId: mapped.data };
  }
  return r.resolved.connector.getAvailability(r.resolved.context, {
    date,
    provider,
    service: null,
    durationMin: req.durationMin ?? null,
  });
}

// ── Create appointment: UNAVAILABLE in M1D-B, explicitly ────────────────────

// Why createAppointment fails closed here (the key M1D-B review point) —
// and why the failure is CONFIG_MISSING, not unsupported_capability: the
// connector genuinely supports creation (Open Dental advertises
// createAppointment: true, and the capability gate above would pass). The
// blocker is ORCHESTRATION READINESS in Pydent's own domain layer: a safe
// external booking needs unambiguous SERVICE/PROCEDURE identity, and Pydent
// cannot provide one yet — procedures are free text with no entity to map
// through external_mappings, and the clinic middleware is known to fall back
// to its FIRST configured service for an unrecognized id, a fallback this
// layer must never legitimize. That is missing identity CONFIGURATION, so
// config_missing is the accurate existing code. (Patient find-or-create
// policy is a separate adoption question, documented — not a capability
// statement either.) Until the service identity model exists (M1E decision),
// this layer refuses rather than guesses; the connector's createAppointment
// is NEVER invoked through this path.
export const CREATE_UNAVAILABLE_REASON =
  "Appointment creation requires a configured external service/procedure identity, and Pydent has no service identity model mapped for this connection yet. Guessing (or inheriting a first-service fallback) is not acceptable — the operation was not attempted.";

export async function connectorCreateAppointment(
  workspaceId: string,
  _input: unknown,
  deps: BookingConnectorServiceDeps = REAL_DEPS
): Promise<ConnectorResult<ConnectorAppointment>> {
  // Resolution + capability gate run first so genuine configuration and
  // capability problems surface with their own precise codes…
  const r = await resolvePrimary(workspaceId, deps);
  if (!r.ok) return r as ConnectorResult<ConnectorAppointment>;
  const gate = capabilityGate<ConnectorAppointment>(r.resolved, "createAppointment");
  if (gate) return gate;
  // …and then the explicit readiness prerequisite, never a guess:
  return connectorFail("config_missing", CREATE_UNAVAILABLE_REASON);
}

// ── Appointment identity (mappings only) ────────────────────────────────────

// Pydent appointment UUID → external appointment identity via a mapping row.
// The appointments table's legacy external-id column is NOT consulted here;
// support for it, if
// migration ever needs it, will be an explicit, separately-named
// compatibility function — not a silent second identity rule here.
async function resolveAppointmentExternalId(
  workspaceId: string,
  connectionId: string,
  pydentAppointmentId: string,
  deps: BookingConnectorServiceDeps
): Promise<ConnectorResult<string>> {
  const aid = String(pydentAppointmentId ?? "").trim();
  if (!aid) return connectorFail("invalid_request", "A Pydent appointment id is required.");
  const mapping = await deps.getMapping(workspaceId, connectionId, "appointment", aid);
  const ext = String(mapping?.externalId ?? "").trim();
  if (!ext) {
    return connectorFail("appointment_not_found", "This appointment has no external identity mapped for the workspace's booking connection, so the external system cannot be asked to change it.");
  }
  return { ok: true, data: ext };
}

// ── Reschedule / cancel ─────────────────────────────────────────────────────

export interface ServiceRescheduleRequest {
  pydentAppointmentId: string;
  date: string;  // "YYYY-MM-DD"
  time: string;  // "HH:MM"
}

export async function connectorReschedule(
  workspaceId: string,
  req: ServiceRescheduleRequest,
  deps: BookingConnectorServiceDeps = REAL_DEPS
): Promise<ConnectorResult<ConnectorAppointment>> {
  const r = await resolvePrimary(workspaceId, deps);
  if (!r.ok) return r as ConnectorResult<ConnectorAppointment>;
  const gate = capabilityGate<ConnectorAppointment>(r.resolved, "updateAppointment");
  if (gate) return gate;
  const date = String(req?.date ?? "").slice(0, 10);
  const time = String(req?.time ?? "").slice(0, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return connectorFail("invalid_request", "A new date (YYYY-MM-DD) and time (HH:MM) are both required.");
  }
  const ext = await resolveAppointmentExternalId(workspaceId, r.resolved.connection.id, req?.pydentAppointmentId ?? "", deps);
  if (!ext.ok) return ext as ConnectorResult<ConnectorAppointment>;
  return r.resolved.connector.updateAppointment(r.resolved.context, {
    appointment: { pydentId: String(req.pydentAppointmentId).trim(), externalId: ext.data },
    date,
    time,
  });
}

export async function connectorCancel(
  workspaceId: string,
  pydentAppointmentId: string,
  deps: BookingConnectorServiceDeps = REAL_DEPS
): Promise<ConnectorResult<{ cancelled: boolean }>> {
  const r = await resolvePrimary(workspaceId, deps);
  if (!r.ok) return r as ConnectorResult<{ cancelled: boolean }>;
  const gate = capabilityGate<{ cancelled: boolean }>(r.resolved, "cancelAppointment");
  if (gate) return gate;
  const ext = await resolveAppointmentExternalId(workspaceId, r.resolved.connection.id, pydentAppointmentId, deps);
  if (!ext.ok) return ext as ConnectorResult<{ cancelled: boolean }>;
  return r.resolved.connector.cancelAppointment(r.resolved.context, {
    pydentId: String(pydentAppointmentId).trim(),
    externalId: ext.data,
  });
}
