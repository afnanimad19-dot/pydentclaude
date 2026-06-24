import { NextResponse } from "next/server";
import { OAUTH_PROVIDERS } from "@/lib/oauth-providers";

// Tells the dashboard which generic providers have their app credentials set
// (so we only open a real popup for the ones that will actually work).
export async function GET() {
  const configured: Record<string, boolean> = {};
  for (const [key, cfg] of Object.entries(OAUTH_PROVIDERS)) {
    configured[key] = !!process.env[cfg.clientIdEnv] && !!process.env[cfg.clientSecretEnv];
  }
  return NextResponse.json({ configured });
}
