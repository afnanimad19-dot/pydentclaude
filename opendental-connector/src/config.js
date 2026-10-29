// Startup configuration — validated BEFORE the server accepts a single request.
//
// Security rules (non-negotiable):
//  * Mock mode activates ONLY with an explicit OPEN_DENTAL_MOCK=1. Missing live
//    credentials are a startup FAILURE, never a silent fall-back to mock data.
//  * Read-only mode (OPEN_DENTAL_READ_ONLY) is ON by default: booking,
//    rescheduling and cancelling are rejected unless the clinic explicitly
//    sets OPEN_DENTAL_READ_ONLY=0.
//  * CLINIC_API_KEY (the shared secret Pydent sends as x-api-key) is required
//    in every mode and must not be trivially short.
//  * Error messages name the missing VARIABLES only — never their values.

const MIN_KEY_LENGTH = 16;

export function loadConfig(env = process.env) {
  const errors = [];

  const mock = env.OPEN_DENTAL_MOCK === "1"; // explicit, nothing else counts
  const readOnly = env.OPEN_DENTAL_READ_ONLY !== "0"; // default ON

  const clinicApiKey = String(env.CLINIC_API_KEY ?? "");
  if (!clinicApiKey) {
    errors.push("CLINIC_API_KEY is not set. Set it to a long random string (the same value configured in Pydent → Settings → Open Dental).");
  } else if (clinicApiKey.length < MIN_KEY_LENGTH) {
    errors.push(`CLINIC_API_KEY is too short (needs at least ${MIN_KEY_LENGTH} characters). Use a long random string.`);
  }

  const baseUrl = String(env.OPEN_DENTAL_BASE_URL || "http://localhost:30222/api/v1").replace(/\/$/, "");
  const developerKey = String(env.OPEN_DENTAL_DEVELOPER_KEY ?? "");
  const customerKey = String(env.OPEN_DENTAL_CUSTOMER_KEY ?? "");
  if (!mock) {
    if (!developerKey) errors.push("OPEN_DENTAL_DEVELOPER_KEY is not set (required for live mode; set OPEN_DENTAL_MOCK=1 for the in-memory mock).");
    if (!customerKey) errors.push("OPEN_DENTAL_CUSTOMER_KEY is not set (required for live mode; set OPEN_DENTAL_MOCK=1 for the in-memory mock).");
    try {
      new URL(baseUrl);
    } catch {
      errors.push("OPEN_DENTAL_BASE_URL is not a valid URL (e.g. http://localhost:30222/api/v1 for the Local API).");
    }
  }

  const timeoutRaw = Number(env.OPEN_DENTAL_TIMEOUT_MS ?? 10000);
  const timeoutMs = Number.isFinite(timeoutRaw) ? Math.min(60000, Math.max(1000, Math.round(timeoutRaw))) : 10000;

  const port = Number(env.PORT ?? 4000) || 4000;

  if (errors.length) return { ok: false, errors };
  return { ok: true, config: { mock, readOnly, clinicApiKey, baseUrl, developerKey, customerKey, timeoutMs, port } };
}
