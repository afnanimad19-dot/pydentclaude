// Sends SMS via Twilio. Prefers the clinic's OWN Twilio (connected per-workspace in
// Settings → Integrations), then falls back to the shared env account
// (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN + TWILIO_FROM_NUMBER or
// TWILIO_MESSAGING_SERVICE_SID). Returns a human-readable status string.

import { getConnectionApiKey } from "@/lib/google-api";

// Per-clinic Twilio creds, packed as access_token = authToken, refresh_token =
// JSON {sid, from}. Returns null when the clinic hasn't connected Twilio.
export async function getTwilioCreds(ws?: string): Promise<{ sid: string; token: string; from?: string } | null> {
  if (!ws) return null;
  const row = await getConnectionApiKey(ws, "twilio");
  if (!row?.key) return null;
  try {
    const extra = row.extra ? JSON.parse(row.extra) : {};
    if (!extra?.sid) return null;
    return { sid: String(extra.sid), token: row.key, from: extra.from ? String(extra.from) : undefined };
  } catch {
    return null;
  }
}

export async function sendSms(input: { to: string; body: string; from?: string; ws?: string }): Promise<string> {
  // Per-clinic creds win as a pair; only fall back to env when none are connected.
  let sid: string | undefined, token: string | undefined, from: string | undefined, messagingService: string | undefined;
  const clinic = await getTwilioCreds(input.ws);
  if (clinic) {
    sid = clinic.sid; token = clinic.token; from = input.from || clinic.from;
  } else {
    sid = process.env.TWILIO_ACCOUNT_SID; token = process.env.TWILIO_AUTH_TOKEN;
    from = input.from || process.env.TWILIO_FROM_NUMBER; messagingService = process.env.TWILIO_MESSAGING_SERVICE_SID;
  }
  if (!sid || !token) return "SMS isn't connected. Connect your Twilio in Settings → Integrations (per clinic), or add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in Netlify.";
  if (!from && !messagingService) return "No SMS sender configured. Add a Twilio From number (in the Twilio connection) or set TWILIO_FROM_NUMBER.";

  const params = new URLSearchParams({ To: input.to, Body: input.body.slice(0, 1500) });
  if (messagingService) params.set("MessagingServiceSid", messagingService);
  else params.set("From", from!);

  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return `SMS sent to ${input.to}.`;
    return `SMS failed (${res.status}): ${data?.message ?? "error"}`;
  } catch (e) {
    return `SMS send failed: ${e instanceof Error ? e.message : "error"}`;
  }
}
