import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { OAUTH_PROVIDERS } from "@/lib/oauth-providers";

// Generic OAuth step 2 — exchange the code for this clinic's tokens and store them
// PER WORKSPACE (oauth_tokens + connections), then close the popup.

interface OAuthState { ws?: string; provider?: string; popup?: boolean }

function done(origin: string, popup: boolean, status: string, provider: string) {
  const back = `${origin}/dashboard/settings?tab=connections&connected=${encodeURIComponent(status === "connected" ? provider : status)}`;
  if (!popup) return NextResponse.redirect(back);
  const html = `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:24px">
<script>try{window.opener&&window.opener.postMessage({type:"pydent-oauth",provider:${JSON.stringify(provider)},status:${JSON.stringify(status)}},"*")}catch(e){}window.close();</script>
You can close this window. <a href="${back}">Return to Pydent</a>.</body>`;
  return new NextResponse(html, { headers: { "Content-Type": "text/html" } });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const origin = req.nextUrl.origin;
  const cfg = OAUTH_PROVIDERS[provider];
  let state: OAuthState = {};
  try {
    const raw = req.nextUrl.searchParams.get("state");
    if (raw) state = JSON.parse(Buffer.from(raw, "base64url").toString());
  } catch { /* ignore */ }
  const popup = !!state.popup;
  if (!cfg) return done(origin, popup, "error", provider);

  const code = req.nextUrl.searchParams.get("code");
  if (!code) return done(origin, popup, "denied", provider);

  const clientId = process.env[cfg.clientIdEnv];
  const clientSecret = process.env[cfg.clientSecretEnv];
  if (!clientId || !clientSecret) return done(origin, popup, "unconfigured", provider);

  // Token exchange. Client creds go in the body by default, or as Basic auth.
  const body = new URLSearchParams({
    code,
    redirect_uri: `${origin}/api/oauth/${provider}/callback`,
    grant_type: "authorization_code",
  });
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (cfg.clientAuth === "basic") {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  } else {
    body.set(cfg.clientIdParam ?? "client_id", clientId);
    body.set("client_secret", clientSecret);
  }

  let tokens: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    const res = await fetch(cfg.tokenUrl, { method: "POST", headers, body });
    if (!res.ok) return done(origin, popup, "error", provider);
    tokens = await res.json();
  } catch {
    return done(origin, popup, "error", provider);
  }

  // Best-effort account label.
  let accountLabel = "";
  if (cfg.userInfoUrl && tokens.access_token) {
    try {
      const info = await fetch(cfg.userInfoUrl, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      if (info.ok) {
        const j = await info.json();
        accountLabel = String(j?.[cfg.userInfoLabelKey ?? "name"] ?? j?.data?.[cfg.userInfoLabelKey ?? "name"] ?? "");
      }
    } catch { /* ignore */ }
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://mzqynjywncbvqfikbzgm.supabase.co";
  if (serviceKey && state.ws && tokens.access_token) {
    const admin = createClient(supabaseUrl, serviceKey);
    await admin.from("oauth_tokens").upsert(
      {
        workspace_id: state.ws,
        provider,
        access_token: tokens.access_token ?? null,
        refresh_token: tokens.refresh_token ?? null,
        expires_at: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
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
