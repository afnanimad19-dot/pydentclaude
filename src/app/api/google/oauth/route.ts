import { NextRequest, NextResponse } from "next/server";

// Google OAuth — step 1: send the clinic to Google's consent screen.
//
// MULTI-TENANT: there is ONE Google OAuth *app* (its client id/secret live in env
// vars — the developer's app). Each clinic connects its OWN Google account here;
// the resulting tokens are stored per-workspace (see the callback). We pass the
// workspace id + which product through `state` so the callback knows who/what.
//
// IMPORTANT: in Google Cloud Console → Credentials → your OAuth client, the
// "Authorized redirect URI" must EXACTLY match: <origin>/api/google/oauth/callback
// (e.g. https://pydent.netlify.app/api/google/oauth/callback). A mismatch is the
// "Error 400: redirect_uri_mismatch" screen.

// Each Google product needs its own scope(s). One app can request any of these.
const SCOPES: Record<string, string> = {
  google_calendar: "https://www.googleapis.com/auth/calendar.events",
  google_analytics: "https://www.googleapis.com/auth/analytics.readonly",
  google_search_console: "https://www.googleapis.com/auth/webmasters.readonly",
  google_business: "https://www.googleapis.com/auth/business.manage",
  google_ads: "https://www.googleapis.com/auth/adwords",
  google_drive: "https://www.googleapis.com/auth/drive.readonly",
  youtube: "https://www.googleapis.com/auth/youtube.readonly",
  google_gmail: "https://www.googleapis.com/auth/gmail.send",
};

export async function GET(req: NextRequest) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "GOOGLE_OAUTH_CLIENT_ID is not configured." }, { status: 503 });
  }
  const provider = req.nextUrl.searchParams.get("provider") ?? "google_calendar";
  const ws = req.nextUrl.searchParams.get("ws") ?? "";
  const popup = req.nextUrl.searchParams.get("popup") === "1";
  const scope = SCOPES[provider] ?? SCOPES.google_calendar;

  const origin = req.nextUrl.origin;
  const state = Buffer.from(JSON.stringify({ ws, provider, popup })).toString("base64url");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${origin}/api/google/oauth/callback`,
    response_type: "code",
    scope: `${scope} openid email`,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
  });
  return NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}
