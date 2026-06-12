import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Google Calendar OAuth — step 2: exchange the code for tokens and store the
// refresh token server-side (integration_tokens has no public access policy;
// it is only reachable with the service-role key).

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const origin = req.nextUrl.origin;
  if (!code) return NextResponse.redirect(`${origin}/dashboard/settings?google=denied`);

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(`${origin}/dashboard/settings?google=unconfigured`);
  }

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
  if (!tokenRes.ok) return NextResponse.redirect(`${origin}/dashboard/settings?google=error`);
  const tokens = await tokenRes.json();

  // Store the refresh token if the service-role key is available.
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://mzqynjywncbvqfikbzgm.supabase.co";
  if (serviceKey && tokens.refresh_token) {
    const admin = createClient(supabaseUrl, serviceKey);
    await admin.from("integration_tokens").upsert(
      {
        provider: "google_calendar",
        refresh_token: tokens.refresh_token,
        access_token: tokens.access_token,
        expires_at: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
      },
      { onConflict: "provider" }
    );
    return NextResponse.redirect(`${origin}/dashboard/settings?google=connected`);
  }
  return NextResponse.redirect(`${origin}/dashboard/settings?google=token_ok_no_storage`);
}
