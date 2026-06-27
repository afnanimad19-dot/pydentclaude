// Sends SMS via Twilio. Needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and a sender
// (TWILIO_FROM_NUMBER, an E.164 number or a Messaging Service SID via
// TWILIO_MESSAGING_SERVICE_SID). Returns a human-readable status string.

export async function sendSms(input: { to: string; body: string; from?: string }): Promise<string> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return "SMS isn't connected. Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in Netlify to send.";
  const from = input.from || process.env.TWILIO_FROM_NUMBER;
  const messagingService = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (!from && !messagingService) return "No SMS sender configured. Set TWILIO_FROM_NUMBER (or TWILIO_MESSAGING_SERVICE_SID).";

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
