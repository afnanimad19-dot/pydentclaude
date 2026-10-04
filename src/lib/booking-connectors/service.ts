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
import {
  insertPatientMapping,
  insertAppointmentMapping,
  createSyncIntent,
  updateSyncIntent,
  latestAppointmentIntent,
  writeLegacyAppointmentExternalRef,
  getWorkspaceAppointmentRow,
} from "@/lib/booking-connections-server";
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
  // M1E-C-C external-create seams: appointment-mapping write (hard-scoped,
  // insert-not-overwrite), the create-intent ledger on booking_sync_runs,
  // the legacy-compat column write, and the Pydent appointment row check.
  persistApptMapping: typeof insertAppointmentMapping;
  createIntent: typeof createSyncIntent;
  updateIntent: typeof updateSyncIntent;
  latestIntent: typeof latestAppointmentIntent;
  writeLegacyRef: typeof writeLegacyAppointmentExternalRef;
  getAppointment: typeof getWorkspaceAppointmentRow;
}

const REAL_DEPS: BookingConnectorServiceDeps = {
  getPrimary: getPrimaryBookingConnection,
  resolvePrimary: getPrimaryBookingConnector,
  getMapping: getExternalMapping,
  getService,
  getServiceExternal: (ws, connectionId, serviceId) => getServiceExternalId(ws, connectionId, serviceId),
  getPatient: getPatientById,
  persistPatientMapping: insertPatientMapping,
  persistApptMapping: insertAppointmentMapping,
  createIntent: createSyncIntent,
  updateIntent: updateSyncIntent,
  latestIntent: latestAppointmentIntent,
  writeLegacyRef: writeLegacyAppointmentExternalRef,
  getAppointment: getWorkspaceAppointmentRow,
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

// ── Create appointment: UNLOCKED (M1E-C-C) — the external-write saga ────────
// validate → existing-mapping check → pending/unknown-intent guard →
// identity resolution (patient/service/provider, mappings only) →
// availability re-check → INTENT persisted → EXTERNAL PMS WRITE →
// appointment mapping → legacy-compat column → intent succeeded.
// The external write and the local writes are a SAGA of independent
// operations across two systems — nothing here is atomic, and every
// partial-failure point lands in a recoverable, never-double-booking state:
// an outcome that cannot be ruled a definite failure becomes an "unknown"
// intent that BLOCKS further creates until reconciliation adjudicates.

export interface CreateExternalAppointmentRequest {
  pydentAppointmentId: string;   // the existing, workspace-owned Pydent row
  pydentPatientId: string;       // must already be mapped (resolution only — never establishment)
  pydentServiceId: string;       // must resolve to a bookable, mapped service
  pydentProviderId?: string | null; // optional; when given it MUST map
  date: string;                  // must equal the Pydent row's date
  time: string;                  // must equal the Pydent row's time
  durationMin: number;
}

// Is a failed external call's outcome indeterminate? Conservative bias: an
// "unavailable" whose message proves the request never left (DNS, refused,
// connection disabled/not configured) is a definite failure; every other
// transport-shaped failure (timeout, reset, unspecified) might have been
// delivered, so it is UNKNOWN and must block blind retries.
function indeterminateOutcome(code: string, message: string): boolean {
  if (code !== "unavailable") return false;
  return !/refused|DNS|resolve|disabled|not connected|not configured/i.test(message);
}

function apptEcho(pydentAppointmentId: string, externalId: string, date: string, time: string): ConnectorAppointment {
  return { pydentAppointmentId, externalId, date, time, durationMin: null, provider: {}, operatory: null, service: "", status: "Scheduled", patient: null };
}

export async function connectorCreateAppointment(
  workspaceId: string,
  input: CreateExternalAppointmentRequest,
  deps: BookingConnectorServiceDeps = REAL_DEPS
): Promise<ConnectorResult<ConnectorAppointment>> {
  // 1) Validate.
  const apptId = String(input?.pydentAppointmentId ?? "").trim();
  const patientId = String(input?.pydentPatientId ?? "").trim();
  const serviceId = String(input?.pydentServiceId ?? "").trim();
  const date = String(input?.date ?? "").slice(0, 10);
  const time = String(input?.time ?? "").slice(0, 5);
  const durationMin = Number(input?.durationMin);
  if (!workspaceId || !apptId || !patientId || !serviceId) {
    return connectorFail("invalid_request", "A workspace, Pydent appointment id, patient id and service id are all required.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || !Number.isFinite(durationMin) || durationMin <= 0) {
    return connectorFail("invalid_request", "A date (YYYY-MM-DD), time (HH:MM) and positive durationMin are required.");
  }
  const r = await resolvePrimary(workspaceId, deps);
  if (!r.ok) return r as ConnectorResult<ConnectorAppointment>;
  const gate = capabilityGate<ConnectorAppointment>(r.resolved, "createAppointment");
  if (gate) return gate;
  const connectionId = r.resolved.connection.id;

  // The Pydent row must exist, be workspace-owned, and agree on the slot.
  const row = await deps.getAppointment(workspaceId, apptId);
  if (!row) return connectorFail("appointment_not_found", "No such appointment exists in this workspace.");
  if (row.date !== date || row.time !== time) {
    return connectorFail("invalid_request", "The requested date/time does not match the Pydent appointment row — external and local state must agree before an external write.");
  }

  // 2) Existing appointment mapping → idempotent success, zero external calls.
  const mapped = await deps.getMapping(workspaceId, connectionId, "appointment", apptId);
  const mappedExt = String(mapped?.externalId ?? "").trim();
  if (mappedExt) return { ok: true, data: apptEcho(apptId, mappedExt, date, time) };

  // 3) Pending/unknown-intent guard.
  const prior = await deps.latestIntent(workspaceId, connectionId, apptId);
  if (prior && (prior.status === "running" || prior.status === "unknown")) {
    const recoveredExt = String(prior.detail?.externalId ?? "").trim();
    if (recoveredExt) {
      // A previous attempt DID create externally but local persistence
      // failed: recover from the ledger — never a second PMS create.
      const m = await deps.persistApptMapping(workspaceId, { connectionId, pydentAppointmentId: apptId, externalId: recoveredExt, metadata: { method: "ledger_recovery", intentId: prior.id } });
      if (!m.ok) {
        if (m.conflictingExternalId) return connectorFail("external_conflict", "A different external identity is already mapped for this appointment — manual resolution required.");
        return connectorFail("external_error", "The external appointment exists (recorded in the intent ledger) but local persistence failed again — re-run to recover; no second external appointment will be created.");
      }
      await deps.writeLegacyRef(workspaceId, apptId, recoveredExt);
      await deps.updateIntent(workspaceId, prior.id, { status: "succeeded", finished: true, detail: { ...prior.detail, recovered: true } });
      return { ok: true, data: apptEcho(apptId, recoveredExt, date, time) };
    }
    return connectorFail("external_error", "A previous external create for this appointment has an unknown outcome — reconciliation is required before another attempt. No new external write was made.");
  }

  // 4) Identity resolution — mappings only; creation never establishes,
  //    searches, or creates a patient, and demographics play no part.
  const svc = await resolveServiceForConnection(workspaceId, connectionId, serviceId, deps);
  if (!svc.ok) return svc as ConnectorResult<ConnectorAppointment>;
  const pat = await resolvePatientForConnection(workspaceId, connectionId, patientId, deps);
  if (!pat.ok) return pat as ConnectorResult<ConnectorAppointment>;
  let provider: { pydentId: string; externalId: string } | null = null;
  const provId = String(input?.pydentProviderId ?? "").trim();
  if (provId) {
    const provExt = await resolveProviderExternalId(workspaceId, connectionId, provId, deps);
    if (!provExt.ok) return provExt as ConnectorResult<ConnectorAppointment>; // a supplied provider is never silently discarded
    provider = { pydentId: provId, externalId: provExt.data };
  }

  // 5) Availability re-check immediately before the write (when the
  //    connector can answer): the requested start must still be open.
  if (r.resolved.connector.getCapabilities().availability) {
    const avail = await r.resolved.connector.getAvailability(r.resolved.context, { date, provider, service: null, durationMin });
    if (!avail.ok) return avail as ConnectorResult<ConnectorAppointment>; // pre-write, definite — nothing was sent
    if (!avail.data.some((s) => s.time === time)) {
      return connectorFail("slot_unavailable", "The requested slot is no longer available — no external write was attempted.");
    }
  }

  // 6) Persist the create intent BEFORE the external write (correlation
  //    only — Pydent ids, the mapped external ids, and the slot; no PII).
  const intent = await deps.createIntent(workspaceId, {
    connectionId,
    syncType: "appointment_push",
    detail: { pydentAppointmentId: apptId, pydentPatientId: patientId, patientExternalId: pat.data.externalPatientId, serviceExternalId: svc.data.externalServiceId, date, time },
  });
  if (!intent.ok || !intent.id) {
    return connectorFail("external_error", "Could not record the create intent — the external write was NOT attempted.");
  }

  // 7) THE EXTERNAL PMS WRITE.
  const created = await r.resolved.connector.createAppointment(r.resolved.context, {
    patient: { pydentPatientId: patientId, externalId: pat.data.externalPatientId },
    provider,
    service: "",
    serviceExternalId: svc.data.externalServiceId,
    date,
    time,
    durationMin,
  });

  if (!created.ok) {
    if (indeterminateOutcome(created.error.code, created.error.message)) {
      await deps.updateIntent(workspaceId, intent.id, { status: "unknown" });
      return connectorFail("external_error", "The external create's outcome is UNKNOWN (transport interrupted after dispatch) — reconciliation is required before any retry; no blind retry will occur.");
    }
    await deps.updateIntent(workspaceId, intent.id, { status: "failed", finished: true });
    return created as ConnectorResult<ConnectorAppointment>; // definite rejection — controlled retry permitted
  }

  // 8) Record the external identity in the ledger FIRST (so a crash between
  //    here and the mapping write stays recoverable), then persist.
  const extId = String(created.data.externalId ?? "").trim();
  if (!extId) {
    await deps.updateIntent(workspaceId, intent.id, { status: "unknown" });
    return connectorFail("external_error", "The external system reported success without a usable appointment identity — reconciliation required.");
  }
  await deps.updateIntent(workspaceId, intent.id, { detail: { pydentAppointmentId: apptId, pydentPatientId: patientId, patientExternalId: pat.data.externalPatientId, serviceExternalId: svc.data.externalServiceId, date, time, externalId: extId } });
  const m = await deps.persistApptMapping(workspaceId, { connectionId, pydentAppointmentId: apptId, externalId: extId, metadata: { method: "connector_create", intentId: intent.id } });
  if (!m.ok) {
    if (m.conflictingExternalId) return connectorFail("external_conflict", "The external appointment was created but a DIFFERENT identity is already mapped — manual resolution required; nothing was overwritten.");
    return connectorFail("external_error", "The external appointment was created but local persistence failed — the identity is retained in the intent ledger; re-run to recover without a second external create.");
  }
  // 9) Legacy compatibility column (best-effort; mappings stay authoritative).
  const legacyOk = await deps.writeLegacyRef(workspaceId, apptId, extId);
  // 10) Intent → succeeded.
  await deps.updateIntent(workspaceId, intent.id, { status: "succeeded", finished: true, detail: { pydentAppointmentId: apptId, patientExternalId: pat.data.externalPatientId, serviceExternalId: svc.data.externalServiceId, date, time, externalId: extId, legacyRef: legacyOk } });
  return { ok: true, data: apptEcho(apptId, extId, date, time) };
}

// ── Reconciliation (M1E-C-C): adjudicate an indeterminate create ────────────
// Strongest available evidence: the MAPPED external patient identity + the
// requested date + exact time. One coherent match → adopt; zero → clear the
// intent so a controlled retry becomes possible; several → fail closed for
// manual resolution. Never the first of many.
export async function reconcileAppointmentCreate(
  workspaceId: string,
  pydentAppointmentId: string,
  deps: BookingConnectorServiceDeps = REAL_DEPS
): Promise<ConnectorResult<{ outcome: "already_established" | "adopted" | "cleared"; externalId?: string }>> {
  const apptId = String(pydentAppointmentId ?? "").trim();
  if (!workspaceId || !apptId) return connectorFail("invalid_request", "A workspace and Pydent appointment id are required.");
  const r = await resolvePrimary(workspaceId, deps);
  if (!r.ok) return r as ConnectorResult<{ outcome: "already_established" | "adopted" | "cleared"; externalId?: string }>;
  const connectionId = r.resolved.connection.id;

  const mapped = await deps.getMapping(workspaceId, connectionId, "appointment", apptId);
  const mappedExt = String(mapped?.externalId ?? "").trim();
  if (mappedExt) return { ok: true, data: { outcome: "already_established", externalId: mappedExt } };

  const prior = await deps.latestIntent(workspaceId, connectionId, apptId);
  if (!prior || (prior.status !== "running" && prior.status !== "unknown")) {
    return connectorFail("invalid_request", "There is no indeterminate create to reconcile for this appointment.");
  }
  const adopt = async (extId: string, method: string) => {
    const m = await deps.persistApptMapping(workspaceId, { connectionId, pydentAppointmentId: apptId, externalId: extId, metadata: { method, intentId: prior.id } });
    if (!m.ok) {
      if (m.conflictingExternalId) return connectorFail<{ outcome: "already_established" | "adopted" | "cleared"; externalId?: string }>("external_conflict", "A different external identity is already mapped — manual resolution required.");
      return connectorFail<{ outcome: "already_established" | "adopted" | "cleared"; externalId?: string }>("external_error", "Adoption found the external appointment but persistence failed — re-run reconciliation.");
    }
    await deps.writeLegacyRef(workspaceId, apptId, extId);
    await deps.updateIntent(workspaceId, prior.id, { status: "succeeded", finished: true, detail: { ...prior.detail, externalId: extId, reconciled: true } });
    return { ok: true as const, data: { outcome: "adopted" as const, externalId: extId } };
  };

  // Ledger already knows the identity → adopt without probing.
  const ledgerExt = String(prior.detail?.externalId ?? "").trim();
  if (ledgerExt) return adopt(ledgerExt, "ledger_recovery");

  const gate = capabilityGate<{ outcome: "already_established" | "adopted" | "cleared"; externalId?: string }>(r.resolved, "findAppointments");
  if (gate) return gate; // e.g. middleware mode: automatic reconciliation honestly unsupported
  const patientExternalId = String(prior.detail?.patientExternalId ?? "").trim();
  const date = String(prior.detail?.date ?? "").slice(0, 10);
  const time = String(prior.detail?.time ?? "").slice(0, 5);
  if (!patientExternalId || !date || !time) {
    return connectorFail("invalid_request", "The intent record lacks the correlation evidence needed to reconcile automatically — manual resolution required.");
  }
  const probe = await r.resolved.connector.findAppointments(r.resolved.context, { patient: { externalId: patientExternalId }, date });
  if (!probe.ok) return probe as ConnectorResult<{ outcome: "already_established" | "adopted" | "cleared"; externalId?: string }>;
  const matches = probe.data.filter((a) => a.date === date && a.time === time);
  if (matches.length === 1) return adopt(matches[0].externalId, "reconciliation_probe");
  if (matches.length > 1) {
    return connectorFail("ambiguous_match", `The external system has ${matches.length} appointments matching this patient, date and time — manual resolution required; nothing was adopted.`);
  }
  await deps.updateIntent(workspaceId, prior.id, { status: "failed", finished: true, detail: { ...prior.detail, reconciled: "no_external_appointment" } });
  return { ok: true, data: { outcome: "cleared" } };
}

// ── Appointment identity (mappings only) ────────────────────────────────────

// Pydent appointment UUID → external appointment identity via a mapping row.
// The appointments table's legacy external-id column is NOT consulted here;
// support for it, if data migration ever needs it, will be an explicit,
// separately-named compatibility function — not a silent second identity
// rule here.
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
