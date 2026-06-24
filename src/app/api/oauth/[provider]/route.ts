import { NextRequest, NextResponse } from "next/server";
import { OAUTH_PROVIDERS } from "@/lib/oauth-providers";

// Generic OAuth step 1 — send the clinic to a provider's consent screen.
// Works for any provider declared in OAUTH_PROVIDERS once its app credentials are
// set in env. The redirect URI you register must be exactly:
//   <origin>/api/oauth/<provider>/callback

export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const cfg = OAUTH_PROVIDERS[provider];
  const origin = req.nextUrl.origin;
  if (!cfg) return NextResponse.json({ error: `Unknown provider: ${provider}` }, { status: 404 });

  const clientId = process.env[cfg.clientIdEnv];
  if (!clientId) {
    return NextResponse.redirect(`${origin}/dashboard/settings?tab=connections&connected=unconfigured`);
  }
  const ws = req.nextUrl.searchParams.get("ws") ?? "";
  const popup = req.nextUrl.searchParams.get("popup") === "1";
  const state = Buffer.from(JSON.stringify({ ws, provider, popup })).toString("base64url");

  const params = new URLSearchParams({
    [cfg.clientIdParam ?? "client_id"]: clientId,
    redirect_uri: `${origin}/api/oauth/${provider}/callback`,
    response_type: "code",
    scope: cfg.scope,
    state,
    ...(cfg.extraAuthParams ?? {}),
  });
  return NextResponse.redirect(`${cfg.authorizeUrl}?${params}`);
}
