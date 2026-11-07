# Pydent GC-1 — Google OAuth Security Hardening

Date: 2026-11-07 · Branch: `claude/compassionate-gauss-urq2bj` · Baseline: `4a631fade0125940d83cbd802cb757078b6b6a75`
Status: **implemented, NOT deployed — NOT PRODUCTION READY until migration 0067 is reviewed and applied and `OAUTH_STATE_SECRET` is set (the flow fails closed without both, by design).**

## 1. Files changed

| File | Change |
|---|---|
| `src/lib/oauth-state.ts` (new) | HMAC-SHA256-signed state `v1.<payload>.<sig>` with `{ws, provider, popup, nonce, iat, exp}`; constant-time verification (`timingSafeEqual`); strict 10-minute TTL (and a signed-TTL sanity cap); `oauthStateSecret()` treats a missing or <16-char `OAUTH_STATE_SECRET` as absent ⇒ fail closed; `newOAuthNonce()` (128-bit random). |
| `src/lib/google-oauth-flow.ts` (new) | Pure begin/callback/disconnect with injected services + `realOAuthFlowDeps()` wiring. Check order in the callback: **signature+expiry → atomic one-time nonce consumption (cross-checked against the signed ws/provider) → code exchange → storage under the verified workspace**. Scope map: only `google_calendar` upgraded (`calendar.readonly + calendar.events`); all other Google products unchanged. |
| `supabase/migrations/0067_oauth_nonces.sql` (new, **PROPOSED — NOT applied, NOT executed**) | Persistent nonce ledger. Schema: `nonce text pk, workspace_id uuid, provider text, created_at, expires_at, consumed_at`. Security: RLS enabled with **no policies** (service-role only, same posture as `oauth_tokens`); rows carry no secrets; minutes-scale expiry; opportunistic cleanup of long-expired rows. Consumption is one atomic `UPDATE … WHERE consumed_at IS NULL AND expires_at > now … RETURNING`, which is race-free across all Netlify serverless instances — no in-memory cache anywhere. |
| `src/app/api/google/oauth/route.ts` | Rewritten: **POST only** (the old unauthenticated GET redirect with `?ws=` is removed). Requires a signed-in **owner/admin** (`authorizeRequest` + `ADMIN_ROLES`); workspace from the verified session; returns the Google consent URL carrying the signed state. Redirect URI unchanged: `<origin>/api/google/oauth/callback` (matches the authorized URI in Google Cloud — no console changes made or needed). |
| `src/app/api/google/oauth/callback/route.ts` | Rewired onto the hardened flow core; forged/expired/replayed states short-circuit to `invalid_state` with **no token exchange and no storage**; popup/redirect UX unchanged. |
| `src/app/api/connections/disconnect/route.ts` | Rewritten: owner/admin session required; workspace from session (body `workspaceId` no longer read); Google providers get best-effort token revocation (`oauth2.googleapis.com/revoke`, refresh token preferred) before row deletion; failure to revoke is reported (`revoked: false`), never blocks the local disconnect. |
| `src/components/dashboard/integrations-panel.tsx` | Google connects now: open `about:blank` popup synchronously inside the click (popup blockers), then `authFetch POST /api/google/oauth`, then point the popup at the returned consent URL; falls back to full-page navigation when the popup is blocked; clear error toasts (e.g. missing secret / missing migration). Disconnect now calls the hardened endpoint directly via `authFetch` with `{provider}` only. No `ws` leaves the client. (`db.ts` is untouched; its legacy `disconnectConnection()` helper is now unused — flagged for removal the next time `db.ts` is edited.) |
| `tests/oauth-state.test.mjs`, `tests/google-oauth-flow.test.mjs` (new) | 21 tests, below. |

Deliberately untouched: `livekit-agent/`, booking engine (`booking-server.ts`), WhatsApp webhook, Open Dental gateway/connector, `google-api.ts` (token refresh + event mirroring), `calendar-mirror`, all scheduling code, every non-Google OAuth flow (`/api/oauth/[provider]` — its matching ws-in-query weakness is out of GC-1 scope and listed as residual risk), Google Cloud Console, all env values.

## 2. Security controls implemented

1. **Forgery-proof state** — unsigned/tampered/truncated/garbage/expired states all rejected before any I/O; constant-time signature comparison; workspace retargeting in the payload breaks the signature.
2. **Session-derived tenant identity** — the workspace enters the flow exactly once, server-side, from `authorizeRequest`; no query/body field names a tenant in begin, callback, or disconnect.
3. **Authenticated initiation** — owner/admin only; anonymous or member-role calls get 401/403 and no state is ever minted for them.
4. **Persistent one-time nonce** — consumed atomically in Postgres *before* the authorization-code exchange; a replayed callback can never redeem a second code (test-pinned: second attempt → `invalid_state`, exchange count stays 1). Ledger row is cross-checked against the signed payload (defence in depth). Ledger unavailable ⇒ fail closed at begin *and* callback.
5. **Authenticated disconnect with revocation** — owner/admin, session workspace, Google token revoked best-effort and truthfully reported.
6. **Fail-closed secret handling** — no `OAUTH_STATE_SECRET` (or a weak one) means Google connections refuse to start with a clear 503; there is no unsigned fallback path in the code.
7. **No secrets in logs** — neither the flow core nor the routes log tokens, codes, or state payloads anywhere.

## 3. Nonce persistence design (requirement recap)

In-memory caching is not used. The ledger is the `oauth_nonces` table (migration 0067, prepared but **not executed**); one row per begin; consumption is a single atomic conditional UPDATE, correct under concurrent serverless instances because Postgres row-level locking serializes the two updates and only one sees `consumed_at IS NULL`. Consumption happens strictly before the code exchange. Until 0067 is applied, `createNonce` fails ⇒ begin returns 503 naming the migration; `consumeNonce` fails ⇒ callback rejects — i.e. the feature is intentionally inert, and **NOT PRODUCTION READY**, pre-migration.

## 4. OAuth popup behavior

Click → `about:blank` popup opens synchronously (so browsers' popup blockers allow it) → authenticated begin request → popup navigates to Google's consent URL → Google redirects the popup to the unchanged callback URI → callback posts `{type:"pydent-oauth", status}` to the opener and closes → panel refreshes. Blocked popup ⇒ same-tab navigation fallback. Begin failures close the stub popup and surface the server's reason.

## 5. Test results

- New: 21 tests across the two GC-1 suites — round-trip; missing/weak secret fail-closed; tampered payload; wrong secret; truncation/garbage; strict expiry boundary; absurd-TTL rejection; payload-shape validation; nonce uniqueness; consent-URL contents (signed session ws, upgraded scopes, unchanged redirect URI); fail-closed begin (no secret / no ledger); unknown product; **workspace-retargeting forgery**, **replay**, **expired**, **ledger-mismatch**, **ledger-unavailable** — each proven to reach neither exchange nor storage via throwing mocks; user-denied and exchange-failure truthfulness; disconnect revocation + scoping + revoke-failure handling.
- Full suite: **457/457 pass** (436 pre-existing — including the calendar-mirror and booking suites, confirming event mirroring and booking behavior unchanged — plus 21 new). `tsc --noEmit` clean; `eslint` clean on all touched files.
- No live Google calls were made; no events created; no migrations executed.

## 6. Remaining security risks (not in GC-1 scope)

- The generic social-provider flow (`/api/oauth/[provider]`) still uses query-string `ws` + unsigned state — same class of issue, separate phase.
- OAuth tokens remain plaintext at rest (service-role-only access mitigates); refresh-failure still silently falls back to the stale token (`google-api.ts`, untouched here).
- Prior-audit items remain open by design: UI booking paths bypassing the booking engine, dashboard cancel status bug, no booking-time Google recheck (GC-5), legacy `?ws=` Open Dental routes.
- Google OAuth app verification is still pending at Google; the upgraded `calendar.readonly` scope must be included in that verification submission (no console change was made from here).

## 7. Deployment prerequisites (in order)

1. Review + apply `0067_oauth_nonces.sql` in the Supabase SQL editor.
2. Set `OAUTH_STATE_SECRET` in Netlify (≥32 random characters recommended; ≥16 enforced) — name only here; no values anywhere in code or docs.
3. Deploy the app. Behavior change on deploy: Google connect/disconnect require an owner/admin session (no machine integration uses these endpoints); the old GET initiation URL stops existing.
4. Reconnect `google_calendar` once per clinic to grant the upgraded scopes (existing tokens keep working for what they were granted; discovery needs the re-consent; `include_granted_scopes` makes it incremental).
5. Update the Google OAuth verification submission to list `calendar.readonly` + `calendar.events`.

Rollback: revert the three routes + panel edit (the libs/tests/migration file are inert additions); or pre-deploy, simply don't deploy. No schema or data is touched until 0067 is applied, and 0067 is reversible (`drop table oauth_nonces`).
