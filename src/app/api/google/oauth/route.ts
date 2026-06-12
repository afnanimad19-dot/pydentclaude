import { NextRequest, NextResponse } from "next/server";

// Google Calendar OAuth — step 1: redirect the user to Google's consent page.
// Add the callback URL (https://<your-site>/api/google/oauth/callback) to the
// OAuth client's "Authorized redirect URIs" in Google Cloud Console.

export async function GET(req: NextRequest) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "GOOGLE_OAUTH_CLIENT_ID is not configured." }, { status: 503 });
  }
  const origin = req.nextUrl.origin;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${origin}/api/google/oauth/callback`,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar.events openid email",
    access_type: "offline",
    prompt: "consent",
  });
  return NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}
