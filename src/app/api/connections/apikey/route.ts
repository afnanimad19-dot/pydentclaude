import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Connect a key-based integration (Brevo, Mailchimp, …) per clinic, IN-APP.
// The clinic pastes their own API key here — they never touch Netlify. Stored
// per workspace in oauth_tokens (service-role only); status mirrored in connections.
// Body: { ws, provider, apiKey, fromEmail? }.
export const runtime = "nodejs";

function admin() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://mzqynjywncbvqfikbzgm.supabase.co";
  return serviceKey ? createClient(url, serviceKey) : null;
}

export async function POST(req: NextRequest) {
  const { ws, provider, apiKey, fromEmail } = await req.json().catch(() => ({}));
  if (!ws || !provider || !apiKey) return NextResponse.json({ ok: false, error: "Missing workspace, provider or key." }, { status: 400 });
  const db = admin();
  if (!db) return NextResponse.json({ ok: false, error: "Server not configured (SUPABASE_SERVICE_ROLE_KEY). Ask the admin to add it once." }, { status: 503 });

  try {
    await db.from("oauth_tokens").upsert(
      { workspace_id: ws, provider, access_token: String(apiKey).trim(), refresh_token: fromEmail ? String(fromEmail).trim() : null, updated_at: new Date().toISOString() },
      { onConflict: "workspace_id,provider" }
    );
    await db.from("connections").upsert(
      { workspace_id: ws, provider, status: "connected", account_label: fromEmail ?? "", connected_at: new Date().toISOString() },
      { onConflict: "workspace_id,provider" }
    );
    return NextResponse.json({ ok: true, message: `${provider} connected.` });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Could not save the key." }, { status: 500 });
  }
}
