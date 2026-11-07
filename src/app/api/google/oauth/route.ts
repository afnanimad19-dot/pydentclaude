import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/server-auth-deps";
import { ADMIN_ROLES } from "@/lib/server-auth";
import { beginGoogleOAuth, realOAuthFlowDeps } from "@/lib/google-oauth-flow";

// Google OAuth — step 1 (GC-1 hardened): an AUTHENTICATED owner/admin asks the
// server to begin a connection; the server mints an HMAC-signed state bound to
// the SESSION workspace (plus a one-time nonce persisted in oauth_nonces) and
// returns the Google consent URL for the dashboard to open in a popup.
//
// The previous unauthenticated GET redirect — which took the workspace id from
// the query string and carried forgeable state — is REMOVED. Client input can
// no longer name a tenant anywhere in this flow.
//
// Fail-closed: missing OAUTH_STATE_SECRET or an unavailable nonce ledger
// (migration 0067 not applied) refuses to start, with a clear reason.
//
// Google Cloud: the redirect URI is unchanged —
// <origin>/api/google/oauth/callback — matching the authorized URI configured
// for the OAuth client.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = await authorizeRequest(req, {
    allowedRoles: ADMIN_ROLES,
    roleError: "Only a workspace owner or admin can connect Google accounts.",
  });
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => ({}));
  const provider = String(body?.provider ?? "google_calendar");
  const popup = body?.popup === true;

  const r = await beginGoogleOAuth(realOAuthFlowDeps(), {
    ws: auth.workspaceId,
    provider,
    popup,
    origin: req.nextUrl.origin,
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
  });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ url: r.url });
}
