# Pydent Smart Scheduling — Day 2 Report

Date: 2026-10-29
Branch: `claude/compassionate-gauss-urq2bj` (development only — nothing merged, deployed, or migrated)

## 0. Day-2 audit (Phase 1 findings, verified against the code)

- Day 1 delivered the full read-only availability stack (`src/lib/availability.ts`,
  `google-freebusy.ts`, `availability-server.ts`, `scheduling-tools.ts`, three
  `/api/scheduling/*` routes, proposed migration **0065**, 34 tests) and wired the
  two AI tools into `/api/agents/tool-exec` only.
- **There is no migration 0066 pre-existing in the repository.** The scheduling
  migrations are `0061_clinic_scheduling.sql` (clinic hours/grid — proposed, unapplied)
  and `0065_doctor_calendars.sql` (mapping table — proposed, unapplied). Day 2 adds
  `0066_doctor_calendars_day2.sql` (below).
- Day-1 live verification has since **passed on Windows** (service-account auth OK,
  FreeBusy HTTP 200, 845 ms, 1 busy interval on 2026-10-30 10:00–11:00 Asia/Dubai,
  134 open 30-minute starts, all 17 conflicting starts excluded) against the dedicated
  development calendar (`3d5883…fb41326@group.calendar.google.com`) and service account
  `pydent-calendar-reader@pydentai.iam.gserviceaccount.com`. The key stays in the
  environment (`GOOGLE_CALENDAR_SA_KEY_JSON`) — never in code, DB, logs, or docs.
- Day-2 gaps closed by this work: the mapping had no timezone and no way to
  distinguish test calendars; calendar ids had **no management API** (configurable
  only by hand-written SQL); the AI tools were unreachable from the LiveKit Builder
  HTTP adapter and WhatsApp; the `tool-exec` cases were ungated.

## 1. Files created

| File | Purpose |
|---|---|
| `supabase/migrations/0066_doctor_calendars_day2.sql` | **Proposed, NOT applied.** Additive: `timezone text` (per-doctor IANA override, NULL = clinic timezone) + `is_test boolean default false` (labels development-calendar mappings). Idempotent, reversible (drop the two columns). Requires 0065 first. |
| `src/lib/doctor-calendars-server.ts` | Mapping management: validation (name, calendar address shape, provider allow-list, IANA timezone) + upsert/remove with injected persistence; real Supabase wiring degrades clearly between migrations (0065-only deployments work; a timezone/is_test write without 0066 is refused with a precise message, never silently dropped). |
| `tests/scheduling-day2.test.mjs` | 13 new tests (see §4). |
| `docs/smart-scheduling/day-2-report.md` | This report. |

## 2. Files modified

| File | Change |
|---|---|
| `src/lib/availability.ts` | `isValidTimeZone()` helper (pure). |
| `src/lib/availability-server.ts` | Mapping rows carry `timezone`/`is_test`; per-doctor slot windows (clinic hours expressed in the doctor's timezone override when valid, clinic timezone otherwise — invalid stored values fall back, never throw); the single batched FreeBusy query now spans **every** doctor's window so an override can never push busy intervals outside the queried range (missed busy time would read as fabricated availability); per-doctor results report `timezone` and `test`; `realAvailabilityDeps.listDoctorCalendars` selects the 0066 columns and retries with the 0065 set when they don't exist. |
| `src/lib/scheduling-tools.ts` | Spoken output appends `[TEST calendar — demo data, not confirmed clinical availability]` whenever a test mapping contributed times. |
| `src/app/api/scheduling/doctors/route.ts` | GET includes `timezone`/`test` (calendar ids still masked); new **POST** (create/update one mapping) and **DELETE** (remove one) — both owner/admin-only, workspace always from the verified session. |
| `src/lib/agent-config.ts` | `AGENT_TOOLS` gains `check_doctor_availability` and `find_available_doctors` with a new `defaultOff` flag: they ship **OFF for every agent, new and existing**, so nothing changes in production until a clinic admin enables them. |
| `src/lib/builder-tools.ts` + `builder-tools-deps.ts` | Builder HTTP adapter serves the two tools through a new injected `executeScheduling` dep — same auth pipeline (workspace worker token, workspace-matched agent, per-agent tool gate → `tool_disabled` by default); responses carry the structured availability + spoken sentence, nothing bookable. |
| `src/app/api/agents/tool-exec/route.ts` | The Day-1 cases are now **gated on the agent's tool configuration** (default off) instead of being callable for any agent. |
| `src/lib/agent-reply.ts` | `toolsFor()` (now exported for tests) offers the two scheduling contracts — the exact shared definitions from `scheduling-tools.ts` — only when the new per-agent capability flags are on. |
| `src/app/api/whatsapp/webhook/route.ts` | Derives the flags from the agent's `voice_settings.tools` via `normalizeVoiceSettings` and routes the tool calls to `executeSchedulingTool` (defence-in-depth re-check inside `executeTool`). Default off ⇒ **zero behaviour change for active WhatsApp agents**; webhook verification, signatures, send paths untouched. |

Not touched: `livekit-agent/` (Python voice worker), `opendental-connector/`,
`ari-connector/`, dispatch rules, SIP/Asterisk/telephony, production WhatsApp
webhooks/config, Callab.AI calendars, Open Dental data. The deployed LiveKit worker
builds its tool list from known names only, so the new ids are inert for it until a
Day-3+ worker change deliberately registers them.

## 3. Architecture decisions

1. **One tool backend, three adapters.** `executeSchedulingTool()` stays the single
   executor; Builder HTTP, `tool-exec`, and WhatsApp each adapt transport/rendering
   only. No scheduling logic exists per channel.
2. **Opt-in by configuration, off by default.** The per-agent tool switchboard
   (`voice_settings.tools`, normalized by `normalizeVoiceSettings`) is the single gate
   used by all three channels. `defaultOff` guarantees existing agents — including
   production Laura and the WhatsApp agent — behave identically until explicitly
   enabled. This satisfies "prepare tools, don't enable behaviour".
3. **Timezone on the mapping is an override, not a replacement.** NULL (the default,
   and every existing row) means the clinic timezone; a valid IANA value computes that
   doctor's slots in their own timezone (remote/teleconsult case) while the batched
   FreeBusy window is widened to the union of all windows so no busy time is missed.
   An invalid stored value falls back to the clinic timezone at read time.
4. **Test vs clinical availability is data, not a hardcoded calendar id.** The
   `is_test` flag on the mapping row travels through the structured results
   (`doctors[].test`) and the spoken sentences, so the development calendar can never
   masquerade as confirmed clinical availability — without embedding any clinic- or
   calendar-specific identifier in application logic.
5. **Calendar ids are configuration with an admin API.** POST/DELETE on
   `/api/scheduling/doctors` (owner/admin only) replaces hand-written SQL; validation
   rejects non-calendar-shaped ids and bad timezones before persistence; between
   migrations the server refuses (with a precise message) rather than silently
   dropping fields.
6. **Fail truthful, degrade gracefully** (unchanged Day-1 rules): a failed FreeBusy
   call, missing table, or missing mapping is a labelled error — never an empty
   "fully free" calendar.

## 4. Tests executed

- `npm test`: **415/415 pass** (402 existing + 13 new in `tests/scheduling-day2.test.mjs`).
- `npx tsc --noEmit`: clean. `eslint` on all created/modified files: clean.
- New coverage mapped to the Phase-5 list (Day-1 tests already covered the rest —
  busy-period exclusion, auth failure, permission failure, timeout, durations,
  DST/timezone conversion, cross-tenant scoping, batching):
  1. **Doctor calendar mapping** — validation (name/address/provider/timezone), defaults, upsert/remove flows.
  2. **Multi-tenant isolation** — writes keyed only by the verified-session workspace; Builder token from another workspace → 403; tool args cannot smuggle a workspace.
  3. **Missing calendar mapping** — surfaces as `no_mapping` through the Builder adapter.
  4. **Busy-period exclusion** — re-verified through the timezone-override path.
  5./6./7. **Auth/permission failure, timeout** — auth-failure propagation re-verified end-to-end through the Builder adapter (`success:false`, zero slots).
  8. **Timezone handling** — per-doctor override computes slots in the doctor's tz, batched window spans all doctors (post-DST Berlin + Dubai), invalid override falls back to clinic tz.
  9. **Appointment duration** — `duration_min` honoured through the Builder adapter.
  10. **Read-only AI tool execution** — every booking/patient dep throws if touched (none is); tools disabled by default (`tool_disabled`, nothing executed); WhatsApp tool list offers the contracts only when flags are on; test-calendar labelling asserted in structured + spoken output.

## 5. Database migrations required (NOT run — apply manually in the Supabase SQL editor after review)

In order: **0061** (clinic hours/grid), **0065** (doctor_calendars), **0066** (timezone + is_test).
All three are additive, idempotent, and reversible; the server runs correctly at any
intermediate point (defensive reads/writes as described above). No production database
was touched from this session.

After applying, seed via the admin API (or SQL) — test configuration only, e.g.:
`POST /api/scheduling/doctors` with
`{ "doctor": "Dr. Leila Hariri", "calendar_id": "<dev calendar id>", "timezone": "", "is_test": true }`.

## 6. Environment variables required

- `GOOGLE_CALENDAR_SA_KEY_JSON` — full service-account JSON key (read-only FreeBusy
  scope), set in Netlify for the deployed app and locally for live tests. Absent ⇒
  `not_configured`, never fabricated availability. **Never commit or log it.**
- No new variables introduced by Day 2.

## 7. Security considerations

- Tenant isolation: workspace always from the verified session (`authorizeRequest`) or
  the workspace-bound worker token; every DB access filters by `workspace_id`; RLS
  policy from 0065 unchanged and covers the new columns.
- Mapping writes are owner/admin-only; listings keep masking calendar ids; responses
  still contain no credentials, event details (FreeBusy carries none), or raw ids.
- The tools are strictly read-only; booking/reschedule/cancel paths are untouched and
  unreachable from the new code (proven by throwing mocks in tests).
- Default-off gating means no agent — voice or WhatsApp — gains any new capability
  from this merge alone.
- Test availability is labelled end-to-end and can never read as confirmed clinical
  availability.
- Rate limiting remains platform-level (no bespoke limiter in this repo) — still an
  open consideration, unchanged from Day 1.

## 8. Outstanding blockers

1. Migrations 0061/0065/0066 must be reviewed and applied manually (Supabase SQL
   editor); until then availability reports `no_mapping` / default 09:00–17:00 hours.
2. `calendar_ids.txt` (the 13 doctor↔calendar mappings, plus the 2 extra calendars the
   administrator mentioned) is still not in this workspace — rows cannot be seeded
   beyond the development calendar without it.
3. The Supabase management API credential attached to this session still returns
   "Invalid access token", so live schema inspection/assisted migration from here
   remains blocked.
4. LiveKit **voice** delivery of the new tools needs a worker-side registration
   (Python) — deliberately out of scope until the HTTP adapter path is validated.

## 9. Windows verification commands (run in the repo root)

```
npm ci
npm test
npx tsc --noEmit
```

Live read-only calendar check (Day-1 runner, unchanged — requires
`GOOGLE_CALENDAR_SA_KEY_JSON` in the environment):

```
node --experimental-strip-types --import ./tests/alias-loader-register.mjs scripts/scheduling-live-test.mjs --calendar "3d5883c98eb2f0180032f1e9843e54bbebfb81ad1ba158424db91c161fb41326@group.calendar.google.com" --doctor "Dr. Leila Hariri" --date 2026-10-30 --tz Asia/Dubai --open 08:00 --close 21:00 --grid 5 --duration 30
```

API checks against a running dev server (`npm run dev`), PowerShell, with a logged-in
user's Supabase access token in `$tok` (after 0065/0066 are applied):

```
$h = @{ Authorization = "Bearer $tok" }
# Create the TEST mapping (owner/admin):
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/scheduling/doctors -Headers $h -ContentType "application/json" -Body '{"doctor":"Dr. Leila Hariri","calendar_id":"3d5883c98eb2f0180032f1e9843e54bbebfb81ad1ba158424db91c161fb41326@group.calendar.google.com","is_test":true}'
# List mappings (ids masked, test flag visible):
Invoke-RestMethod -Uri http://localhost:3000/api/scheduling/doctors -Headers $h
# Availability (expect the 10:00–11:00 busy block excluded and test labelling):
Invoke-RestMethod -Uri "http://localhost:3000/api/scheduling/availability?doctor=Dr.%20Leila%20Hariri&date=2026-10-30&duration=30" -Headers $h
```

Builder HTTP adapter (worker token from Pydent → Settings → LiveKit in `$wtok`,
an agent id with the tool enabled in `$agent`):

```
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/builder-tools/$agent/check_doctor_availability" -Headers @{ Authorization = "Bearer $wtok" } -ContentType "application/json" -Body '{"doctor":"Dr. Leila Hariri","date":"2026-10-30","duration_min":30}'
```

Expected without enabling the tool on the agent: HTTP 403 `tool_disabled` — that is the
default-off gate working.

## 10. Recommended Day 3 tasks

1. Apply 0061/0065/0066, seed LHDM clinic settings (08:00–21:00, 5-minute grid) and the
   doctor mappings once `calendar_ids.txt` is provided; re-run the live verification
   through the real API routes (not only the runner) and record latency.
2. Enable the two tools on a **dedicated test agent** (never production Laura/WhatsApp)
   and validate the full LLM round-trip on both channels.
3. Register the tools in the LiveKit Python worker (`livekit-agent/agent.py`
   `build_tools`) behind the same config switchboard, so voice calls can use them.
4. Small dashboard UI for the mapping admin API (list/create/deactivate, test-flag
   badge) — the endpoint contract is ready for it.
5. Design the booking write-path (Open Dental primary, conflict re-check at booking
   time, fallback queue/sync-status tables) — explicitly out of Day-2 scope.
6. Decide on a first-class doctors entity vs. name strings before bookings reference
   calendar mappings; revisit platform rate limiting for the scheduling routes.
