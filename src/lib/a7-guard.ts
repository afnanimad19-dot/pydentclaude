// Pydent A7 safety guard — FAILS CLOSED.
//
// Pure, dependency-free, side-effect-free validation of the A7 target
// configuration. It performs NO network and NO database I/O: every check is a
// string comparison against the environment, so a refusal can never touch
// (let alone modify) any database. It is safe to run in the Node runtime, the
// Edge runtime, next.config.ts, and plain Node test processes.
//
// The codebase still contains hardcoded production Supabase fallbacks of the
// form `process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://<prod>.supabase.co"`.
// This stage does NOT remove them. Instead, when A7 mode is active
// (A7_MODE env var is set), the guard refuses to let the process start unless
// NEXT_PUBLIC_SUPABASE_URL is present and resolves EXACTLY to the A7 project —
// which makes every one of those fallbacks unreachable, because they only
// engage when the env var is absent.
//
// Error messages name env var KEYS and project refs only (refs are not
// secrets — they appear in public URLs). No env var VALUES other than the
// two ref/URL variables under test are ever included in an error.

/** The one Supabase project A7 work is allowed to target. */
export const A7_PROJECT_REF = "etbuylimyelwoxxowtbx";

/** The exact URL NEXT_PUBLIC_SUPABASE_URL must hold (no trailing slash). */
export const A7_SUPABASE_URL = `https://${A7_PROJECT_REF}.supabase.co`;

/** The production project A7 must NEVER touch. Blocking it outranks every other check. */
export const FORBIDDEN_PRODUCTION_REF = "mzqynjywncbvqfikbzgm";

export type A7GuardFailureCode =
  | "PRODUCTION_TARGET_BLOCKED" // forbidden production ref present anywhere in the env
  | "A7_MODE_MISSING"
  | "A7_MODE_INVALID" // set, but not exactly "1"
  | "EXPECTED_REF_MISSING"
  | "EXPECTED_REF_MISMATCH" // A7_EXPECTED_REF !== A7_PROJECT_REF
  | "SUPABASE_URL_MISSING" // unset/empty — the case where legacy fallbacks would engage
  | "SUPABASE_URL_MALFORMED" // ref cannot be extracted exactly
  | "REF_MISMATCH" // extracted ref !== expected ref, or !== A7_PROJECT_REF
  | "SUPABASE_URL_MISMATCH"; // not byte-for-byte the A7 URL

export type A7GuardResult =
  | { ok: true; ref: string; url: string }
  | { ok: false; code: A7GuardFailureCode; reason: string };

export class A7GuardError extends Error {
  readonly code: A7GuardFailureCode;
  constructor(code: A7GuardFailureCode, reason: string) {
    super(`A7 GUARD REFUSED [${code}]: ${reason}`);
    this.name = "A7GuardError";
    this.code = code;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Extract the project ref from a Supabase URL, accepting ONLY the exact shape
 * `https://<ref>.supabase.co` — 20 lowercase alphanumerics, no credentials,
 * port, path (not even a trailing slash), query, or fragment. Anything else
 * (including `https://<ref>.supabase.co.evil.com`) returns null.
 */
export function extractSupabaseRef(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co$/.exec(url);
  return m ? m[1] : null;
}

/**
 * Env var keys whose value contains the forbidden production ref. Scans EVERY
 * key (not just known database keys) so a production target can never hide in
 * an unanticipated variable — fail closed. Returns key names only, never values.
 */
export function findProductionTargets(env: Env): string[] {
  const hits: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value.includes(FORBIDDEN_PRODUCTION_REF)) hits.push(key);
  }
  return hits.sort();
}

/** True when this process was explicitly put in A7 mode (A7_MODE set to anything). */
export function isA7ModeConfigured(env: Env = process.env): boolean {
  return env.A7_MODE !== undefined;
}

/**
 * Validate the A7 target configuration. Never throws; returns a result.
 * Check order (production blocking FIRST — it outranks everything):
 *   1. forbidden production ref anywhere in the env        -> PRODUCTION_TARGET_BLOCKED
 *   2. A7_MODE missing / not exactly "1"                   -> A7_MODE_MISSING / A7_MODE_INVALID
 *   3. A7_EXPECTED_REF missing / not the A7 ref            -> EXPECTED_REF_*
 *   4. NEXT_PUBLIC_SUPABASE_URL missing (fallbacks would
 *      engage here — abort instead of falling through)     -> SUPABASE_URL_MISSING
 *   5. ref not extractable exactly                         -> SUPABASE_URL_MALFORMED
 *   6. ref != A7_EXPECTED_REF, ref != A7_PROJECT_REF       -> REF_MISMATCH
 *   7. URL not byte-for-byte the A7 URL                    -> SUPABASE_URL_MISMATCH
 */
export function checkA7Config(env: Env = process.env): A7GuardResult {
  const fail = (code: A7GuardFailureCode, reason: string): A7GuardResult => ({ ok: false, code, reason });

  // 1. Production blocking takes priority over every other check.
  const productionKeys = findProductionTargets(env);
  if (productionKeys.length > 0) {
    return fail(
      "PRODUCTION_TARGET_BLOCKED",
      `forbidden production ref ${FORBIDDEN_PRODUCTION_REF} present in env var(s): ${productionKeys.join(", ")}`,
    );
  }

  // 2. A7_MODE must be exactly "1".
  const mode = env.A7_MODE;
  if (mode === undefined || mode === "") return fail("A7_MODE_MISSING", "A7_MODE is not set");
  if (mode !== "1") return fail("A7_MODE_INVALID", 'A7_MODE is set but is not exactly "1"');

  // 3. A7_EXPECTED_REF must be present and must be the A7 ref.
  const expected = env.A7_EXPECTED_REF;
  if (expected === undefined || expected === "") return fail("EXPECTED_REF_MISSING", "A7_EXPECTED_REF is not set");
  if (expected !== A7_PROJECT_REF) {
    return fail("EXPECTED_REF_MISMATCH", `A7_EXPECTED_REF is not the A7 project ref ${A7_PROJECT_REF}`);
  }

  // 4. NEXT_PUBLIC_SUPABASE_URL must be present. When it is absent the legacy
  //    hardcoded production fallbacks would engage — abort instead.
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  if (url === undefined || url === "") {
    return fail(
      "SUPABASE_URL_MISSING",
      "NEXT_PUBLIC_SUPABASE_URL is not set; refusing to fall through to any hardcoded fallback",
    );
  }

  // 5. The ref must be extractable from the exact URL shape.
  const ref = extractSupabaseRef(url);
  if (ref === null) {
    return fail("SUPABASE_URL_MALFORMED", `NEXT_PUBLIC_SUPABASE_URL (${JSON.stringify(url)}) is not exactly https://<ref>.supabase.co`);
  }

  // 6. The actual ref must equal both the expected ref and the A7 ref.
  //    (The forbidden ref can't reach here — step 1 already blocked it.)
  if (ref !== expected) return fail("REF_MISMATCH", `actual ref ${ref} != A7_EXPECTED_REF`);
  if (ref !== A7_PROJECT_REF) return fail("REF_MISMATCH", `actual ref ${ref} != A7 project ref ${A7_PROJECT_REF}`);

  // 7. Byte-for-byte URL equality (defense in depth over the regex).
  if (url !== A7_SUPABASE_URL) {
    return fail("SUPABASE_URL_MISMATCH", `NEXT_PUBLIC_SUPABASE_URL is not exactly ${A7_SUPABASE_URL}`);
  }

  return { ok: true, ref, url };
}

/** Like checkA7Config, but throws A7GuardError on any failure. */
export function assertA7Safe(env: Env = process.env): { ref: string; url: string } {
  const result = checkA7Config(env);
  if (!result.ok) throw new A7GuardError(result.code, result.reason);
  return { ref: result.ref, url: result.url };
}

/**
 * Startup enforcement, called from next.config.ts (build/dev/start) and
 * src/instrumentation.ts (server boot). FAILS CLOSED: if A7_MODE is set to
 * ANY value — even one that would mean "off", like "0" — the full guard runs
 * and the process refuses to start unless the configuration is exactly A7.
 * When A7_MODE is entirely absent (normal production deploys), it is a no-op.
 */
export function enforceA7StartupGuard(env: Env = process.env): { active: boolean; ref?: string } {
  if (!isA7ModeConfigured(env)) return { active: false };
  const { ref } = assertA7Safe(env);
  return { active: true, ref };
}

/**
 * Tripwire for the moment a Supabase client URL has been RESOLVED (env var or
 * legacy fallback). In A7 mode it throws if the resolved URL is anything but
 * the exact A7 URL — so a fallback can never be used silently. Outside A7 mode
 * (A7_MODE absent, e.g. existing production deploys and the browser bundle,
 * where A7_MODE is never inlined) it changes nothing and returns the URL.
 */
export function a7AssertResolvedSupabaseUrl(resolvedUrl: string, env: Env = process.env): string {
  if (typeof resolvedUrl === "string" && resolvedUrl.includes(FORBIDDEN_PRODUCTION_REF) && isA7ModeConfigured(env)) {
    throw new A7GuardError(
      "PRODUCTION_TARGET_BLOCKED",
      "resolved Supabase URL targets the forbidden production project while A7 mode is configured",
    );
  }
  if (!isA7ModeConfigured(env)) return resolvedUrl;
  if (resolvedUrl !== A7_SUPABASE_URL) {
    throw new A7GuardError(
      "SUPABASE_URL_MISMATCH",
      `A7 mode is configured but the resolved Supabase URL is not exactly ${A7_SUPABASE_URL}`,
    );
  }
  assertA7Safe(env); // full fail-closed validation (A7_MODE must be exactly "1", refs must match)
  return resolvedUrl;
}
