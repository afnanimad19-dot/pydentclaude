# Pydent Smart Scheduling — Architecture Audit (Day 1)

Date: 2026-10-29 · Branch: `claude/compassionate-gauss-urq2bj`

This audit records what actually exists in the repository (verified by reading
the code, not assumed) and where the Smart Scheduling module plugs in.

## 1. Framework and project structure

| Component | Finding |
|---|---|
| Framework | Next.js **16.2.9** (App Router) + React 19, TypeScript strict, Tailwind 4 |
| Routing | `src/app/api/**/route.ts` route handlers (`GET`/`POST` exports, `NextRequest`/`NextResponse`, async `ctx.params`) — verified against the bundled docs in `node_modules/next/dist/docs/` (route-handler conventions unchanged from the repo's existing usage) |
| Deployment | Netlify (`netlify.toml` declares `netlify/functions` for scheduled crons: `master-cron.mjs`, `broadcast-cron.mjs`, `ig-publish-cron.mjs`). Server env vars live in Netlify site settings |
| Database | Supabase Postgres (`mzqynjywncbvqfikbzgm.supabase.co`) + Supabase Auth. Migrations in `supabase/migrations/0001…0064` are applied **manually in the Supabase SQL editor** (several recent ones are marked "PROPOSED — NOT YET APPLIED", e.g. `0061_clinic_scheduling.sql`) |
| Tests | `node --test` over `tests/*.test.mjs`, importing app TypeScript directly via `--experimental-strip-types` and the `@/` alias loader (`tests/alias-loader.mjs`). Style: pure logic modules + dependency-injected service wrappers, fictional data, no network |
| Side services | `livekit-agent/` (Python voice worker), `opendental-connector/`, `ari-connector/` — deployed separately; **not touched** by this work |

## 2. Authentication & tenant model

- Tenant = **workspace** (`workspace_id` on every data table). Clinic ≈ workspace;
  `workspaces_multi` (0058) allows one user in several workspaces with one ACTIVE
  workspace (`profiles.workspace_id`).
- Browser → API: `authorizeRequest()` (`src/lib/server-auth-deps.ts` binding
  `src/lib/server-auth.ts`): Supabase bearer token → user → **active workspace**
  → membership role (`workspace_members`, invited staff via `team_members`).
  A `ws` sent by the browser is **never trusted** in the current-generation routes.
  (Some legacy routes, e.g. `api/opendental/doctors`, still take `?ws=` — a known
  older pattern; new scheduling routes must NOT copy it.)
- Server-to-server (webhooks, crons, voice worker): `supabaseAdmin`
  (service-role key, **bypasses RLS**) — every module filters by `workspace_id`
  itself. RLS: migration 0050 applies `workspace_id = current_workspace()`
  policies to all tables with a `workspace_id` column (function defined in 0014/0020/0021).
- Machine channel auth: LiveKit Builder HTTP tools authenticate with a
  **per-workspace worker token** (`livekit_config.worker_token`, resolved by
  `src/lib/worker-token.ts`, workspace binding wins over the global env token).

## 3. AI agent tool execution paths (traced)

All three channels converge on **one shared backend** (`src/lib/booking-server.ts`):

1. **WhatsApp AI** — `src/app/api/whatsapp/webhook/route.ts` runs the LLM loop and
   its `executeTool()` dispatches `get_available_slots` / `book_appointment` /
   `reschedule_appointment` / `cancel_appointment` / `send_email` straight into
   `booking-server.ts` functions with the webhook-resolved `ws`.
2. **Voice (LiveKit Builder HTTP Actions)** — Builder POSTs flat JSON to
   `/api/builder-tools/<agentId>/<tool>` (worker-token auth). All logic is in the
   pure `src/lib/builder-tools.ts` with injected `BuilderToolDeps`
   (`builder-tools-deps.ts` wires real services), returning structured
   `{ success, reason, spoken, … }` JSON.
3. **Voice (in-browser realtime session)** — browser posts tool calls to
   `/api/agents/tool-exec` (`{agentId, name, args}`), which switches on tool name
   into the same `booking-server.ts` / `agent-tools-core.ts` functions.

**Integration conclusion:** a new scheduling capability should be a tenant-scoped
library function (like `getSlotsStructured`) that each channel adapter calls —
exactly the existing pattern. New tools get: a case in `tool-exec`, a handler in
`builder-tools.ts` (via `BuilderToolDeps`), and a case in the WhatsApp
`executeTool()` — no logic duplication. Day 1 implements the shared backend +
contracts only; channel wiring into *production agent configs* is deferred.

## 4. Existing appointment / calendar functionality

- `appointments` table (free-text `provider` string for the doctor, `date`,
  `time`, `duration_min`, `workspace_id`). **There is no `doctors` table** — doctor
  identity today is a name string matched loosely (`sameProvider()` in
  `src/lib/scheduling.ts`).
- `src/lib/scheduling.ts` — pure helpers: clinic timezone "today", operating
  hours (`clinic_settings`: `timezone` since 0042; `open_time`/`close_time`/
  `slot_minutes`/`default_duration_min`/`closed_days` proposed in 0061, **not yet
  applied**; code reads them defensively with 09:00–17:00/30-min defaults),
  duration-aware overlap, grid generation.
- `src/lib/booking-server.ts` — availability (`getSlotsStructured`: Open Dental
  first when enabled, else Pydent-calendar local availability), booking,
  reschedule, cancel; mirrors to Google Calendar + Open Dental are best-effort.
- Google Calendar today: **write-oriented, OAuth-user-token based**
  (`src/lib/google-api.ts` → `oauth_tokens` per workspace, `pushToGoogleCalendar`
  to the connected account's `primary` calendar) plus a Hyperfx-engine fallback.
  **No FreeBusy / read-path exists, and no per-doctor calendar mapping exists.**
- Open Dental: `opendental_config` per workspace + `opendental-gateway.ts`
  forwarding to clinic middleware. Primary booking system in future phases.

## 5. Credential storage conventions

- Per-workspace OAuth tokens / API keys: `oauth_tokens` table (access/refresh
  token columns) via `src/lib/google-api.ts` helpers.
- Per-workspace service config: dedicated tables (`opendental_config`,
  `livekit_config`, `hyperfx_config`…), secrets in text columns, read with the
  service-role client only.
- Global secrets: **Netlify environment variables** (`.env.example` documents the
  convention: server secrets are env-only, never committed).
- For the Google **service account** (`pydent-calendar-reader@pydentai.iam.gserviceaccount.com`)
  the right fit is a Netlify env var (avoids private keys in ordinary DB columns,
  matching the instruction and existing practice). The integration is therefore
  config-gated: `GOOGLE_CALENDAR_SA_KEY_JSON` (full service-account JSON key) —
  absent ⇒ the service reports `not_configured`, never an empty calendar.

## 6. Reusable components the scheduling module builds on

| Reused | How |
|---|---|
| `authorizeRequest()` | Tenant auth for the new `/api/scheduling/*` routes |
| `supabaseAdmin` + per-call `workspace_id` filter | Data access |
| `clinic_settings` (`timezone` + 0061 hours/grid columns) | Operating hours & timezone, normalized by existing `normalizeSchedulingSettings` |
| `src/lib/scheduling.ts` pure-helper pattern | New pure module `src/lib/availability.ts` (busy-interval math) |
| `BuilderToolDeps`-style dependency injection | Testability of the new service |
| Structured `{ success, spoken, … }` tool results | Shared AI tool contracts |
| node:test + alias loader | New availability tests |

## 7. Adapter seams (future PMS integrations)

Day-1 interfaces (names follow repo conventions — plain functions + TS interfaces,
no class hierarchies, per the "no unnecessary abstractions" rule):

- `FreeBusyProvider` (today: Google FreeBusy via service account) — the
  *CalendarAvailabilityProvider* seam.
- `getDoctorAvailability()` / `getClinicAvailability()` in
  `src/lib/availability-server.ts` — channel-agnostic availability service.
- Booking (`AppointmentBookingProvider`) stays `booking-server.ts` (Open Dental
  primary, Google fallback) — **out of Day-1 scope**, documented for Day 2+.

## 8. Risks identified

1. **Migrations are applied manually and lag the repo** (0061 unapplied). The new
   `doctor_calendars` table may not exist in any environment ⇒ server code must
   degrade gracefully (clear `no_mapping` errors, no crashes), like
   `clinicScheduling()` already does.
2. **No doctors entity** — introducing `doctor_calendars` keyed by doctor name must
   stay consistent with the loose `sameProvider()` matching used by bookings.
3. **Two Google auth worlds**: existing per-workspace OAuth (write mirror) vs new
   service-account FreeBusy (read). They must not be conflated; the reader must
   never gain write scope.
4. **Failed availability ≠ empty calendar** — `getSlotsStructured` already encodes
   this rule for Open Dental; the FreeBusy path must do the same (Google returns
   per-calendar `errors` inside a 200 response — these must be surfaced).
5. **Legacy `?ws=` routes** exist; new routes must derive the workspace from the
   session only.
6. **Supabase management API access from this dev session is currently broken**
   ("Invalid access token" on every call), so the live DB schema could not be
   inspected directly; findings above come from migrations + defensive code paths.
7. **Calendar mapping file**: `calendar_ids.txt` is NOT in the repository or the
   workspace. Only Dr. Leila Hariri's calendar ID was supplied in the task brief.
   The administrator mentioned 15 calendars, the brief says the file holds 13 —
   the remaining mappings must be provided, not invented.
