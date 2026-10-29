// Google Calendar FreeBusy client authenticated with a READ-ONLY service
// account (free/busy-only scope). Server-only.
//
// Credentials: the service-account JSON key lives in ONE env var,
// GOOGLE_CALENDAR_SA_KEY_JSON (Netlify → Site settings → Environment
// variables), matching the repo convention that server secrets are env-only
// and never sit in ordinary database columns or in the browser bundle. When
// it is absent the integration reports `not_configured` — callers must treat
// that as "availability unknown", NEVER as an empty calendar.
//
// This client can only call freeBusy: the OAuth scope requested is
// calendar.events.freebusy, and no event read/write functions exist here.
// Doctor calendars share free/busy visibility with the service account; event
// details (patient names etc.) are never returned by the FreeBusy API.

import { createSign } from "node:crypto";

export interface FreeBusyCalendarResult {
  busy: Array<{ start: string; end: string }>;
  // Google reports per-calendar failures INSIDE a 200 response (notFound,
  // accessDenied…). Surfaced so one broken calendar never poisons the rest.
  errors?: Array<{ reason?: string; domain?: string }>;
}

export interface FreeBusyResponse {
  ok: boolean;
  status: number;            // HTTP status of the (first failing) request
  error?: string;            // machine-readable: not_configured | auth_failed | api_error | timeout
  detail?: string;           // human detail, safe to log (no credentials)
  calendars: Record<string, FreeBusyCalendarResult>;
  tookMs: number;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export const FREEBUSY_SCOPE = "https://www.googleapis.com/auth/calendar.events.freebusy";
// Google caps a freeBusy query at 50 calendars (calendarExpansionMax limit);
// batch conservatively below that so group calendars still expand.
export const FREEBUSY_BATCH = 20;
const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
const DEFAULT_TIMEOUT_MS = 10_000;

export function parseServiceAccountKey(raw: string | undefined): ServiceAccountKey | null {
  if (!raw?.trim()) return null;
  try {
    const j = JSON.parse(raw);
    if (typeof j?.client_email === "string" && typeof j?.private_key === "string") {
      return { client_email: j.client_email, private_key: j.private_key, token_uri: j.token_uri };
    }
  } catch { /* malformed → not configured */ }
  return null;
}

export function googleCalendarConfigured(): boolean {
  return !!parseServiceAccountKey(process.env.GOOGLE_CALENDAR_SA_KEY_JSON);
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

// Sign a service-account JWT (RS256) and exchange it for an access token.
// Plain node:crypto — no new dependency; the key never leaves this module.
async function fetchAccessToken(key: ServiceAccountKey, fetchImpl: typeof fetch): Promise<{ token?: string; error?: string }> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const tokenUri = key.token_uri || "https://oauth2.googleapis.com/token";
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    scope: FREEBUSY_SCOPE,
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  }));
  let signature: string;
  try {
    signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(key.private_key).toString("base64url");
  } catch {
    return { error: "auth_failed" }; // malformed private key
  }
  try {
    const res = await fetchImpl(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${header}.${claims}.${signature}`,
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j?.access_token) return { error: "auth_failed" };
    return { token: String(j.access_token) };
  } catch {
    return { error: "auth_failed" };
  }
}

let tokenCache: { token: string; expiresAt: number } | null = null;

export interface FreeBusyQuery {
  timeMin: string;   // RFC3339
  timeMax: string;   // RFC3339
  timeZone: string;  // IANA — Google echoes busy times in UTC regardless; informational
  calendarIds: string[];
}

export interface FreeBusyDeps {
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to the cached service-account token. */
  getToken?: () => Promise<{ token?: string; error?: string }>;
  timeoutMs?: number;
}

async function defaultGetToken(fetchImpl: typeof fetch): Promise<{ token?: string; error?: string }> {
  const key = parseServiceAccountKey(process.env.GOOGLE_CALENDAR_SA_KEY_JSON);
  if (!key) return { error: "not_configured" };
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return { token: tokenCache.token };
  const t = await fetchAccessToken(key, fetchImpl);
  if (t.token) tokenCache = { token: t.token, expiresAt: Date.now() + 55 * 60_000 };
  return t;
}

// Query busy periods for up to many calendars, batched within Google's
// per-request calendar limit. Partial failure semantics: a request-level
// failure marks the whole response failed (callers must not offer slots);
// per-calendar errors come back inside `calendars[id].errors`.
export async function freeBusyQuery(q: FreeBusyQuery, deps: FreeBusyDeps = {}): Promise<FreeBusyResponse> {
  const started = Date.now();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const done = (r: Omit<FreeBusyResponse, "tookMs">): FreeBusyResponse => ({ ...r, tookMs: Date.now() - started });

  if (!q.calendarIds.length) return done({ ok: true, status: 200, calendars: {} });
  const auth = await (deps.getToken ?? (() => defaultGetToken(fetchImpl)))();
  if (!auth.token) return done({ ok: false, status: 401, error: auth.error ?? "auth_failed", calendars: {} });

  const calendars: Record<string, FreeBusyCalendarResult> = {};
  for (let i = 0; i < q.calendarIds.length; i += FREEBUSY_BATCH) {
    const batch = q.calendarIds.slice(i, i + FREEBUSY_BATCH);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetchImpl(FREEBUSY_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          timeMin: q.timeMin,
          timeMax: q.timeMax,
          timeZone: q.timeZone,
          items: batch.map((id) => ({ id })),
        }),
        signal: controller.signal,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = typeof j?.error?.message === "string" ? j.error.message.slice(0, 200) : `HTTP ${res.status}`;
        return done({ ok: false, status: res.status, error: res.status === 401 || res.status === 403 ? "auth_failed" : "api_error", detail, calendars });
      }
      for (const id of batch) {
        const c = j?.calendars?.[id];
        calendars[id] = {
          busy: Array.isArray(c?.busy) ? c.busy : [],
          ...(Array.isArray(c?.errors) && c.errors.length ? { errors: c.errors } : {}),
        };
      }
    } catch (e) {
      const aborted = e instanceof Error && e.name === "AbortError";
      return done({ ok: false, status: 0, error: aborted ? "timeout" : "api_error", detail: aborted ? "Google API timeout" : "network error", calendars });
    } finally {
      clearTimeout(timer);
    }
  }
  return done({ ok: true, status: 200, calendars });
}
