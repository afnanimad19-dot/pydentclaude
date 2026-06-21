import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Google OAuth — step 2: exchange the code for this clinic's tokens and store them
// PER WORKSPACE. Tokens go in oauth_tokens (service-role only); a readable status
// row goes in connections. Then we close the popup (or redirect back to settings).

interface OAuthState {
  ws?: string;
  provider?: string;
  popup?: boolean;
}

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
  const code = req.nextUrl.searchParams.get("code");
  let state: OAuthState = {};
  try {
    const raw = req.nextUrl.searchParams.get("state");
    if (raw) state = JSON.parse(Buffer.from(raw, "base64url").toString());
  } catch {
    /* ignore */
  }
  const provider = state.provider ?? "google_calendar";
  const popup = !!state.popup;
  if (!code) return done(origin, popup, "denied", provider);

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return done(origin, popup, "unconfigured", provider);

  // Exchange the code for tokens.
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: `${origin}/api/google/oauth/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return done(origin, popup, "error", provider);
  const tokens = await tokenRes.json();

  // Which Google account did they connect? (for the "Connected as …" label)
  let accountLabel = "";
  try {
    const info = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (info.ok) accountLabel = (await info.json()).email ?? "";
  } catch {
    /* ignore */
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://mzqynjywncbvqfikbzgm.supabase.co";
  if (serviceKey && state.ws) {
    const admin = createClient(supabaseUrl, serviceKey);
    await admin.from("oauth_tokens").upsert(
      {
        workspace_id: state.ws,
        provider,
        access_token: tokens.access_token ?? null,
        refresh_token: tokens.refresh_token ?? null,
        expires_at: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,provider" }
    );
    await admin.from("connections").upsert(
      { workspace_id: state.ws, provider, status: "connected", account_label: accountLabel, connected_at: new Date().toISOString() },
      { onConflict: "workspace_id,provider" }
    );
    return done(origin, popup, "connected", provider);
  }
  return done(origin, popup, "token_ok_no_storage", provider);
}
