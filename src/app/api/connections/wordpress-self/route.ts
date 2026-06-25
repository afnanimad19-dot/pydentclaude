import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Self-hosted WordPress connect: verify the site URL + username + Application
// Password against the WP REST API, then store it for this workspace so the agent
// can draft posts / upload media later. (No OAuth — WP uses application passwords.)

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { workspaceId, siteUrl, username, appPassword } = await req.json().catch(() => ({}));
  if (!workspaceId || !siteUrl || !username || !appPassword) {
    return NextResponse.json({ error: "Site URL, username and application password are required." }, { status: 400 });
  }

  // Normalise the site URL.
  let base = String(siteUrl).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  try {
    new URL(base);
  } catch {
    return NextResponse.json({ error: "That site URL doesn't look valid." }, { status: 400 });
  }

  // Application passwords come spaced ("abcd efgh …") — WP accepts with or without.
  const cred = Buffer.from(`${username}:${String(appPassword).replace(/\s+/g, "")}`).toString("base64");

  // Verify by reading the current user (needs edit context = real write access).
  try {
    const res = await fetch(`${base}/wp-json/wp/v2/users/me?context=edit`, {
      headers: { Authorization: `Basic ${cred}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 || res.status === 403) {
      return NextResponse.json({ error: "WordPress rejected those credentials — check the username and application password." }, { status: 401 });
    }
    if (!res.ok) {
      return NextResponse.json({ error: `Couldn't reach the WordPress REST API (${res.status}). Make sure the site is public and the REST API is enabled.` }, { status: 502 });
    }
  } catch {
    return NextResponse.json({ error: "Couldn't reach that WordPress site. Check the URL is correct and publicly reachable." }, { status: 502 });
  }

  // Store per-workspace (service role — oauth_tokens is server-only).
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://mzqynjywncbvqfikbzgm.supabase.co";
  if (!serviceKey) {
    return NextResponse.json({ error: "Server not configured to store the connection (missing SUPABASE_SERVICE_ROLE_KEY)." }, { status: 503 });
  }
  const admin = createClient(supabaseUrl, serviceKey);
  await admin.from("oauth_tokens").upsert(
    { workspace_id: workspaceId, provider: "wordpress_self", access_token: cred, refresh_token: base, updated_at: new Date().toISOString() },
    { onConflict: "workspace_id,provider" }
  );
  await admin.from("connections").upsert(
    { workspace_id: workspaceId, provider: "wordpress_self", status: "connected", account_label: base.replace(/^https?:\/\//, ""), connected_at: new Date().toISOString() },
    { onConflict: "workspace_id,provider" }
  );
  return NextResponse.json({ ok: true });
}
