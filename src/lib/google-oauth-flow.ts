// GC-1 — Google OAuth flow logic (begin / callback / disconnect) as pure
// functions with injected services, following the repo's builder-tools
// pattern so the security properties are unit-testable without Google or a
// database. The route files wire `realOAuthFlowDeps`.
//
// Security contract:
//  * begin:    runs ONLY for an authenticated owner/admin (the route enforces
//              it); the workspace inside the signed state is the SESSION
//              workspace — client input never names a tenant.
//  * callback: verifies the HMAC state (signature + expiry) FIRST, then
//              consumes the nonce ONE-TIME from the persistent ledger, and
//              only then exchanges the authorization code. A forged, expired
//              or replayed state never reaches the token exchange and never
//              writes to storage. No ledger (migration 0067 not applied, or
//              DB unreachable) ⇒ fail closed, never "best effort".
//  * disconnect: owner/admin only, session workspace only; best-effort Google
//              token revocation before the rows are deleted.
//  * No tokens, secrets or state payloads are ever logged.

import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import {
  mintOAuthState, verifyOAuthState, newOAuthNonce, oauthStateSecret,
  OAUTH_STATE_TTL_SEC,
} from "@/lib/oauth-state";

// Scopes per Google product. GC-1 upgrades ONLY google_calendar: discovery
// (calendarList) + free/busy + event read need calendar.readonly, and event
// create/update/delete for bookings needs calendar.events. Every other
// product keeps its existing scope, so existing integrations are preserved.
export const GOOGLE_SCOPES: Record<string, string> = {
  google_calendar: "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events",
  google_analytics: "https://www.googleapis.com/auth/analytics.readonly",
  google_search_console: "https://www.googleapis.com/auth/webmasters.readonly",
  google_business: "https://www.googleapis.com/auth/business.manage",
  google_ads: "https://www.googleapis.com/auth/adwords",
  google_drive: "https://www.googleapis.com/auth/drive.readonly",
  youtube: "https://www.googleapis.com/auth/youtube.readonly",
  google_gmail: "https://www.googleapis.com/auth/gmail.send",
};

export interface GoogleTokens {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface OAuthFlowDeps {
  /** OAUTH_STATE_SECRET (null when missing/weak ⇒ every operation refuses). */
  secret: string | null;
  now(): Date;
  /** Persist a fresh nonce (one row per begin). False ⇒ begin must fail. */
  createNonce(row: { nonce: string; ws: string; provider: string; expiresAt: string }): Promise<boolean>;
  /** Atomically consume a nonce exactly once (UPDATE … WHERE consumed_at IS NULL). */
  consumeNonce(nonce: string, now: string): Promise<
    | { ok: true; ws: string; provider: string }
    | { ok: false; reason: "not_found_or_used" | "expired" | "store_unavailable" }
  >;
  exchangeCode(code: string, redirectUri: string): Promise<{ ok: boolean; tokens?: GoogleTokens }>;
  fetchAccountEmail(accessToken: string): Promise<string>;
  storeTokens(ws: string, provider: string, tokens: GoogleTokens, accountLabel: string): Promise<boolean>;
  getStoredTokens(ws: string, provider: string): Promise<{ access_token: string | null; refresh_token: string | null } | null>;
  revokeToken(token: string): Promise<boolean>;
  deleteConnection(ws: string, provider: string): Promise<void>;
}

// ---- begin ------------------------------------------------------------------

export type BeginResult =
  | { ok: true; url: string }
  | { ok: false; status: number; error: string };

export async function beginGoogleOAuth(
  deps: OAuthFlowDeps,
  input: { ws: string; provider: string; popup: boolean; origin: string; clientId: string | undefined }
): Promise<BeginResult> {
  if (!input.clientId) return { ok: false, status: 503, error: "GOOGLE_OAUTH_CLIENT_ID is not configured." };
  if (!deps.secret) return { ok: false, status: 503, error: "OAUTH_STATE_SECRET is not configured — Google connections are disabled until it is set." };
  const scope = GOOGLE_SCOPES[input.provider];
  if (!scope) return { ok: false, status: 400, error: "Unknown Google product." };

  const nonce = newOAuthNonce();
  const now = deps.now();
  const stored = await deps.createNonce({
    nonce,
    ws: input.ws,
    provider: input.provider,
    expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_SEC * 1000).toISOString(),
  });
  if (!stored) {
    return { ok: false, status: 503, error: "OAuth replay protection is unavailable (apply migration 0067_oauth_nonces) — connection refused." };
  }

  const state = mintOAuthState({ ws: input.ws, provider: input.provider, popup: input.popup, nonce }, { secret: deps.secret, now });
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: `${input.origin}/api/google/oauth/callback`,
    response_type: "code",
    scope: `${scope} openid email`,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
  });
  return { ok: true, url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` };
}

// ---- callback ---------------------------------------------------------------

export interface CallbackOutcome {
  status: "connected" | "denied" | "invalid_state" | "error" | "unconfigured";
  provider: string;
  popup: boolean;
}

export async function handleGoogleCallback(
  deps: OAuthFlowDeps,
  input: { state: string | null; code: string | null; origin: string; clientId?: string; clientSecret?: string }
): Promise<CallbackOutcome> {
  // 1. Signature + expiry — pure, before any I/O. On failure nothing below runs.
  const verified = verifyOAuthState(input.state, { secret: deps.secret, now: deps.now() });
  if (!verified.ok) return { status: "invalid_state", provider: "google_calendar", popup: false };
  const p = verified.payload;

  // 2. One-time nonce consumption — BEFORE the code exchange, so a replayed
  // callback can never redeem a second authorization code. The ledger row must
  // also match the signed payload (defence in depth).
  const consumed = await deps.consumeNonce(p.nonce, deps.now().toISOString());
  if (!consumed.ok || consumed.ws !== p.ws || consumed.provider !== p.provider) {
    return { status: "invalid_state", provider: p.provider, popup: p.popup };
  }

  if (!input.code) return { status: "denied", provider: p.provider, popup: p.popup };
  if (!input.clientId || !input.clientSecret) return { status: "unconfigured", provider: p.provider, popup: p.popup };

  // 3. Exchange + store, under the VERIFIED workspace only.
  const ex = await deps.exchangeCode(input.code, `${input.origin}/api/google/oauth/callback`);
  if (!ex.ok || !ex.tokens) return { status: "error", provider: p.provider, popup: p.popup };
  let accountLabel = "";
  try {
    if (ex.tokens.access_token) accountLabel = await deps.fetchAccountEmail(ex.tokens.access_token);
  } catch { /* label is cosmetic */ }
  const saved = await deps.storeTokens(p.ws, p.provider, ex.tokens, accountLabel);
  return { status: saved ? "connected" : "error", provider: p.provider, popup: p.popup };
}

// ---- disconnect -------------------------------------------------------------

export async function disconnectGoogle(
  deps: OAuthFlowDeps,
  input: { ws: string; provider: string }
): Promise<{ ok: true; revoked: boolean }> {
  let revoked = false;
  try {
    const t = await deps.getStoredTokens(input.ws, input.provider);
    const candidate = t?.refresh_token || t?.access_token;
    if (candidate) revoked = await deps.revokeToken(candidate);
  } catch { /* revocation is best-effort; local disconnect still proceeds */ }
  await deps.deleteConnection(input.ws, input.provider);
  return { ok: true, revoked };
}

// ---- real wiring --------------------------------------------------------------

export function realOAuthFlowDeps(fetchImpl: typeof fetch = fetch): OAuthFlowDeps {
  return {
    secret: oauthStateSecret(),
    now: () => new Date(),
    createNonce: async (row) => {
      const { error } = await supabase.from("oauth_nonces").insert({
        nonce: row.nonce, workspace_id: row.ws, provider: row.provider, expires_at: row.expiresAt,
      });
      return !error; // missing table / any failure ⇒ begin refuses (fail closed)
    },
    consumeNonce: async (nonce, now) => {
      // Single atomic UPDATE: only an unconsumed, unexpired row flips, and the
      // returned row proves THIS request consumed it.
      const { data, error } = await supabase
        .from("oauth_nonces")
        .update({ consumed_at: now })
        .eq("nonce", nonce)
        .is("consumed_at", null)
        .gt("expires_at", now)
        .select("workspace_id, provider");
      if (error) return { ok: false, reason: "store_unavailable" };
      const row = data?.[0] as { workspace_id?: string; provider?: string } | undefined;
      if (!row?.workspace_id) return { ok: false, reason: "not_found_or_used" };
      // Opportunistic hygiene: drop long-expired rows (never blocks the flow).
      void supabase.from("oauth_nonces").delete().lt("expires_at", new Date(Date.now() - 86_400_000).toISOString()).then(
        () => undefined,
        () => undefined
      );
      return { ok: true, ws: String(row.workspace_id), provider: String(row.provider ?? "") };
    },
    exchangeCode: async (code, redirectUri) => {
      const res = await fetchImpl("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
          client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });
      if (!res.ok) return { ok: false };
      const tokens = (await res.json().catch(() => null)) as GoogleTokens | null;
      return tokens?.access_token ? { ok: true, tokens } : { ok: false };
    },
    fetchAccountEmail: async (accessToken) => {
      const info = await fetchImpl("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!info.ok) return "";
      return String((await info.json().catch(() => ({})))?.email ?? "");
    },
    storeTokens: async (ws, provider, tokens, accountLabel) => {
      const { error } = await supabase.from("oauth_tokens").upsert(
        {
          workspace_id: ws,
          provider,
          access_token: tokens.access_token ?? null,
          refresh_token: tokens.refresh_token ?? null,
          expires_at: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id,provider" }
      );
      if (error) return false;
      await supabase.from("connections").upsert(
        { workspace_id: ws, provider, status: "connected", account_label: accountLabel, connected_at: new Date().toISOString() },
        { onConflict: "workspace_id,provider" }
      );
      return true;
    },
    getStoredTokens: async (ws, provider) => {
      const { data } = await supabase.from("oauth_tokens").select("access_token, refresh_token").eq("workspace_id", ws).eq("provider", provider).maybeSingle();
      return (data as { access_token: string | null; refresh_token: string | null } | null) ?? null;
    },
    revokeToken: async (token) => {
      try {
        const res = await fetchImpl("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    deleteConnection: async (ws, provider) => {
      await supabase.from("oauth_tokens").delete().eq("workspace_id", ws).eq("provider", provider);
      await supabase.from("connections").delete().eq("workspace_id", ws).eq("provider", provider);
    },
  };
}
