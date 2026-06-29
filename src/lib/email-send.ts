// Sends transactional/campaign email. Prefers Brevo (BREVO_API_KEY) when set;
// otherwise falls back to the clinic's connected Gmail (Google OAuth, gmail.send
// scope) so "Send now" works without a separate email provider.

import { getValidGoogleToken, getConnectionApiKey } from "@/lib/google-api";

async function sendViaBrevo(input: { to: string; subject: string; html: string; fromName?: string; fromEmail?: string }, key: string): Promise<string> {
  const fromEmail = input.fromEmail || process.env.BREVO_FROM_EMAIL;
  if (!fromEmail) return "No sender email configured. Set BREVO_FROM_EMAIL to a verified sender in Brevo.";
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": key, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      sender: { name: input.fromName || "Clinic", email: fromEmail },
      to: [{ email: input.to }],
      subject: input.subject.slice(0, 250),
      htmlContent: input.html,
    }),
  });
  if (res.status === 201 || res.ok) return `Email sent to ${input.to}.`;
  return `Email failed (${res.status}): ${(await res.text()).slice(0, 200)}`;
}

async function sendViaGmail(ws: string, input: { to: string; subject: string; html: string }): Promise<string> {
  const token = await getValidGoogleToken(ws, "google_gmail");
  if (!token) return "Email isn't connected. Connect Gmail in Settings → Connections (or add BREVO_API_KEY) to send.";
  // Build a minimal MIME message and base64url-encode it for the Gmail API.
  const headers = [
    `To: ${input.to}`,
    `Subject: ${input.subject.replace(/[\r\n]+/g, " ").slice(0, 250)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
  ];
  const raw = Buffer.from(`${headers.join("\r\n")}\r\n\r\n${input.html}`).toString("base64url");
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (res.ok) return `Email sent to ${input.to} (via Gmail).`;
  return `Gmail send failed (${res.status}): ${(await res.text()).slice(0, 200)}`;
}

export async function sendEmail(input: { to: string; subject: string; html: string; fromName?: string; fromEmail?: string; ws?: string }): Promise<string> {
  try {
    // 1) the clinic's own Brevo key (connected in-app, per workspace)
    if (input.ws) {
      const brevo = await getConnectionApiKey(input.ws, "brevo");
      if (brevo?.key) return await sendViaBrevo({ ...input, fromEmail: input.fromEmail || brevo.extra || undefined }, brevo.key);
    }
    // 2) a global Brevo key (Netlify), if the SaaS provides one
    if (process.env.BREVO_API_KEY) return await sendViaBrevo(input, process.env.BREVO_API_KEY);
    // 3) the clinic's connected Gmail
    if (input.ws) return await sendViaGmail(input.ws, input);
    return "Email isn't connected. Connect Gmail or paste your Brevo key in Settings → Connections.";
  } catch (e) {
    return `Email send failed: ${e instanceof Error ? e.message : "error"}`;
  }
}
