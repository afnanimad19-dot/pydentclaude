import { NextResponse } from "next/server";

// Reports which server-side integrations are configured (booleans only —
// never the values themselves).
export async function GET() {
  return NextResponse.json({
    openrouter: !!process.env.OPENROUTER_API_KEY,
    vapi: !!process.env.VAPI_API_KEY,
    google: !!process.env.GOOGLE_OAUTH_CLIENT_ID && !!process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  });
}
