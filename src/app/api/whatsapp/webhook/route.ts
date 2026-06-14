import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

// Meta calls this endpoint twice:
//  1. GET  — one-time verification handshake when you save the webhook in the
//     Meta dashboard. We echo hub.challenge back if the verify token matches.
//  2. POST — every inbound message / status update. For now we acknowledge with
//     200 so Meta keeps the subscription healthy; routing messages into the
//     Inbox is the next build (needs the per-clinic token + message parsing).

async function expectedVerifyToken(): Promise<string | null> {
  // Platform-level env wins; otherwise use the token the clinic saved in Settings.
  if (process.env.WHATSAPP_VERIFY_TOKEN) return process.env.WHATSAPP_VERIFY_TOKEN;
  try {
    const { data } = await supabase.from("whatsapp_config").select("verify_token").eq("workspace", "default").maybeSingle();
    return data?.verify_token || null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  const expected = await expectedVerifyToken();
  if (mode === "subscribe" && token && expected && token === expected) {
    return new NextResponse(challenge ?? "", { status: 200 });
  }
  return new NextResponse("Verification failed", { status: 403 });
}

export async function POST(req: NextRequest) {
  // Acknowledge fast — Meta retries aggressively on non-200 responses.
  try {
    await req.json();
    // TODO: verify X-Hub-Signature-256 (HMAC with META_APP_SECRET), parse the
    // entry[].changes[].value.messages[] payload, and upsert into conversations.
  } catch {
    /* ignore malformed body */
  }
  return NextResponse.json({ received: true });
}
