// BookingConnector contract (M1C) — the PMS-neutral boundary every booking
// system integration implements: Open Dental, Dental4Windows, Pydent native
// scheduling, and future systems. THIS FILE DEFINES THE CONTRACT ONLY —
// nothing in the app calls it yet, and the existing Open Dental path
// (opendental-gateway.ts, booking-server.ts) is untouched until M1D wraps it.
//
// Vocabulary rules:
//  * Pydent domain concepts only — no PMS terminology, ids, or field names.
//    A PMS's own identifiers (whatever it calls them) travel ONLY as the
//    generic `externalId` strings that external_mappings (migration 0066)
//    stores; this file never names them.
//  * Formats match the rest of the codebase (scheduling.ts, appointments):
//    dates are "YYYY-MM-DD"; times are "HH:MM", 24-hour, in the CLINIC's
//    local timezone (clinic_settings.timezone); durations are integer
//    minutes; weekdays are lowercase English names ("monday"…"sunday").
//  * Appointment status uses Pydent's vocabulary ('Scheduled', 'Confirmed',
//    'Completed', 'Broken', 'Unconfirmed') — a connector translates its
//    system's states into these.

// ── Context ─────────────────────────────────────────────────────────────────
// Every operation is workspace-safe by construction: the caller supplies the
// workspace and connection EXPLICITLY. Connectors never discover, guess, or
// fall back to a workspace; missing context fails closed at the registry.
export interface BookingConnectorContext {
  workspaceId: string;
  connectionId: string;
}

// ── Capabilities ────────────────────────────────────────────────────────────
// No PMS is assumed to support everything (live availability included).
// A connector declares exactly what it can do; callers must check before
// invoking, and unsupported operations return an `unsupported_capability`
// error rather than pretending. Extensible: future capabilities are new
// optional flags, absent = false.
export interface BookingConnectorCapabilities {
  providers: boolean;          // getProviders
  schedules: boolean;          // getSchedules
  operatories: boolean;        // getOperatories
  appointments: boolean;       // getAppointments (read/pull)
  availability: boolean;       // getAvailability (live open slots)
  createAppointment: boolean;
  updateAppointment: boolean;
  cancelAppointment: boolean;
  sync: boolean;               // background import/reconciliation
  findPatients: boolean;       // search external patients by contact evidence (M1E-C-B)
  createPatient: boolean;      // create an external patient record (M1E-C-B)
}

export const NO_CAPABILITIES: BookingConnectorCapabilities = {
  providers: false,
  schedules: false,
  operatories: false,
  appointments: false,
  availability: false,
  createAppointment: false,
  updateAppointment: false,
  cancelAppointment: false,
  sync: false,
  findPatients: false,
  createPatient: false,
};

// ── Error model ─────────────────────────────────────────────────────────────
// Small and closed on purpose. Errors carry a machine code + a short human
// message and NOTHING else — never credentials, connection config, or raw
// upstream payloads (trim what a PMS returns before it gets here).
export type ConnectorErrorCode =
  | "config_missing"          // no/incomplete connection configuration
  | "auth_failed"             // the external system rejected the credentials
  | "unavailable"             // unreachable, timed out, or connection disabled
  | "unsupported_connector"   // connector_type has no registered implementation
  | "unsupported_capability"  // this connector doesn't support the operation
  | "not_implemented"         // registered but not yet wired (placeholder)
  | "invalid_request"         // bad/missing arguments or context
  | "patient_not_found"
  | "ambiguous_match"         // several plausible external candidates — a human must disambiguate; never pick one
  | "provider_not_found"
  | "appointment_not_found"
  | "slot_unavailable"        // requested time no longer open
  | "external_conflict"       // the external system reports a conflicting state
  | "external_error";         // any other upstream failure

export interface ConnectorError {
  code: ConnectorErrorCode;
  message: string;
}

const MAX_ERROR_MESSAGE = 300;

// The only way connector code should build errors: keeps the shape closed
// (code + bounded message, nothing that could carry a secret object along).
export function connectorError(code: ConnectorErrorCode, message: string): ConnectorError {
  return { code, message: String(message ?? "").slice(0, MAX_ERROR_MESSAGE) };
}

export type ConnectorResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ConnectorError };

export function connectorFail<T = never>(code: ConnectorErrorCode, message: string): ConnectorResult<T> {
  return { ok: false, error: connectorError(code, message) };
}

// ── Generic domain types (DTOs at the connector boundary) ───────────────────

// How an entity is identified across the boundary: by its stable Pydent UUID
// (providers.id, operatories.id, appointments.id, patients.id — migrations
// 0065/0066), by the external system's identity as an opaque string, or both.
// At least one side must be present for a reference to be usable.
export interface ConnectorEntityRef {
  pydentId?: string | null;
  externalId?: string | null;
}

export interface ConnectorProvider {
  pydentProviderId: string | null; // providers.id once mapped; null when only external
  externalId: string | null;       // the PMS's identity, opaque
  name: string;
  specialty: string;
  bookingEnabled: boolean;
}

export interface ConnectorOperatory {
  pydentOperatoryId: string | null;
  externalId: string | null;
  name: string;
  active: boolean;
}

// A working window. date set = a specific day's window; date null = a weekly
// recurring window on `weekday`.
export interface ConnectorSchedule {
  provider: ConnectorEntityRef;
  weekday: string;           // lowercase English day name
  date: string | null;       // "YYYY-MM-DD" | null (recurring)
  startTime: string;         // "HH:MM"
  endTime: string;           // "HH:MM"
}

// Minimal patient reference for booking: identity when known, else the
// contact details a connector needs to find-or-create on its side. Carry no
// clinical data across this boundary — scheduling and contact fields only.
export interface ConnectorPatientRef {
  pydentPatientId?: string | null;
  externalId?: string | null;
  name?: string;
  phone?: string;
  email?: string;
}

export interface ConnectorAppointment {
  pydentAppointmentId: string | null;
  externalId: string | null;
  date: string;              // "YYYY-MM-DD"
  time: string;              // "HH:MM" clinic-local
  // Explicit integer minutes, or null when the EXTERNAL system did not report
  // a duration for this appointment. Connectors must never fabricate one —
  // null is the honest value. (Request inputs that need a duration still
  // require a number: see CreateConnectorAppointmentInput.)
  durationMin: number | null;
  provider: ConnectorEntityRef;
  operatory: ConnectorEntityRef | null;
  service: string;           // free-text service/treatment name
  status: string;            // Pydent vocabulary ('Scheduled' | 'Confirmed' | 'Completed' | 'Broken' | 'Unconfirmed')
  patient: ConnectorPatientRef | null;
}

export interface ConnectorAppointmentsRequest {
  dateFrom: string;          // "YYYY-MM-DD" inclusive
  dateTo: string;            // "YYYY-MM-DD" inclusive
  provider?: ConnectorEntityRef | null;
}

export interface ConnectorAvailabilityRequest {
  date: string;              // "YYYY-MM-DD"
  provider?: ConnectorEntityRef | null;
  service?: string | null;
  durationMin?: number | null; // desired appointment length; connector may ignore if unsupported
}

export interface ConnectorAvailabilitySlot {
  date: string;
  time: string;              // "HH:MM" clinic-local start
  durationMin: number | null; // slot length when the system reports one
  provider: ConnectorEntityRef | null;
  operatory: ConnectorEntityRef | null;
}

export interface CreateConnectorAppointmentInput {
  patient: ConnectorPatientRef;
  provider?: ConnectorEntityRef | null;
  operatory?: ConnectorEntityRef | null;
  service: string;
  date: string;
  time: string;
  durationMin: number;
  note?: string;
}

export interface UpdateConnectorAppointmentInput {
  appointment: ConnectorEntityRef;  // which appointment to change
  date?: string;
  time?: string;
  durationMin?: number;
  provider?: ConnectorEntityRef | null;
  operatory?: ConnectorEntityRef | null;
}

// Evidence for an external patient search. Phone/email are the only search
// keys — a NAME is never evidence enough to establish identity, so it is
// deliberately absent from the request shape.
export interface ConnectorPatientSearchRequest {
  phone?: string | null;
  email?: string | null;
}

export interface ConnectorSyncRequest {
  syncType: string;          // app vocabulary (booking-connections-server SYNC_RUN_TYPES)
  since?: string | null;     // ISO timestamp for incremental syncs
}

export interface ConnectorSyncResult {
  recordsRead: number;
  recordsWritten: number;
  recordsFailed: number;
  detail?: Record<string, unknown>; // diagnostics only — no secrets, no clinical data
}

export interface ConnectorHealthResult {
  reachable: boolean;
  authenticated: boolean;
  detail?: string;           // short human diagnostic, never credentials
}

// ── The contract ────────────────────────────────────────────────────────────
// Every method takes the explicit context and returns a ConnectorResult —
// connectors report failure as data (like booking-server's structured
// results), they don't throw for expected conditions.
export interface BookingConnector {
  /** The booking_connections.connector_type this implementation serves. */
  readonly type: string;

  /** What this connector supports. Static per connector; callers must check. */
  getCapabilities(): BookingConnectorCapabilities;

  testConnection(ctx: BookingConnectorContext): Promise<ConnectorResult<ConnectorHealthResult>>;

  getProviders(ctx: BookingConnectorContext): Promise<ConnectorResult<ConnectorProvider[]>>;
  getSchedules(ctx: BookingConnectorContext, req: ConnectorAppointmentsRequest): Promise<ConnectorResult<ConnectorSchedule[]>>;
  getOperatories(ctx: BookingConnectorContext): Promise<ConnectorResult<ConnectorOperatory[]>>;

  getAppointments(ctx: BookingConnectorContext, req: ConnectorAppointmentsRequest): Promise<ConnectorResult<ConnectorAppointment[]>>;
  getAvailability(ctx: BookingConnectorContext, req: ConnectorAvailabilityRequest): Promise<ConnectorResult<ConnectorAvailabilitySlot[]>>;

  /** ALL plausible external patients for the evidence — the caller decides;
   *  a connector must never pre-select one (no first-result behavior). */
  findPatients(ctx: BookingConnectorContext, req: ConnectorPatientSearchRequest): Promise<ConnectorResult<ConnectorPatientRef[]>>;
  /** Create an external patient record (scheduling-contact fields only).
   *  Identity establishment — persisting the mapping — is the caller's job
   *  and must complete before the patient counts as established. */
  createPatient(ctx: BookingConnectorContext, input: ConnectorPatientRef): Promise<ConnectorResult<{ externalId: string }>>;

  createAppointment(ctx: BookingConnectorContext, input: CreateConnectorAppointmentInput): Promise<ConnectorResult<ConnectorAppointment>>;
  updateAppointment(ctx: BookingConnectorContext, input: UpdateConnectorAppointmentInput): Promise<ConnectorResult<ConnectorAppointment>>;
  cancelAppointment(ctx: BookingConnectorContext, appointment: ConnectorEntityRef): Promise<ConnectorResult<{ cancelled: boolean }>>;

  sync(ctx: BookingConnectorContext, req: ConnectorSyncRequest): Promise<ConnectorResult<ConnectorSyncResult>>;
}
