import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Disconnects a provider for a workspace: removes the stored tokens and the
// connection status row. Uses the service-role key to reach oauth_tokens.

export async function POST(req: NextRequest) {
  const { workspaceId, provider } = await req.json().catch(() => ({}));
  if (!workspaceId || !provider) {
    return NextResponse.json({ error: "workspaceId and provider are required." }, { status: 400 });
  }
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://mzqynjywncbvqfikbzgm.supabase.co";
  if (!serviceKey) {
    return NextResponse.json({ error: "Server not configured for disconnect." }, { status: 503 });
  }
  const admin = createClient(supabaseUrl, serviceKey);
  await admin.from("oauth_tokens").delete().eq("workspace_id", workspaceId).eq("provider", provider);
  await admin.from("connections").delete().eq("workspace_id", workspaceId).eq("provider", provider);
  return NextResponse.json({ ok: true });
}
