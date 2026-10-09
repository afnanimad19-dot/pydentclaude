// Pydent Phase 2B CANARY transport — THE ONLY NETWORK CODE IN THE CANARY TOOLING.
//
// READ-ONLY BY CONSTRUCTION. The object returned here has exactly one member,
// executeReadOnlyQuery, and every request it sends carries `read_only: true`
// (hard-coded; no caller can change it). There is no mutation transport in
// this build: migrations, the canary sentinel setup, privilege hardening and
// the Phase 2B functional validation all require a separately approved
// write-capable transport that does not exist yet.
//
// Targeting is pinned: every request goes to CANARY_QUERY_ENDPOINT, re-checked
// byte-for-byte immediately before each fetch. The SQL text and every bound
// parameter are scanned for the production and A7 refs and refused before any
// network use. Redirects are refused (`redirect: "error"`), so a response can
// never bounce a request to another project.
//
// Credentials: NONE are held here. The session proxy injects the
// canary-scoped Management API secret; this module sends no Authorization
// header and refuses to construct if a Supabase credential is visible in the
// environment or if Node's fetch would bypass the proxy.
//
// Observed Management API behaviour (read-only probes against the canary,
// 2026-10-08; NOT verified on the write path, where read-only mode is off):
//   * `parameters` present  -> extended protocol, exactly ONE statement
//                              (multi-statement text fails with 42601).
//   * no `parameters`       -> multi-statement text runs as ONE implicit
//                              transaction (a transaction-local GUC set in
//                              statement 1 is visible in statement 2); only
//                              the LAST statement's rows are returned; an
//                              explicit begin ... commit inside the text is
//                              honoured.

import {
  CANARY_QUERY_ENDPOINT,
  CanaryError,
  assertCanaryEndpoint,
  assertCanaryEnvironment,
  assertNoForbiddenRef,
  scrubCanaryText,
} from "./canary-guard";

export type CanaryFetchLike = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; redirect: "error" },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

/** The read-only executor shape every canary library consumes. Rejects on any error. */
export type CanaryReadOnlyExecutor = (sql: string, parameters: readonly string[], context: string) => Promise<unknown[]>;

export type CanaryReadOnlyTransport = { readonly executeReadOnlyQuery: CanaryReadOnlyExecutor };

/** Exactly the headers a canary request carries. No Authorization header, ever. */
export const CANARY_REQUEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({ "Content-Type": "application/json" });

export function createCanaryReadOnlyTransport(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl?: CanaryFetchLike,
): CanaryReadOnlyTransport {
  // Fail closed at construction: forbidden refs, A7 mode, local credentials,
  // missing proxy. Nothing below is reachable unless this passes.
  assertCanaryEnvironment(env);
  assertCanaryEndpoint(CANARY_QUERY_ENDPOINT);
  const doFetch: CanaryFetchLike = fetchImpl ?? (globalThis.fetch as unknown as CanaryFetchLike);

  const executeReadOnlyQuery: CanaryReadOnlyExecutor = async (sql, parameters, context) => {
    if (typeof sql !== "string" || sql.trim() === "") throw new CanaryError("SQL_INVALID", context);
    assertNoForbiddenRef(sql, `${context}: sql`);
    for (const p of parameters) {
      if (typeof p !== "string") throw new CanaryError("SQL_INVALID", `${context}: non-string parameter`);
      assertNoForbiddenRef(p, `${context}: parameter`);
    }

    const body: Record<string, unknown> = { query: sql, read_only: true };
    if (parameters.length > 0) body.parameters = [...parameters];

    const url = CANARY_QUERY_ENDPOINT;
    assertCanaryEndpoint(url); // re-checked immediately before every request

    let response: Awaited<ReturnType<CanaryFetchLike>>;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: { ...CANARY_REQUEST_HEADERS },
        body: JSON.stringify(body),
        redirect: "error",
      });
    } catch {
      // The cause may echo the request; drop it and report a fixed message.
      throw new CanaryError("TRANSPORT_HTTP_ERROR", `${context}: network failure`);
    }

    if (!response.ok) {
      let detail = "";
      try {
        detail = scrubCanaryText(await response.text());
      } catch {
        detail = "";
      }
      const code = response.status === 401 || response.status === 403 ? "AUTH_REJECTED" : "TRANSPORT_HTTP_ERROR";
      throw new CanaryError(code, `${context}: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
    }

    let rows: unknown;
    try {
      rows = await response.json();
    } catch {
      throw new CanaryError("RESULT_MALFORMED", `${context}: unparseable response`);
    }
    if (!Array.isArray(rows)) throw new CanaryError("RESULT_MALFORMED", context);
    return rows;
  };

  return Object.freeze({ executeReadOnlyQuery });
}
