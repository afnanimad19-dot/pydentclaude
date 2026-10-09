// Pydent Phase 2B CANARY target guard — FAILS CLOSED. NETWORK-FREE.
//
// OPERATOR/TOOLING ONLY. Lives outside src/ so nothing in the Next.js app can
// import it. Independent of the A7 guard (src/lib/a7-guard.ts), which stays
// byte-for-byte unchanged and keeps its own A7-only target lock: this module
// never imports it, so neither lock can be loosened through the other.
//
// The canary is reached ONLY through the session's network proxy, which
// injects a Management API credential scoped to exactly
// /v1/projects/<CANARY_PROJECT_REF>/. This tooling therefore holds NO
// credential of its own: it never reads .env files, never reads a token from
// process.env, and never sends an Authorization header. A Supabase credential
// visible in the environment is treated as a misconfiguration and refused, so
// the proxy-injected canary secret stays the single path to the database.
//
// Every check below is a string comparison — a refusal can never touch any
// database. Error messages are FIXED per code and may carry, at most, env var
// KEY names or project refs (refs are public; they appear in URLs).

/** The one Supabase project this tooling may target. Hardcoded; no override exists. */
export const CANARY_PROJECT_REF = "thqjtoxzkujnljsmkwkp";

/** The one URL a canary request may ever be sent to. */
export const CANARY_QUERY_ENDPOINT = `https://api.supabase.com/v1/projects/${CANARY_PROJECT_REF}/database/query`;

/**
 * Projects canary tooling must NEVER contact. Production outranks A7 and is
 * checked first everywhere. Literals on purpose (not imported from the A7
 * guard); a test asserts they equal the A7 guard's constants.
 */
export const FORBIDDEN_PRODUCTION_REF = "mzqynjywncbvqfikbzgm";
export const FORBIDDEN_A7_REF = "etbuylimyelwoxxowtbx";
export const FORBIDDEN_PROJECT_REFS = [FORBIDDEN_PRODUCTION_REF, FORBIDDEN_A7_REF] as const;

export type CanaryFailureCode =
  | "PRODUCTION_REF_BLOCKED" // the production ref appears in env, SQL, parameters or a URL
  | "A7_REF_BLOCKED" // the A7 ref appears in env, SQL, parameters or a URL
  | "A7_MODE_SET" // A7_MODE is set: A7 and canary tooling must never share a process
  | "LOCAL_SUPABASE_CREDENTIAL" // a Supabase credential is visible locally; only the proxy secret may be used
  | "PROXY_MISSING" // HTTPS_PROXY unset: the canary credential is only injected by the proxy
  | "NODE_ENV_PROXY_DISABLED" // NODE_USE_ENV_PROXY !== "1": Node's fetch would bypass the proxy
  | "ENDPOINT_MISMATCH" // a request URL is not byte-for-byte CANARY_QUERY_ENDPOINT
  | "CONFIRMATION_REQUIRED"
  | "INVALID_ARGS"
  | "SQL_INVALID" // empty or non-string SQL
  | "AUTH_REJECTED" // HTTP 401/403: the injected credential was absent or lacks permission
  | "TRANSPORT_HTTP_ERROR"
  | "RESULT_MALFORMED"
  | "MANIFEST_SOURCE_CHANGED" // scripts/a7-manifest.ts is not the reviewed byte-for-byte file
  | "MANIFEST_STEP_ORDER" // the manifest's step order is not the reviewed dependency order
  | "MANIFEST_INVALID" // a step failed the A7 closed-world manifest validation
  | "GUARD_SCHEMA_REFERENCED" // a migration references a7_guard or canary_guard
  | "TRANSACTION_UNSAFE" // a migration contains statements that cannot run inside one transaction
  | "PREFLIGHT_NOT_READ_ONLY" // the database session is not the read-only role / read-only transaction
  | "SENTINEL_TOKEN_MISSING"
  | "SENTINEL_TOKEN_MALFORMED"
  | "SENTINEL_TOKEN_EXPOSED"
  | "SENTINEL_QUERY_FAILED"
  | "SENTINEL_RESULT_MALFORMED"
  | "SENTINEL_MISSING"
  | "SENTINEL_ROW_COUNT_INVALID"
  | "SENTINEL_ID_MISMATCH"
  | "SENTINEL_REF_MISMATCH"
  | "SENTINEL_TOKEN_MISMATCH";

const MESSAGES: Record<CanaryFailureCode, string> = {
  PRODUCTION_REF_BLOCKED: `the production project ref ${FORBIDDEN_PRODUCTION_REF} is present; canary tooling refuses before any network use`,
  A7_REF_BLOCKED: `the A7 project ref ${FORBIDDEN_A7_REF} is present; canary tooling refuses before any network use`,
  A7_MODE_SET: "A7_MODE is set; A7 and canary tooling must never run in the same process",
  LOCAL_SUPABASE_CREDENTIAL:
    "a Supabase credential is visible in the environment; only the proxy-injected canary secret may be used",
  PROXY_MISSING: "HTTPS_PROXY is not set; the canary credential is only available through the session proxy",
  NODE_ENV_PROXY_DISABLED: 'NODE_USE_ENV_PROXY is not "1"; Node fetch would bypass the session proxy',
  ENDPOINT_MISMATCH: "request URL is not the pinned canary query endpoint; refusing",
  CONFIRMATION_REQUIRED: "this command requires its exact confirmation phrase; refusing",
  INVALID_ARGS: "invalid arguments",
  SQL_INVALID: "SQL text must be a non-empty string",
  AUTH_REJECTED: "the canary endpoint rejected the request's credential (HTTP 401/403); nothing was executed",
  TRANSPORT_HTTP_ERROR: "the canary query endpoint returned an error; stopped at the failing request",
  RESULT_MALFORMED: "the canary query endpoint returned a result that is not a row array",
  MANIFEST_SOURCE_CHANGED: "scripts/a7-manifest.ts does not match the reviewed hash-pinned manifest",
  MANIFEST_STEP_ORDER: "the manifest step order differs from the reviewed dependency order",
  MANIFEST_INVALID: "a manifest step failed hash-pinned closed-world validation",
  GUARD_SCHEMA_REFERENCED: "a migration references a guard schema (a7_guard / canary_guard); refusing",
  TRANSACTION_UNSAFE: "a migration contains statements that cannot be wrapped in a single transaction",
  PREFLIGHT_NOT_READ_ONLY: "the canary session is not read-only; preflight stopped before any further query",
  SENTINEL_TOKEN_MISSING: "CANARY_SENTINEL_TOKEN is not set; mutations are not authorized",
  SENTINEL_TOKEN_MALFORMED: "CANARY_SENTINEL_TOKEN is not a well-formed UUID; refusing",
  SENTINEL_TOKEN_EXPOSED: "CANARY_SENTINEL_TOKEN value appears in a NEXT_PUBLIC_* variable; refusing",
  SENTINEL_QUERY_FAILED: "canary sentinel verification query failed (sentinel missing or unreachable); refusing",
  SENTINEL_RESULT_MALFORMED: "canary sentinel verification returned a malformed result; refusing",
  SENTINEL_MISSING: "canary sentinel row is missing; refusing",
  SENTINEL_ROW_COUNT_INVALID: "canary sentinel does not contain exactly one row; refusing",
  SENTINEL_ID_MISMATCH: "canary sentinel id is not 1; refusing",
  SENTINEL_REF_MISMATCH: "canary sentinel project_ref is not the canary project; refusing",
  SENTINEL_TOKEN_MISMATCH: "canary sentinel digest does not match CANARY_SENTINEL_TOKEN; refusing",
};

export class CanaryError extends Error {
  readonly code: CanaryFailureCode;
  /** Key name / filename / check name / scrubbed transport text ONLY — never a secret value. */
  readonly detail?: string;
  constructor(code: CanaryFailureCode, detail?: string) {
    super(`CANARY REFUSED [${code}]: ${MESSAGES[code]}${detail ? ` (${detail})` : ""}`);
    this.name = "CanaryError";
    this.code = code;
    this.detail = detail;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Throw if `text` names a forbidden project. Production first. Used on env
 * values, SQL text, bound parameters and request URLs alike.
 */
export function assertNoForbiddenRef(text: string, where: string): void {
  if (text.includes(FORBIDDEN_PRODUCTION_REF)) throw new CanaryError("PRODUCTION_REF_BLOCKED", where);
  if (text.includes(FORBIDDEN_A7_REF)) throw new CanaryError("A7_REF_BLOCKED", where);
}

/** Env var KEYS (never values) that look like a locally held Supabase credential. */
export function findLocalSupabaseCredentials(env: Env): string[] {
  const hits: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || value === "") continue;
    const keyLooksSecret =
      /SUPABASE.*(KEY|TOKEN|SECRET|PASS)/i.test(key) ||
      /^(A7_SUPABASE_MGMT_TOKEN|A7_SENTINEL_TOKEN|PGPASSWORD|SUPABASE_DB_PASSWORD)$/.test(key);
    const valueLooksSecret = /\bsbp_[A-Za-z0-9]{8,}/.test(value) || /^postgres(ql)?:\/\/[^@\s]*:[^@\s]+@/i.test(value);
    if (keyLooksSecret || valueLooksSecret) hits.push(key);
  }
  return hits.sort();
}

/**
 * Validate the process environment for canary network use. Never throws;
 * returns the first failure. Order (forbidden projects FIRST):
 *   1. production ref anywhere in any env value         -> PRODUCTION_REF_BLOCKED
 *   2. A7 ref anywhere in any env value                 -> A7_REF_BLOCKED
 *   3. A7_MODE set                                      -> A7_MODE_SET
 *   4. a local Supabase credential is visible           -> LOCAL_SUPABASE_CREDENTIAL
 *   5. no HTTPS proxy (credential can only come from it) -> PROXY_MISSING
 *   6. Node fetch not configured to use the env proxy   -> NODE_ENV_PROXY_DISABLED
 */
export function checkCanaryEnvironment(
  env: Env,
): { ok: true; ref: typeof CANARY_PROJECT_REF } | { ok: false; code: CanaryFailureCode; detail?: string } {
  for (const ref of FORBIDDEN_PROJECT_REFS) {
    const keys = Object.entries(env)
      .filter(([, v]) => typeof v === "string" && v.includes(ref))
      .map(([k]) => k)
      .sort();
    if (keys.length > 0) {
      return {
        ok: false,
        code: ref === FORBIDDEN_PRODUCTION_REF ? "PRODUCTION_REF_BLOCKED" : "A7_REF_BLOCKED",
        detail: `env var(s): ${keys.join(", ")}`,
      };
    }
  }
  if (env.A7_MODE !== undefined) return { ok: false, code: "A7_MODE_SET" };
  const creds = findLocalSupabaseCredentials(env);
  if (creds.length > 0) return { ok: false, code: "LOCAL_SUPABASE_CREDENTIAL", detail: `env var(s): ${creds.join(", ")}` };
  if (!env.HTTPS_PROXY && !env.https_proxy) return { ok: false, code: "PROXY_MISSING" };
  if (env.NODE_USE_ENV_PROXY !== "1") return { ok: false, code: "NODE_ENV_PROXY_DISABLED" };
  return { ok: true, ref: CANARY_PROJECT_REF };
}

/** Throwing form of checkCanaryEnvironment. */
export function assertCanaryEnvironment(env: Env): void {
  const r = checkCanaryEnvironment(env);
  if (!r.ok) throw new CanaryError(r.code, r.detail);
}

/** A request URL must be byte-for-byte the pinned endpoint (no prefix/suffix tricks). */
export function assertCanaryEndpoint(url: string): void {
  assertNoForbiddenRef(url, "request url");
  if (url !== CANARY_QUERY_ENDPOINT) throw new CanaryError("ENDPOINT_MISMATCH");
}

/** Strip anything secret-shaped from text that may reach a message, then cap it. */
export function scrubCanaryText(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, "[redacted]")
    .replace(/sbp_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[redacted-uuid]")
    .replace(/[0-9a-f]{24,}/gi, "[redacted-hex]")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}
