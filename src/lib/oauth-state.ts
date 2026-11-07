// GC-1 — signed OAuth state. Pure (node:crypto only), so every tampering,
// expiry and secret-handling case is unit-testable without a server.
//
// Format: "v1.<base64url payload>.<base64url HMAC-SHA256(payload)>"
// Payload: { ws, provider, popup, nonce, iat, exp } — minted ONLY server-side
// after the caller's session was verified, so `ws` inside a VALID state is the
// authenticated workspace, never client input. The nonce is additionally
// consumed one-time-use from a persistent ledger (lib/google-oauth-flow.ts),
// so a captured state cannot be replayed even inside its validity window.
//
// Fail-closed rule: no usable OAUTH_STATE_SECRET ⇒ nothing is minted and
// nothing verifies. There is no unsigned fallback.

import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

export interface OAuthStatePayload {
  ws: string;
  provider: string;
  popup: boolean;
  nonce: string;
  iat: number; // epoch seconds
  exp: number; // epoch seconds
}

export const OAUTH_STATE_TTL_SEC = 10 * 60; // consent screens are quick; keep the window tight
const MIN_SECRET_LENGTH = 16;

/** The HMAC secret, or null when missing/too weak (⇒ the flow must refuse). */
export function oauthStateSecret(env: Record<string, string | undefined> = process.env): string | null {
  const s = (env.OAUTH_STATE_SECRET ?? "").trim();
  return s.length >= MIN_SECRET_LENGTH ? s : null;
}

export function newOAuthNonce(): string {
  return randomBytes(16).toString("base64url");
}

const sign = (payload: string, secret: string) =>
  createHmac("sha256", secret).update(payload).digest("base64url");

export function mintOAuthState(
  input: { ws: string; provider: string; popup: boolean; nonce: string },
  opts: { secret: string; now?: Date; ttlSec?: number }
): string {
  const iat = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const payload: OAuthStatePayload = {
    ws: input.ws,
    provider: input.provider,
    popup: input.popup,
    nonce: input.nonce,
    iat,
    exp: iat + (opts.ttlSec ?? OAUTH_STATE_TTL_SEC),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `v1.${body}.${sign(body, opts.secret)}`;
}

export type OAuthStateVerify =
  | { ok: true; payload: OAuthStatePayload }
  | { ok: false; reason: "missing_secret" | "malformed" | "bad_signature" | "expired" };

export function verifyOAuthState(
  state: string | null | undefined,
  opts: { secret: string | null; now?: Date }
): OAuthStateVerify {
  if (!opts.secret) return { ok: false, reason: "missing_secret" };
  const parts = String(state ?? "").split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) {
    return { ok: false, reason: "malformed" };
  }
  // Constant-time signature check (equal-length buffers required by
  // timingSafeEqual; a length mismatch is an immediate, non-secret failure).
  const expected = Buffer.from(sign(parts[1], opts.secret));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "bad_signature" };
  }
  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload?.ws !== "string" || !payload.ws ||
    typeof payload.provider !== "string" || !payload.provider ||
    typeof payload.nonce !== "string" || !payload.nonce ||
    typeof payload.iat !== "number" || typeof payload.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (now >= payload.exp || payload.exp - payload.iat > 24 * 3600) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload: { ...payload, popup: payload.popup === true } };
}
