import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { getConnectionApiKey } from "@/lib/google-api";

// Reports which integrations are configured (booleans only — never the values
// themselves). Env checks are global; channel checks look at the clinic's own
// saved config so the Settings → Channels cards can show TRUE status.
export async function GET(req: NextRequest) {
  const ws = req.nextUrl.searchParams.get("ws");

  let whatsapp = false;
  let metaPages = false; // Instagram + Messenger (Page access token saved)
  let twilio = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
  let brevo = !!process.env.BREVO_API_KEY;
  try {
    const { data: wa } = await supabase.from("whatsapp_config").select("phone_number_id, access_token").limit(1).maybeSingle();
    whatsapp = !!(wa?.phone_number_id && wa?.access_token);
    const { data: pg } = await supabase.from("meta_channels").select("page_access_token").not("page_access_token", "is", null).limit(1).maybeSingle();
    metaPages = !!pg?.page_access_token;
    if (ws && !twilio) {
      const t = await getConnectionApiKey(ws, "twilio");
      twilio = !!t?.key;
    }
    if (ws && !brevo) {
      const b = await getConnectionApiKey(ws, "brevo");
      brevo = !!b?.key;
    }
  } catch {
    /* tables may not exist yet — report what we know */
  }

  return NextResponse.json({
    openrouter: !!process.env.OPENROUTER_API_KEY,
    vapi: !!process.env.VAPI_API_KEY,
    google: !!process.env.GOOGLE_OAUTH_CLIENT_ID && !!process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    xai: !!(process.env.X_AI_VOICE_KEY || process.env.XAI_API_KEY || process.env.XAI_VOICE_API_KEY || process.env.X_AI_API_KEY || process.env.GROK_API_KEY || process.env.XAI_KEY),
    whatsapp,
    metaPages,
    twilio,
    brevo,
  });
}
