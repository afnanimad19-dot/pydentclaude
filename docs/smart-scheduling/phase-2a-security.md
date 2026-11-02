# Pydent Smart Scheduling — Phase 2A: Secure Booking API Endpoints

Date: 2026-11-02 · Branch: `claude/compassionate-gauss-urq2bj`

## 1. Verified vulnerabilities (re-checked against head `6299c7c` before changing anything)

| Endpoint | Verified finding |
|---|---|
| `POST /api/agents/tool-exec` | Confirmed: no credential check of any kind. The deployed voice worker sends `{agentId, name, args}` with no token (`livekit-agent/agent.py run_tool()`), and the route executed any tool for any agent row. Knowing an agent UUID sufficed to book/reschedule/cancel appointments, look up and create patients, and send email as the clinic. Callers: ONLY the Python worker (plus `toolExecUrl` emitted in the agent config for older workers); no browser code posts to it. Notably the repo already has a worker-auth convention this endpoint skipped: `/api/livekit/agent-config` and `/api/livekit/call-log` verify a body `token` via `resolveWorkerToken`, and the worker already holds `PYDENT_WORKER_TOKEN` (it cannot fetch its config without it). |
| `GET/POST /api/calendar/gcal` | Confirmed: both methods unauthenticated; `ws` taken from the request (query/body), so any caller could create events on any tenant's connected Google Calendar — and the GET created a real "test" event on every visit. Only caller: `NewAppointmentModal` (`create-modals.tsx`), which sent a plain `fetch` with `ws` in the body. |

## 2. Authorization design

**tool-exec — dual-mode worker auth** (non-breaking rollout, mirrors the agent-config convention):
- Credential: the per-workspace worker token (`livekit_config.worker_token`, env `LIVEKIT_WORKER_TOKEN` as the single-clinic fallback), accepted from the body `token` field (worker convention) or an `Authorization: Bearer` header; resolved by the existing `resolveWorkerToken` (workspace binding wins over the env value).
- **Monitor mode (default, `TOOL_EXEC_REQUIRE_AUTH` unset):** tokenless calls still work (the live Laura worker is untouched) and are logged (`tool-exec unauthenticated call: agent=… tool=…`, never args or patient data). Any token that IS presented is fully verified: invalid → 401; bound to a different workspace than the agent → 403 — in every mode.
- **Strict mode (`TOOL_EXEC_REQUIRE_AUTH=1`):** missing token → 401 **before the agent lookup**, so the endpoint no longer confirms whether an agent UUID exists. An agent UUID is never proof of authorization.
- A valid workspace-bound token can only act on that workspace's agents → cross-tenant patient lookups and appointment changes are impossible with another clinic's credential. A valid unbound env token authenticates as the deployed worker (today's single-clinic semantics) and is flagged in logs; binding the token in Settings → LiveKit is the recommended configuration.

**gcal — session auth, tenant from the session:**
- GET and POST both require a signed-in workspace member (`authorizeRequest`); the workspace is **always** `auth.workspaceId` — a `ws` in the request is ignored.
- The event-creating GET is **removed**; GET is now a read-only connection status (OAuth connected? engine configured?) that performs no calendar writes.
- POST keeps the exact two-path mirror (OAuth push → engine fallback) agent bookings use, now only for the caller's own tenant.

## 3. Changes implemented

| File | Change |
|---|---|
| `src/lib/tool-exec-auth.ts` (new) | Pure dual-mode authorizer + token extraction + mode flag; fully dependency-injected. |
| `src/app/api/agents/tool-exec/route.ts` | Auth gate wired in (credential verified before the agent lookup, workspace match after); rollout-tracking log line; tool dispatch unchanged. |
| `livekit-agent/agent.py` | `run_tool()` now sends `"token": WORKER_TOKEN` (same credential agent-config/call-log already send). One line; **inert until the worker is redeployed**; older Pydent deployments ignore the extra field. |
| `src/lib/calendar-mirror.ts` (new) | Pure mirror/status logic with injected pushes — status can never write. |
| `src/app/api/calendar/gcal/route.ts` | Rewritten: both methods session-authenticated, workspace from the session, no event-creating GET. |
| `src/components/dashboard/create-modals.tsx` | The mirror call uses `authFetch` (carries the session token) and no longer sends `ws`. |
| `tests/tool-exec-auth.test.mjs`, `tests/calendar-mirror.test.mjs` (new) | 21 tests: unauthenticated requests (both modes), invalid credentials, cross-workspace rejection, authorized paths, patient-data unreachability cross-tenant, session-ws authority (body `ws` ignored), fallback order, read-only status (throwing push mocks), honest failure reporting. All mocked; no real events, no patient records. |

Untouched: Open Dental (gateway + connector), Callab AI, SIP/Asterisk/FortiGate/WireGuard, LiveKit dispatch, WhatsApp webhook, booking-server logic, production credentials, database (no migrations).

## 4. Test results

- Full suite: **436/436 pass** (415 existing + 21 new) — existing booking behavior regressions: none.
- `npx tsc --noEmit`: clean. `eslint` on all touched files: clean. `python3 -m py_compile livekit-agent/agent.py`: clean.

## 5. Deployment dependencies (coordinated rollout — nothing here is deployed)

1. Deploy the app (monitor mode). Zero behavior change for the live worker and dashboard; unauthenticated tool-exec calls start appearing in logs.
2. Redeploy the LiveKit worker from the updated `livekit-agent/agent.py` (its `PYDENT_WORKER_TOKEN` secret is already required for agent-config, so no new secret is needed). **This step needs operator approval/scheduling.**
3. Confirm logs show only authenticated tool-exec calls during a test call, then set `TOOL_EXEC_REQUIRE_AUTH=1` in Netlify.
4. Dashboard: no coordination needed — the gcal route and its only caller ship together.
5. Note one intentional behavior removal: the old unauthenticated `GET /api/calendar/gcal?ws=…` "live test" (which created a real event) no longer exists; the authenticated GET reports connection status without writing.

## 6. Rollback plan

- Strict-mode issue after step 3: unset `TOOL_EXEC_REQUIRE_AUTH` → back to monitor mode instantly (no code rollback, no worker change).
- Worker issue after step 2: redeploy the previous worker build; monitor mode accepts tokenless calls, so nothing breaks either way.
- gcal issue: revert `src/app/api/calendar/gcal/route.ts` + `create-modals.tsx` (two files, no schema or data impact). The mirror is best-effort by design, so a failure never blocks a booking.

## 7. Still needs live verification

- One real voice call after the worker redeploy: tool call succeeds and the log line shows an authenticated call (then flip strict mode and repeat).
- A dashboard "New appointment" with the Google-mirror toggle on: event appears on the connected calendar (authenticated path).
- An unauthenticated `curl` against both endpoints on the deployed app in strict mode: 401 with no agent-existence leak.
- Monitor-mode logs reviewed for any unexpected tokenless caller (would indicate an integration this audit didn't find).
