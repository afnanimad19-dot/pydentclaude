import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Connect a clinic's OWN Twilio account per workspace, IN-APP (no Netlify).
// Twilio needs three values — Account SID, Auth Token, From number — packed into
// oauth_tokens (access_token = auth token, refresh_token = JSON {sid, from}).
// We verify the creds against Twilio before storing. Body: { ws, accountSid, authToken, fromNumber }.
export const runtime = "nodejs";

function admin() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://mzqynjywncbvqfikbzgm.supabase.co";
  return serviceKey ? createClient(url, serviceKey) : null;
}

export async function POST(req: NextRequest) {
  const { ws, accountSid, authToken, fromNumber } = await req.json().catch(() => ({}));
  const sid = String(accountSid ?? "").trim();
  const token = String(authToken ?? "").trim();
  const from = String(fromNumber ?? "").trim();
  if (!ws || !sid || !token || !from) return NextResponse.json({ ok: false, error: "Account SID, Auth Token and From number are all required." }, { status: 400 });

  const db = admin();
  if (!db) return NextResponse.json({ ok: false, error: "Server not configured (SUPABASE_SERVICE_ROLE_KEY). Ask the admin to add it once." }, { status: 503 });

  // Verify the credentials against Twilio before saving.
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, {
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401) return NextResponse.json({ ok: false, error: "Twilio rejected those credentials. Check the Account SID (AC…) and Auth Token." }, { status: 401 });
    if (!res.ok) return NextResponse.json({ ok: false, error: `Couldn't reach Twilio (${res.status}). Try again.` }, { status: 502 });
  } catch {
    return NextResponse.json({ ok: false, error: "Couldn't reach Twilio to verify the credentials." }, { status: 502 });
  }

  try {
    await db.from("oauth_tokens").upsert(
      { workspace_id: ws, provider: "twilio", access_token: token, refresh_token: JSON.stringify({ sid, from }), updated_at: new Date().toISOString() },
      { onConflict: "workspace_id,provider" }
    );
    await db.from("connections").upsert(
      { workspace_id: ws, provider: "twilio", status: "connected", account_label: from, connected_at: new Date().toISOString() },
      { onConflict: "workspace_id,provider" }
    );
    return NextResponse.json({ ok: true, message: "Twilio connected." });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Could not save the credentials." }, { status: 500 });
  }
}
