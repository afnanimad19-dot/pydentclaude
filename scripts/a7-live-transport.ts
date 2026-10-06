// Pydent A7 live transport — THE ONLY NETWORK CODE IN THE A7 TOOLING.
//
// OPERATOR-ONLY. Imported solely by the two explicit operator commands:
// scripts/a7-mutate-live.ts (full transport) and scripts/a7-authorize.ts
// (createSentinelReadTransport only — no mutation member exists on what it
// receives); never by the dry-run CLI, the runner library, or any application
// code — which keeps the dry-run path structurally incapable of HTTP. Tests
// inject a fake fetchImpl and never touch the network.
//
// Targeting is pinned: every request goes to A7_QUERY_ENDPOINT, a constant
// built from the A7 project ref. No ref, URL, or path ever comes from argv,
// env, SQL, or configuration — an environment poisoned with the production
// ref is rejected by checkA7Config before this module is even constructed,
// and construction re-asserts the invariants anyway (fail closed twice).
//
// Secret handling:
//   * The Management API token is read ONLY from the parsed .env.a7 object,
//     lives ONLY inside the closure's header value, is sent ONLY as an
//     Authorization header (never in a URL or query string), and is never
//     logged, thrown, or returned.
//   * Error text from the endpoint is scrubbed (Bearer-like strings, UUIDs,
//     long hex runs — which also covers the sentinel SHA-256 digest — and
//     anything resembling a token) and capped before it can reach a message.
//   * Request and response objects are never passed on or printed.

import {
  A7_PROJECT_REF,
  FORBIDDEN_PRODUCTION_REF,
  extractSupabaseRef,
} from "@/lib/a7-guard";
import type { SentinelQueryExecutor, A7MutationAuthorization } from "@/lib/a7-sentinel-guard";
import { A7_QUERY_ENDPOINT, A7RunnerError, type A7EnvFile } from "./a7-mutate-lib";

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

/** Strip anything secret-shaped from endpoint error text, then cap it. */
export function scrubTransportText(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, "[redacted]")
    .replace(/sbp_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[redacted-uuid]")
    .replace(/[0-9a-f]{24,}/gi, "[redacted-hex]")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

export type A7SentinelReadTransport = {
  readonly executeSentinelQuery: SentinelQueryExecutor;
};

export type A7LiveTransport = A7SentinelReadTransport & {
  readonly executeMutation: (sql: string, file: string, auth: A7MutationAuthorization) => Promise<void>;
};

type A7Poster = (body: Record<string, unknown>, context: string) => Promise<unknown>;

/** Shared, private: asserts target invariants and binds the credential into a closure. */
function makeA7Poster(env: A7EnvFile, fetchImpl?: FetchLike): A7Poster {
  // Re-assert target invariants at construction (defense in depth — the
  // identity guard has already enforced all of this).
  if (!A7_QUERY_ENDPOINT.includes(`/projects/${A7_PROJECT_REF}/`)) throw new A7RunnerError("CONFIG_INVALID");
  if (A7_QUERY_ENDPOINT.includes(FORBIDDEN_PRODUCTION_REF)) throw new A7RunnerError("CONFIG_INVALID");
  if (extractSupabaseRef(env.NEXT_PUBLIC_SUPABASE_URL) !== A7_PROJECT_REF) throw new A7RunnerError("CONFIG_INVALID");
  const mgmtToken = env.A7_SUPABASE_MGMT_TOKEN;
  if (typeof mgmtToken !== "string" || mgmtToken === "") throw new A7RunnerError("ENV_MISSING_KEY", "A7_SUPABASE_MGMT_TOKEN");

  const doFetch: FetchLike = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  // The token exists only here. Never logged, never thrown, never in a URL.
  const post = async (body: Record<string, unknown>, context: string): Promise<unknown> => {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await doFetch(A7_QUERY_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${mgmtToken}`,
        },
        body: JSON.stringify(body),
      });
    } catch {
      // Transport-level failure: fixed message only; the cause could echo the
      // request (headers included), so it is deliberately dropped.
      throw new A7RunnerError("TRANSPORT_HTTP_ERROR", `${context}: network failure`);
    }
    if (!response.ok) {
      let detail = "";
      try {
        detail = scrubTransportText(await response.text());
      } catch {
        detail = "";
      }
      throw new A7RunnerError("TRANSPORT_HTTP_ERROR", `${context}: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
    }
    try {
      return await response.json();
    } catch {
      throw new A7RunnerError("TRANSPORT_HTTP_ERROR", `${context}: unparseable response`);
    }
  };

  return post;
}

/**
 * READ-ONLY transport for the authorization probe. Structurally incapable of
 * mutation: the returned object has no mutation member and `read_only: true`
 * is hard-coded into the one request shape it can produce. `env` must be the
 * parsed, guard-validated .env.a7 object; `fetchImpl` is injectable for tests
 * only (the CLIs pass nothing and get the platform fetch).
 */
export function createSentinelReadTransport(env: A7EnvFile, fetchImpl?: FetchLike): A7SentinelReadTransport {
  const post = makeA7Poster(env, fetchImpl);
  return {
    // Read-only sentinel verification (digest arrives as a bound parameter;
    // the SQL text itself is the fixed constant from a7-sentinel-guard).
    executeSentinelQuery: (sql, parameters) => post({ query: sql, parameters, read_only: true }, "sentinel-verification"),
  };
}

export type A7ReadOnlyQueryTransport = {
  /** One read-only query with bound parameters; read_only:true is hard-coded. */
  readonly executeReadOnlyQuery: (sql: string, parameters: readonly string[], context: string) => Promise<unknown>;
};

/**
 * General READ-ONLY transport for validators. Structurally incapable of
 * mutation: the returned object has no mutation member and `read_only: true`
 * is hard-coded into the one request shape it can produce. The `context`
 * string only labels sanitized error messages.
 */
export function createReadOnlyQueryTransport(env: A7EnvFile, fetchImpl?: FetchLike): A7ReadOnlyQueryTransport {
  const post = makeA7Poster(env, fetchImpl);
  return {
    executeReadOnlyQuery: (sql, parameters, context) => post({ query: sql, parameters, read_only: true }, context),
  };
}

export type A7FunctionalValidationTransport = A7SentinelReadTransport & {
  /** One read-only query with bound parameters; read_only:true is hard-coded. */
  readonly executeReadOnlyQuery: (sql: string, parameters: readonly string[], context: string) => Promise<unknown>;
  /**
   * One PARAMETERIZED mutation statement (Phase 2B functional validation only):
   * the SQL text is a fixed constant from the validator library, and every
   * runtime value — UUIDs, validation content, hashes, chunk JSON, marker
   * names — travels in the bound `parameters` array, never inside the SQL.
   * Refused without a live A7MutationAuthorization (sentinel-verified), same
   * gate as executeMutation. Returns the endpoint's result rows so the
   * validator can read back RPC results (e.g. knowledge_reindex_document's
   * jsonb) from the same request.
   */
  readonly executeParameterizedMutation: (
    sql: string,
    parameters: readonly string[],
    context: string,
    auth: A7MutationAuthorization,
  ) => Promise<unknown>;
};

/**
 * Transport for the Phase 2B functional validator. Built on the same pinned,
 * credential-closed poster as every other transport (A7 ref re-asserted and
 * production ref rejected at construction; errors scrubbed), with reads
 * hard-coded read_only:true and mutations gated on the sentinel authorization
 * value exactly like createLiveTransport.executeMutation.
 */
export function createFunctionalValidationTransport(env: A7EnvFile, fetchImpl?: FetchLike): A7FunctionalValidationTransport {
  const post = makeA7Poster(env, fetchImpl);
  return {
    executeSentinelQuery: (sql, parameters) => post({ query: sql, parameters, read_only: true }, "sentinel-verification"),
    executeReadOnlyQuery: (sql, parameters, context) => post({ query: sql, parameters, read_only: true }, context),
    executeParameterizedMutation: async (sql, parameters, context, auth) => {
      if (auth?.eligible !== true) throw new A7RunnerError("LIVE_CONFIRMATION_REQUIRED");
      return post({ query: sql, parameters, read_only: false }, context);
    },
  };
}

/** Full transport for the live mutation CLI only. Same poster, plus mutation. */
export function createLiveTransport(env: A7EnvFile, fetchImpl?: FetchLike): A7LiveTransport {
  const post = makeA7Poster(env, fetchImpl);
  return {
    executeSentinelQuery: (sql, parameters) => post({ query: sql, parameters, read_only: true }, "sentinel-verification"),
    // One migration file per request; the endpoint applies it atomically, so a
    // failure stops the sequence with nothing from the failing file applied.
    executeMutation: async (sql, file, auth) => {
      if (auth?.eligible !== true) throw new A7RunnerError("LIVE_CONFIRMATION_REQUIRED");
      await post({ query: sql, read_only: false }, file);
    },
  };
}
