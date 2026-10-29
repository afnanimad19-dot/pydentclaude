# Pydent Open Dental Connector — Security Audit & Hardening

Date: 2026-10-29
Branch: `claude/compassionate-gauss-urq2bj` (development only — nothing deployed, no production data touched, Callab.AI integrations and existing API keys untouched)
Scope: `opendental-connector/` (the middleware that runs inside the clinic next to Open Dental) plus a read of the Pydent-side gateway (`src/lib/opendental-gateway.ts`, unchanged).

## 1. Security findings (pre-hardening audit)

| # | Severity | Finding |
|---|---|---|
| 1 | **Critical** | **Auth bypass when `CLINIC_API_KEY` was unset:** the check was `req.headers["x-api-key"] !== process.env.CLINIC_API_KEY`. With the variable unset, a request *without* the header compared `undefined !== undefined` → **authenticated**. There was also no startup check that the key existed. |
| 2 | **High** | **Silent mock fall-back:** mock mode activated when `OPEN_DENTAL_MOCK=1` *or when the developer key was simply missing* — a mis-deployed "live" connector would quietly serve fabricated availability and accept fake bookings. |
| 3 | **High** | **Silent first-doctor/first-service selection:** `DOCTORS.find(...) || DOCTORS[0]` and `SERVICES[id] || Object.values(SERVICES)[0]` meant an unknown or missing doctor/service id booked **the wrong doctor and the wrong procedure** instead of failing. |
| 4 | **High** | **No read-only mode:** the three write endpoints were live as soon as the process ran. |
| 5 | **Medium** | **Upstream error leakage:** every handler returned `String(e.message)` to the caller; the OD client threw `data?.error` from Open Dental responses and raw `JSON.parse` SyntaxErrors — upstream text (which can include internal details) flowed to the remote caller. |
| 6 | **Medium** | **No request timeout** on Open Dental calls (a hung local API hung the connector request forever). No malformed-response handling (`JSON.parse(text)` uncaught). |
| 7 | **Medium** | **Non-timing-safe key comparison** (`!==`). |
| 8 | **Medium** | **No request validation:** dates, datetimes, durations, appointment ids and required booking fields were forwarded unchecked. |
| 9 | **Low** | `AUTH` header string was built at module load from possibly-undefined env (`ODFHIR undefined/undefined`). |
| 10 | **Low** | API-format bugs (see §4): `AptDateTime` sent as ISO-`T` instead of Open Dental's `yyyy-MM-dd HH:mm:ss`; cancel used a generic status update instead of the documented `/Break` endpoint; `ProcDescript` sent on create although it is not in the documented appointment schema. |
| 11 | Info | Patient data handling was already minimal (name/phone/email only, no clinical data) — kept that way. The health endpoint exposed mode only — kept, now also showing `readOnly`. Only test coverage was the mock smoke script. |

Pydent-side gateway (`src/lib/opendental-gateway.ts`): tenant-scoped config, 20 s timeouts, and safe network-failure messages already present; it already uses the documented `/Break` cancel and `yyyy-MM-dd HH:mm:ss` format in direct-API mode. **Not modified** in this pass (no change needed for connector hardening); its `create-appointment` "first open slot that day" operatory fall-back is flagged as a future item (§7).

## 2. Changes made

| File | Change |
|---|---|
| `src/config.js` (new) | Startup validation: mock **only** when `OPEN_DENTAL_MOCK=1`; live mode **fails startup** when `OPEN_DENTAL_DEVELOPER_KEY` / `OPEN_DENTAL_CUSTOMER_KEY` / a valid `OPEN_DENTAL_BASE_URL` is missing; `CLINIC_API_KEY` required in every mode (16+ chars); `OPEN_DENTAL_READ_ONLY` defaults **on** (only an explicit `0` disables); `OPEN_DENTAL_TIMEOUT_MS` (default 10 000, clamped 1 000–60 000). Errors name variables, never values. |
| `src/app.js` (new) | Express app factory (testable with injected data layer). Timing-safe `x-api-key` check (SHA-256 + `crypto.timingSafeEqual`), 401 on missing/incorrect key; read-only gate returns 403 on the three write endpoints **before** any Open Dental call; strict doctor/service lookups (unknown → 400, plus `service_not_offered`; no defaults ever); validation of date, datetime, duration (5–240 min integer), appointmentId, patNum, and required booking fields (name + phone, or an explicit patNum); fixed safe error table for upstream failures (no upstream text, no credentials, no patient data, **no mock fallback**); JSON body limit 64 kB and a safe JSON-parse error handler; health shows `{ok, mode, readOnly, service}` only. |
| `src/opendental.js` (rewritten) | Client factory with injected config (no module-load env reads); `AbortSignal.timeout` on every call; 401/403 → `od_auth_failed`, malformed JSON → `od_bad_response`, non-OK → `od_http_error`, network → `od_unreachable`/`od_timeout` — all thrown as `OdError` whose message is the machine code only, so upstream text can never leak. API-format fixes: `AptDateTime` converted to `yyyy-MM-dd HH:mm:ss`; cancel via documented `PUT /appointments/{AptNum}/Break {"sendToUnscheduledList":"true"}`; undocumented `ProcDescript`/`AptStatus` removed from create (service name goes in `Note`); slot responses validated as arrays and times shape-checked. |
| `src/server.js` (rewritten) | Thin entry point: `loadConfig()` → exit(1) with named problems → explicit mock/live data layer → `createApp` → listen. Log line shows mode + read-only state, never secrets. |
| `src/smoke.js` | Still the full mock-mode chain; now uses a ≥16-char key and sets `OPEN_DENTAL_READ_ONLY=0` explicitly (mock memory only) with an assertion that the flag took effect. |
| `src/mock.js`, `src/mappings.js` | Unchanged (mock data layer and clinic mapping table). |
| `.env.example`, `README.md`, `package.json` | Document the new safety model; `npm test` script added. |

Unchanged everywhere else: Pydent gateway, Callab.AI integrations, API keys, LiveKit/SIP/Asterisk/Raspberry Pi/Azure/WhatsApp, Netlify config, production data.

## 3. Tests executed

`cd opendental-connector && npm test` → **15/15 pass**; `npm run smoke` → PASSED. No test contacts a real Open Dental (stubbed data layers + a local throwaway HTTP server standing in for the OD API). Mapping to the required list:

1. Explicit mock mode — only `OPEN_DENTAL_MOCK=1` activates it (`"true"`, unset, missing keys do not).
2. Missing live credentials — startup validation fails, names variables, never prints values.
3. Read-only booking rejection — 403 on all three write endpoints, data layer provably untouched, reads still work.
4. Unknown doctor rejection — 400 `unknown_doctor`, no first-doctor fallback (data layer throws if reached).
5. Unknown service rejection — 400 `unknown_service` + `service_not_offered` for a mismatched doctor.
6. Missing shared secret — 401 with a bare `{error:"unauthorized"}`.
7. Invalid shared secret — 401; timing-safe helper also covered (differing lengths).
8. API timeout — hanging upstream → `od_timeout` → 504 `upstream_timeout`.
9. Open Dental auth failure — upstream 401 → `od_auth_failed` → 502; the documented `ODFHIR dev/cust` header is asserted on the wire.
10. OD API failure without mock fallback — upstream 500/malformed → typed errors; app responses carry **no** `slots` and no upstream text.
11. No patient data leakage — booking errors never echo name/phone/email; upstream error text containing fake patient data never reaches the client; health exposes mode flags only.
12. Mock smoke-test compatibility — `src/smoke.js` spawned as a subprocess, exits 0.

Root repo suite re-run after these changes: `npm test` at the repo root → **415/415 pass** (connector is a separate package; nothing in the main app imports it).

## 4. Open Dental API compatibility (version 25.4.65)

Verified against the official documentation at `opendental.com/site/api*` (API Setup, Appointments, Providers, Operatories, Patients, Local/Service API pages, current for the 25.4 line):

| Item | Documented | Connector status |
|---|---|---|
| Auth header | `Authorization: ODFHIR {DeveloperKey}/{CustomerKey}` | ✅ matches (asserted in tests) |
| Base URL | Local API `http://localhost:30222/api/v1` (runs inside opendental.exe, added 22.1); API Service port 30223 (added 22.2); Remote `https://api.opendental.com/api/v1` (needs eConnector — present at the clinic) | ✅ default matches Local API; Service/Remote documented in `.env.example` |
| Providers | `GET /providers` (21.1+), fields `ProvNum`, `FName`, `LName`, `IsHidden`, `Specialty` | ✅ (used by the Pydent gateway; connector uses the static mapping table) |
| Operatories | `GET /operatories` (21.1+), field is **`OperatoryNum`** (not `OpNum`), plus `OpName`, `Abbrev`, `IsHidden`, `ProvDentist`, `ProvHygienist` | ✅ documented; mapping values should be verified against it during setup |
| Slots | `GET /appointments/Slots` with optional `date` or `dateStart`/`dateEnd` (`yyyy-MM-dd`), `lengthMinutes`, `ProvNum`, `OpNum` (22.1+); response `[{DateTimeStart:"yyyy-MM-dd HH:mm:ss", DateTimeEnd, ProvNum, OpNum}]`; **dates must be today or later** | ✅ connector params match; response parsing shape-checked |
| Patients | `GET /patients?Phone=…`; `POST /patients` requires `LName`+`FName`, optional `WirelessPhone`, `Email` (21.1+) | ✅ matches |
| Create appointment | `POST /appointments` requires `PatNum`, `Op`, `AptDateTime` (`yyyy-MM-dd HH:mm:ss`) | ✅ fixed: datetime format converted; undocumented `ProcDescript`/`AptStatus` removed (service recorded in `Note`). Optional-field acceptance (`ProvNum`, `Note`) not yet proven against the clinic's install — write path stays disabled by default. |
| Reschedule | `PUT /appointments/{AptNum}` with `AptDateTime` | ✅ fixed datetime format |
| Cancel | `PUT /appointments/{AptNum}/Break` with `{"sendToUnscheduledList":"true"}`; only `Scheduled` appointments can be broken | ✅ switched to the documented endpoint |

**Uncertainty, stated plainly:** the documentation pages are the current public ones and do not carry a per-patch version stamp for 25.4.65; the involved endpoints predate 25.4 by years (21.1–22.2) and no deprecations are listed, but exact acceptance of optional create-fields on this install is unproven. **No authenticated request against the clinic's Open Dental has been made from this session** — nothing here claims a live connection test. Accordingly, live **booking stays disabled** (read-only default) until the read-only verification in §8 passes on the clinic's TEST database.

## 5. Required environment variables

| Variable | Required | Meaning |
|---|---|---|
| `CLINIC_API_KEY` | always (16+ chars) | Shared secret Pydent sends as `x-api-key`; startup fails without it |
| `OPEN_DENTAL_MOCK` | optional | `1` = explicit in-memory mock; anything else = live |
| `OPEN_DENTAL_READ_ONLY` | optional | default **on**; `0` enables booking (only after sign-off) |
| `OPEN_DENTAL_BASE_URL` | live mode | e.g. `http://localhost:30222/api/v1` (Local API) |
| `OPEN_DENTAL_DEVELOPER_KEY` | live mode | Open Dental Developer API key — startup fails if missing |
| `OPEN_DENTAL_CUSTOMER_KEY` | live mode | the clinic's existing Pydent-associated Customer API key — startup fails if missing |
| `OPEN_DENTAL_TIMEOUT_MS` | optional | upstream timeout, default 10000 (clamped 1000–60000) |
| `PORT` | optional | listen port (default 4000; the Cloudflare Tunnel points here) |

Secrets live in the clinic server's `.env` only (git-ignored); nothing is committed, logged, or returned in responses.

## 6. Safe Windows setup instructions (clinic TEST database)

1. Install Node.js 18+ on the machine next to Open Dental (25.4.65 with API enabled and the eConnector running — already the case).
2. In the repo: `cd opendental-connector`, then `npm install`, `npm test`, `npm run smoke` — all green with **no** Open Dental contact.
3. `copy .env.example .env` and set: a long random `CLINIC_API_KEY`; `OPEN_DENTAL_MOCK=0`; `OPEN_DENTAL_READ_ONLY=1` (leave the default); `OPEN_DENTAL_BASE_URL` for the **TEST-database** API instance; the existing developer/customer keys. Point it at the test database only — never production.
4. `npm start`. If any credential is missing, startup fails with the variable names — that is the hardening working.
5. Verify provider/operatory numbers in `src/mappings.js` against `GET /providers` and `GET /operatories` on the Open Dental API before trusting slot results.
6. Do **not** set `OPEN_DENTAL_READ_ONLY=0`, expose the tunnel, or enable booking in Pydent until §8 passes and the clinic signs off.

## 7. Remaining blockers / risks

1. **No live request has been made** — the first authenticated call against the clinic's test database may surface key-permission issues (the key needs read access to appointments/providers/operatories/patients) or install-specific behaviour.
2. `src/mappings.js` still holds placeholder provider/operatory numbers; they must be set from the clinic's real test-database values.
3. Optional create-appointment fields (`ProvNum`, `Note`) and the clinic's Break-procedure preferences are unverified; booking stays off until tested on the test DB.
4. Pydent-side gateway (out of this scope, flagged): its direct-API `create-appointment` falls back to "first open slot of the day" for the operatory when the requested time has no exact slot match — tighten before any live booking phase.
5. The Cloudflare Tunnel exposes the connector to the internet with only the shared secret; recommend Cloudflare Access (service token) in front of it before production, plus rotating any key that was ever shared in plain text.
6. `GET /appointments/Slots` only returns dates from today onward — callers asking for past dates get empty results by design.

## 8. Exact read-only connection test (the only live step authorized next)

On the clinic Windows server, after §6 steps 1–4, in PowerShell (replace the key):

```
$h = @{ "x-api-key" = "<your CLINIC_API_KEY>"; "Content-Type" = "application/json" }
# 1. Health — expect: ok, mode "live", readOnly true
Invoke-RestMethod -Uri http://localhost:4000/health
# 2. Auth gate — expect an error (401)
Invoke-RestMethod -Uri http://localhost:4000/doctors -SkipHttpErrorCheck -StatusCodeVariable sc; $sc
# 3. Mapped doctors/services
Invoke-RestMethod -Uri http://localhost:4000/doctors -Headers $h
Invoke-RestMethod -Uri http://localhost:4000/services -Headers $h
# 4. READ-ONLY live calls against the TEST database:
Invoke-RestMethod -Method Post -Uri http://localhost:4000/available-slots -Headers $h -Body '{"doctorId":"12","serviceId":"cleaning","date":"2026-11-03"}'
# 5. Write-path must be blocked — expect HTTP 403 read_only_mode
Invoke-RestMethod -Method Post -Uri http://localhost:4000/create-appointment -Headers $h -Body '{"name":"Test Patient","phone":"+971500000000","doctorId":"12","serviceId":"cleaning","datetime":"2026-11-03T10:00"}' -SkipHttpErrorCheck -StatusCodeVariable sc; $sc
```

Step 4 succeeding (a slots array, or a clean `od_*` error naming what to fix) is the
first genuine live-connection evidence; step 5 returning 403 proves booking cannot
happen. Report both outputs before any discussion of enabling writes.
