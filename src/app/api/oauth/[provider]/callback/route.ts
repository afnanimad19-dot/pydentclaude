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

  // ---- Meta durability: short-lived → ~60-day long-lived token, then capture a
  // (non-expiring) Page token + linked Instagram business id so posting survives.
  const isMeta = ["facebook", "instagram", "meta_ads"].includes(provider);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let metaExtra: any = null;
  if (isMeta && tokens.access_token) {
    let userToken: string = tokens.access_token;
    try {
      const ex = await fetch(
        `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&fb_exchange_token=${encodeURIComponent(userToken)}`
      );
      if (ex.ok) {
        const ej = await ex.json();
        if (ej?.access_token) { userToken = ej.access_token; tokens.access_token = ej.access_token; tokens.expires_in = ej.expires_in ?? 60 * 24 * 3600; }
      }
    } catch { /* keep the short-lived token */ }
    // Capture the Page token + IG business id from the (now long-lived) user token.
    try {
      const pages = await fetch(`https://graph.facebook.com/v19.0/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${encodeURIComponent(userToken)}`);
      if (pages.ok) {
        const pj = await pages.json();
        const page = pj?.data?.[0];
        if (page?.id && page?.access_token) {
          metaExtra = { page_id: page.id, page_access_token: page.access_token, ig_id: page.instagram_business_account?.id ?? null, captured_at: new Date().toISOString() };
        }
      }
    } catch { /* meta_ads-only or no Page — fine */ }
  }

  // Best-effort account label. (Meta's Graph rejects the Bearer header — it wants
  // the token as a query param — so meta providers use ?access_token=.)
  let accountLabel = "";
  if (cfg.userInfoUrl && tokens.access_token) {
    try {
      const info = isMeta
        ? await fetch(`${cfg.userInfoUrl}${cfg.userInfoUrl.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(tokens.access_token)}`)
        : await fetch(cfg.userInfoUrl, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tokenRow: any = {
      workspace_id: state.ws,
      provider,
      access_token: tokens.access_token ?? null,
      refresh_token: tokens.refresh_token ?? null,
      expires_at: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
      updated_at: new Date().toISOString(),
    };
    if (metaExtra) tokenRow.meta = metaExtra;
    const { error: upErr } = await admin.from("oauth_tokens").upsert(tokenRow, { onConflict: "workspace_id,provider" });
    if (upErr && tokenRow.meta) {
      // `meta` jsonb column not migrated yet — store the rest so the connection still lands.
      delete tokenRow.meta;
      await admin.from("oauth_tokens").upsert(tokenRow, { onConflict: "workspace_id,provider" });
    }
    await admin.from("connections").upsert(
      { workspace_id: state.ws, provider, status: "connected", account_label: accountLabel, connected_at: new Date().toISOString() },
      { onConflict: "workspace_id,provider" }
    );
    return done(origin, popup, "connected", provider);
  }
  return done(origin, popup, "token_ok_no_storage", provider);
}
