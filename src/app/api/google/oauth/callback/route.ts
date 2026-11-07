import { NextRequest, NextResponse } from "next/server";
import { handleGoogleCallback, realOAuthFlowDeps } from "@/lib/google-oauth-flow";

// Google OAuth — step 2 (GC-1 hardened). Order of checks, all before any
// token is exchanged or stored:
//   1. HMAC signature + expiry of `state` (pure; forged/expired → rejected).
//   2. One-time nonce consumption from the persistent oauth_nonces ledger
//      (atomic UPDATE), cross-checked against the signed workspace+provider —
//      a replayed callback can never redeem a second code.
//   3. Only then: code exchange, and storage under the VERIFIED workspace.
// Nothing in this handler trusts client input for tenant identity, and no
// token or state payload is ever logged.
export const runtime = "nodejs";

function done(origin: string, popup: boolean, status: string, provider: string) {
  const back = `${origin}/dashboard/settings?tab=connections&connected=${encodeURIComponent(status === "connected" ? provider : status)}`;
  if (!popup) return NextResponse.redirect(back);
  // In a popup: tell the opener to refresh, then close.
  const html = `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:24px">
<script>
  try { window.opener && window.opener.postMessage({ type: "pydent-oauth", provider: ${JSON.stringify(provider)}, status: ${JSON.stringify(status)} }, "*"); } catch (e) {}
  window.close();
</script>
You can close this window. <a href="${back}">Return to Pydent</a>.</body>`;
  return new NextResponse(html, { headers: { "Content-Type": "text/html" } });
}

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const outcome = await handleGoogleCallback(realOAuthFlowDeps(), {
    state: req.nextUrl.searchParams.get("state"),
    code: req.nextUrl.searchParams.get("code"),
    origin,
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  });
  return done(origin, outcome.popup, outcome.status, outcome.provider);
}
