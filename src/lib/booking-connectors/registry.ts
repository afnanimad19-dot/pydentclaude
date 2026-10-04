// BookingConnector registry: resolves a connector implementation from a
// BookingConnection, with hard workspace-safety checks — and nothing more.
// opendental resolves to the real adapter over the existing gateway (M1D-A);
// d4w and pydent_native remain PLACEHOLDERS that declare NO capabilities and
// return a clear `not_implemented` error for every operation, so nothing can
// mistake an unwired connector for a functional one. No production caller
// uses this module yet — legacy booking paths are untouched until M1D-B.

import {
  type BookingConnection,
  getPrimaryBookingConnection,
  normalizeConnectorType,
} from "@/lib/booking-connections-server";
import { createOpenDentalConnector } from "@/lib/booking-connectors/opendental";
import {
  type BookingConnector,
  type BookingConnectorContext,
  type BookingConnectorCapabilities,
  type ConnectorResult,
  type ConnectorError,
  NO_CAPABILITIES,
  connectorFail,
  connectorError,
} from "@/lib/booking-connectors/types";

// ── Placeholder implementation ──────────────────────────────────────────────
// Honest about being unwired: zero capabilities, and every call fails with
// not_implemented. It never reads the connection's config and can never leak
// anything — there is nothing to leak.
function notImplemented<T>(type: string, op: string): Promise<ConnectorResult<T>> {
  return Promise.resolve(connectorFail<T>("not_implemented", `The '${type}' connector is registered but not implemented yet (${op}). No operation was performed.`));
}

function placeholderConnector(type: string): BookingConnector {
  const caps: BookingConnectorCapabilities = { ...NO_CAPABILITIES };
  return {
    type,
    getCapabilities: () => ({ ...caps }),
    testConnection: () => notImplemented(type, "testConnection"),
    getProviders: () => notImplemented(type, "getProviders"),
    getSchedules: () => notImplemented(type, "getSchedules"),
    getOperatories: () => notImplemented(type, "getOperatories"),
    getAppointments: () => notImplemented(type, "getAppointments"),
    getAvailability: () => notImplemented(type, "getAvailability"),
    findPatients: () => notImplemented(type, "findPatients"),
    createPatient: () => notImplemented(type, "createPatient"),
    findAppointments: () => notImplemented(type, "findAppointments"),
    createAppointment: () => notImplemented(type, "createAppointment"),
    updateAppointment: () => notImplemented(type, "updateAppointment"),
    cancelAppointment: () => notImplemented(type, "cancelAppointment"),
    sync: () => notImplemented(type, "sync"),
  };
}

// ── Registrations ───────────────────────────────────────────────────────────
// connector_type → implementation factory. opendental resolves to the REAL
// adapter (M1D-A) — a translation layer over the existing gateway, still
// unused by any production caller; d4w and pydent_native remain honest
// placeholders. An unknown type is REJECTED — never silently mapped to
// another connector.
const REGISTRY: Record<string, (connection: BookingConnection) => BookingConnector> = {
  opendental: () => createOpenDentalConnector(),
  d4w: () => placeholderConnector("d4w"),
  pydent_native: () => placeholderConnector("pydent_native"),
};

export function registeredConnectorTypes(): string[] {
  return Object.keys(REGISTRY);
}

// ── Resolution ──────────────────────────────────────────────────────────────

export interface ResolvedConnector {
  connector: BookingConnector;
  connection: BookingConnection;
  context: BookingConnectorContext;
}

export type ResolveResult =
  | { ok: true; resolved: ResolvedConnector }
  | { ok: false; error: ConnectorError };

// Resolve the implementation for a connection under an explicit context.
// Fail-closed on every mismatch; no fallback of any kind. Error messages
// intentionally never include connection.config (which may hold non-secret
// but still private clinic settings) — only ids and the connector type.
export function resolveBookingConnector(
  connection: BookingConnection | null | undefined,
  context: BookingConnectorContext | null | undefined
): ResolveResult {
  const ws = String(context?.workspaceId ?? "").trim();
  const connId = String(context?.connectionId ?? "").trim();
  if (!ws || !connId) {
    return { ok: false, error: connectorError("invalid_request", "A workspace id and connection id are both required to resolve a booking connector.") };
  }
  if (!connection) {
    return { ok: false, error: connectorError("config_missing", "No booking connection was provided.") };
  }
  // Workspace safety: the connection must be exactly the one the context
  // names, and must belong to exactly the context's workspace.
  if (connection.workspaceId !== ws) {
    return { ok: false, error: connectorError("invalid_request", "The booking connection belongs to a different workspace than the request context.") };
  }
  if (connection.id !== connId) {
    return { ok: false, error: connectorError("invalid_request", "The booking connection does not match the connection id in the request context.") };
  }
  if (!connection.enabled) {
    return { ok: false, error: connectorError("unavailable", "This booking connection is disabled.") };
  }
  const type = normalizeConnectorType(connection.connectorType);
  if (!type) {
    return { ok: false, error: connectorError("invalid_request", "The booking connection has an invalid connector type.") };
  }
  const factory = REGISTRY[type];
  if (!factory) {
    return { ok: false, error: connectorError("unsupported_connector", `No connector implementation is registered for type '${type}'.`) };
  }
  return { ok: true, resolved: { connector: factory(connection), connection, context: { workspaceId: ws, connectionId: connId } } };
}

// ── Primary connector resolution ────────────────────────────────────────────
// The workspace's one enabled primary booking connection, resolved to its
// connector. Fails clearly when the workspace has none. NEVER falls back to
// another workspace, another connection, or the legacy Open Dental path —
// choosing to use this resolver (M1D+) is an explicit, per-call-site
// decision. `deps` exists for deterministic tests only.
export async function getPrimaryBookingConnector(
  workspaceId: string,
  deps: { getPrimary: (ws: string) => Promise<BookingConnection | null> } = { getPrimary: getPrimaryBookingConnection }
): Promise<ResolveResult> {
  const ws = String(workspaceId ?? "").trim();
  if (!ws) {
    return { ok: false, error: connectorError("invalid_request", "A workspace id is required.") }; // fail closed
  }
  const connection = await deps.getPrimary(ws);
  if (!connection) {
    return { ok: false, error: connectorError("config_missing", "This workspace has no enabled primary booking connection.") };
  }
  return resolveBookingConnector(connection, { workspaceId: ws, connectionId: connection.id });
}
