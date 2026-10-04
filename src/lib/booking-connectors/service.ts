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
import { getService, getServiceExternalId, type Service } from "@/lib/services-server";
import { insertPatientMapping } from "@/lib/booking-connections-server";
import { getPatientById } from "@/lib/agent-tools-core";
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
  // M1E-B service-identity seams (real M1E-A helpers by default):
  getService: (workspaceId: string, serviceId: string) => Promise<Service | null>;
  getServiceExternal: (workspaceId: string, connectionId: string, serviceId: string) => Promise<string | null>;
  // M1E-C-B patient-identity seams: a workspace-scoped Pydent patient read,
  // and the ONE sanctioned mapping write (patient rows only, insert-not-
  // overwrite — see booking-connections-server.insertPatientMapping).
  getPatient: (workspaceId: string | null, patientId: string) => Promise<{ id: string; name: string | null; phone: string | null; email: string | null } | null>;
  persistPatientMapping: typeof insertPatientMapping;
}

const REAL_DEPS: BookingConnectorServiceDeps = {
  getPrimary: getPrimaryBookingConnection,
  resolvePrimary: getPrimaryBookingConnector,
  getMapping: getExternalMapping,
  getService,
  getServiceExternal: (ws, connectionId, serviceId) => getServiceExternalId(ws, connectionId, serviceId),
  getPatient: getPatientById,
  persistPatientMapping: insertPatientMapping,
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

// ── Service identity (catalog + mappings only — never names or codes) ───────

export interface ResolvedServiceIdentity {
  pydentServiceId: string;
  externalServiceId: string;           // the PMS identity from external_mappings
  defaultDurationMin: number | null;   // honest: null when the catalog doesn't know
}

// Pydent service UUID → the external system's service/procedure identity for
// one connection. Fail-closed ladder (M1E-B):
//   1. explicit workspace + connection + service id      → invalid_request
//   2. service exists IN THIS WORKSPACE                  → config_missing
//      (a foreign workspace's service id gets the same answer as an unknown
//       one — nothing leaks about other workspaces' catalogs)
//   3. service active AND booking_enabled                → unavailable
//   4. external mapping for THIS connection              → config_missing
//   5. → the mapped external identity
// The service NAME and the Pydent-internal CODE are never consulted, and
// there is no first-service fallback — resolution reuses the M1E-A helpers
// (which reuse the generic M1B mapping reader); nothing here duplicates
// mapping logic or writes anything.
export async function resolveServiceForConnection(
  workspaceId: string,
  connectionId: string,
  pydentServiceId: string,
  deps: BookingConnectorServiceDeps = REAL_DEPS
): Promise<ConnectorResult<ResolvedServiceIdentity>> {
  const sid = String(pydentServiceId ?? "").trim();
  if (!workspaceId || !connectionId || !sid) {
    return connectorFail("invalid_request", "A workspace, connection and Pydent service id are all required.");
  }
  const svc = await deps.getService(workspaceId, sid);
  if (!svc) {
    return connectorFail("config_missing", "No such service is configured in this workspace's catalog.");
  }
  if (!svc.active || !svc.bookingEnabled) {
    return connectorFail("unavailable", "This service is not currently bookable.");
  }
  const ext = await deps.getServiceExternal(workspaceId, connectionId, sid);
  if (!ext) {
    return connectorFail("config_missing", "This service has no external identity mapped for the workspace's booking connection — map the service before using it externally.");
  }
  return { ok: true, data: { pydentServiceId: sid, externalServiceId: ext, defaultDurationMin: svc.defaultDurationMin } };
}

// ── Patient identity (M1E-C-B policy) ───────────────────────────────────────
// The Pydent patient UUID is canonical; an external PMS identity exists only
// as an entity_type='patient' mapping for one connection. Phone/email are
// EVIDENCE during establishment, never durable identity; a name alone never
// establishes anything. Resolution (read) and establishment (search +
// persist) are strictly separate operations, and BOTH are separate from
// external appointment creation, which stays locked.

const PATIENT_NOT_FOUND = "No such patient exists in this workspace."; // foreign == unknown: nothing leaks

// Read-only resolution: mapping or nothing. Never searches the PMS, never
// consults demographics — an existing mapping always wins by construction
// because it is the only source consulted.
export async function resolvePatientForConnection(
  workspaceId: string,
  connectionId: string,
  pydentPatientId: string,
  deps: BookingConnectorServiceDeps = REAL_DEPS
): Promise<ConnectorResult<{ pydentPatientId: string; externalPatientId: string }>> {
  const pid = String(pydentPatientId ?? "").trim();
  if (!workspaceId || !connectionId || !pid) {
    return connectorFail("invalid_request", "A workspace, connection and Pydent patient id are all required.");
  }
  const patient = await deps.getPatient(workspaceId, pid);
  if (!patient) return connectorFail("patient_not_found", PATIENT_NOT_FOUND);
  const mapping = await deps.getMapping(workspaceId, connectionId, "patient", pid);
  const ext = String(mapping?.externalId ?? "").trim();
  if (!ext) {
    return connectorFail("config_missing", "This patient has no external identity established for the workspace's booking connection — run establishment first.");
  }
  return { ok: true, data: { pydentPatientId: pid, externalPatientId: ext } };
}

export interface EstablishPatientResult {
  pydentPatientId: string;
  externalPatientId: string;
  established: "existing" | "matched" | "created";
}

// Explicit establishment by SEARCH: phone evidence → ALL external candidates
// → exactly one coherent candidate → persist the mapping → established.
// Every other shape fails closed and distinguishably:
//   zero candidates            → patient_not_found (creation is a separate step)
//   several candidates         → ambiguous_match (a human disambiguates)
//   contradicting identifiers  → external_conflict (nothing persisted)
//   persistence failure        → external_error (NOT established; idempotent re-run)
export async function establishPatientMapping(
  workspaceId: string,
  pydentPatientId: string,
  deps: BookingConnectorServiceDeps = REAL_DEPS
): Promise<ConnectorResult<EstablishPatientResult>> {
  const pid = String(pydentPatientId ?? "").trim();
  if (!workspaceId || !pid) return connectorFail("invalid_request", "A workspace and Pydent patient id are required.");
  const r = await resolvePrimary(workspaceId, deps);
  if (!r.ok) return r as ConnectorResult<EstablishPatientResult>;
  const gate = capabilityGate<EstablishPatientResult>(r.resolved, "findPatients");
  if (gate) return gate;
  const patient = await deps.getPatient(workspaceId, pid);
  if (!patient) return connectorFail("patient_not_found", PATIENT_NOT_FOUND);

  // Idempotent: an existing mapping wins outright — no re-searching.
  const existing = await deps.getMapping(workspaceId, r.resolved.connection.id, "patient", pid);
  const existingExt = String(existing?.externalId ?? "").trim();
  if (existingExt) return { ok: true, data: { pydentPatientId: pid, externalPatientId: existingExt, established: "existing" } };

  // Evidence: the Pydent record's phone. Name is NEVER a search key, and
  // without usable phone evidence establishment fails closed rather than
  // guessing (email-only search is not supported by the OD path in C-B).
  const phone = String(patient.phone ?? "").replace(/\D/g, "");
  if (phone.length < 7) {
    return connectorFail("invalid_request", "This patient record has no usable phone number — establishment needs phone evidence, and a name alone never establishes identity.");
  }
  const found = await r.resolved.connector.findPatients(r.resolved.context, { phone, email: patient.email ?? null });
  if (!found.ok) return found as ConnectorResult<EstablishPatientResult>;
  const candidates = found.data;

  if (candidates.length === 0) {
    return connectorFail("patient_not_found", "No matching patient exists in the external system. Creating one is a separate, explicit step — nothing was created.");
  }
  if (candidates.length > 1) {
    return connectorFail("ambiguous_match", `The external system has ${candidates.length} plausible patients for this phone number — a person must disambiguate; no candidate was selected.`);
  }
  const candidate = candidates[0]; // the single candidate — not a "first of many"
  const candExt = String(candidate.externalId ?? "").trim();
  if (!candExt) return connectorFail("external_error", "The external system returned a patient without a usable identity.");
  // Coherence: evidence may be incomplete, but it must not CONTRADICT. Two
  // differing non-empty emails on the same phone = conflicting identifiers.
  const ourEmail = String(patient.email ?? "").trim().toLowerCase();
  const theirEmail = String(candidate.email ?? "").trim().toLowerCase();
  if (ourEmail && theirEmail && ourEmail !== theirEmail) {
    return connectorFail("external_conflict", "The phone number and email address point at different external patients — identity conflict; nothing was persisted.");
  }

  const persisted = await deps.persistPatientMapping(workspaceId, {
    connectionId: r.resolved.connection.id,
    pydentPatientId: pid,
    externalId: candExt,
    metadata: { method: "phone_search", phoneEvidence: `…${phone.slice(-4)}`, emailChecked: !!(ourEmail && theirEmail), establishedAt: new Date().toISOString() },
  });
  if (!persisted.ok) {
    if (persisted.conflictingExternalId) {
      return connectorFail("external_conflict", "This patient already has a different external identity mapped — not overwritten.");
    }
    return connectorFail("external_error", "The external patient was identified but the mapping could not be persisted — the patient is NOT established; re-run establishment. No booking is possible until the mapping exists.");
  }
  return { ok: true, data: { pydentPatientId: pid, externalPatientId: candExt, established: "matched" } };
}

// Explicit establishment by CREATION: only when search found zero candidates
// and the caller deliberately chooses creation. Scheduling-contact fields
// only cross the boundary; the mapping must persist before the patient
// counts as established — a persistence failure blocks everything, and the
// idempotent re-run path is establishPatientMapping (the just-created
// external patient becomes its single candidate).
export async function establishPatientByCreation(
  workspaceId: string,
  pydentPatientId: string,
  deps: BookingConnectorServiceDeps = REAL_DEPS
): Promise<ConnectorResult<EstablishPatientResult>> {
  const pid = String(pydentPatientId ?? "").trim();
  if (!workspaceId || !pid) return connectorFail("invalid_request", "A workspace and Pydent patient id are required.");
  const r = await resolvePrimary(workspaceId, deps);
  if (!r.ok) return r as ConnectorResult<EstablishPatientResult>;
  const gate = capabilityGate<EstablishPatientResult>(r.resolved, "createPatient");
  if (gate) return gate;
  const patient = await deps.getPatient(workspaceId, pid);
  if (!patient) return connectorFail("patient_not_found", PATIENT_NOT_FOUND);
  const existing = await deps.getMapping(workspaceId, r.resolved.connection.id, "patient", pid);
  if (String(existing?.externalId ?? "").trim()) {
    return { ok: true, data: { pydentPatientId: pid, externalPatientId: String(existing?.externalId), established: "existing" } };
  }
  if (!String(patient.name ?? "").trim() && !String(patient.phone ?? "").trim()) {
    return connectorFail("invalid_request", "This patient record has neither a name nor a phone — nothing safe to create externally.");
  }
  const created = await r.resolved.connector.createPatient(r.resolved.context, {
    pydentPatientId: pid,
    externalId: null,
    name: patient.name ?? "",
    phone: patient.phone ?? "",
    email: patient.email ?? "",
  });
  if (!created.ok) return created as ConnectorResult<EstablishPatientResult>;
  const persisted = await deps.persistPatientMapping(workspaceId, {
    connectionId: r.resolved.connection.id,
    pydentPatientId: pid,
    externalId: created.data.externalId,
    metadata: { method: "created", establishedAt: new Date().toISOString() },
  });
  if (!persisted.ok) {
    return connectorFail("external_error", "The external patient record was created but the mapping could not be persisted — the patient is NOT established and no booking is possible; re-run establishment (the new record will be its single search candidate).");
  }
  return { ok: true, data: { pydentPatientId: pid, externalPatientId: created.data.externalId, established: "created" } };
}

// ── Create appointment: UNAVAILABLE in M1D-B, explicitly ────────────────────

// Why createAppointment STILL fails closed (M1E-B) — and why the failure is
// CONFIG_MISSING, not unsupported_capability: the connector genuinely
// supports creation (Open Dental advertises createAppointment: true, and
// the capability gate above would pass). The blocker is ORCHESTRATION
// READINESS. M1E-B added safe service-identity resolution
// (resolveServiceForConnection above), but external create remains locked
// because the PATIENT-IDENTITY policy for external systems has not been
// approved (M1E-C decision: today's adapter behavior is find-or-create by
// phone — legacy convenience, not approved resolution). Until then this
// layer refuses rather than guesses; the connector's createAppointment is
// NEVER invoked through this path, even when provider AND service
// identities resolve successfully.
export const CREATE_UNAVAILABLE_REASON =
  "Appointment creation through the booking connector is not enabled yet: service identity can now be resolved, but the patient-identity policy for external systems awaits approval (M1E-C). The operation was not attempted.";

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
