// Sends transactional/campaign email. The PRIMARY path is the clinic's Gmail
// connected on the marketing engine (Hyperfx) — connect Gmail there and email
// "just works" everywhere (agent confirmations, campaigns, reports). Falls back
// to in-app Google OAuth Gmail, then Brevo keys if configured.

import { getValidGoogleToken, getConnectionApiKey } from "@/lib/google-api";
import { getHfxCreds, hfxCall, hfxConfigured } from "@/lib/hyperfx";

// Send through the engine's Gmail toolkit (connected on Hyperfx). Returns null
// when the engine has no Gmail (so callers fall through to other paths).
async function sendViaEngineGmail(ws: string, input: { to: string; subject: string; html: string }): Promise<string | null> {
  const creds = await getHfxCreds(ws);
  if (!hfxConfigured(creds)) return null;
  const subject = input.subject.replace(/[\r\n]+/g, " ").slice(0, 250);
  const r = await hfxCall("gmail_send_email", { to: input.to, subject, body: input.html, html: input.html, is_html: true, body_type: "html" }, creds);
  if (r.ok) return `Email sent to ${input.to} (via Gmail).`;
  // Not connected / tool unavailable → let another path try.
  if (/unknown tool|not (connected|found|available|enabled)|auth|permission|no gmail/i.test(r.error ?? "")) return null;
  return `Gmail (engine) send failed: ${String(r.error ?? "").slice(0, 200)}`;
}

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

// Returns null when Gmail OAuth isn't connected, so callers fall through.
async function sendViaGmail(ws: string, input: { to: string; subject: string; html: string }): Promise<string | null> {
  const token = await getValidGoogleToken(ws, "google_gmail");
  if (!token) return null;
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Agents (Nova, etc.) call this when a patient asks to be emailed a confirmation
// or the details they discussed. Takes a plain-text body from the model and
// wraps it in a simple, safe HTML shell, then routes through the same Gmail/Brevo
// chain as everything else. Returns a short human-readable result string.
export async function sendAgentEmail(input: { to: string; subject: string; body: string; ws?: string; fromName?: string }): Promise<string> {
  const to = (input.to || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return "That doesn't look like a valid email address, so I didn't send it.";
  const bodyHtml = escapeHtml(input.body || "").replace(/\n/g, "<br>");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111;line-height:1.6">${bodyHtml}</div>`;
  return sendEmail({ to, subject: (input.subject || "Message from your dental clinic").slice(0, 200), html, ws: input.ws, fromName: input.fromName });
}

export async function sendEmail(input: { to: string; subject: string; html: string; fromName?: string; fromEmail?: string; ws?: string }): Promise<string> {
  try {
    // 1) PRIMARY: the clinic's Gmail connected on the marketing engine (Hyperfx)
    if (input.ws) {
      const viaEngine = await sendViaEngineGmail(input.ws, input);
      if (viaEngine) return viaEngine;
    }
    // 2) the clinic's Gmail connected via in-app Google OAuth
    if (input.ws) {
      const viaGmail = await sendViaGmail(input.ws, input);
      if (viaGmail) return viaGmail;
    }
    // 3) the clinic's own Brevo key (connected in-app, per workspace) — fallback
    if (input.ws) {
      const brevo = await getConnectionApiKey(input.ws, "brevo");
      if (brevo?.key) return await sendViaBrevo({ ...input, fromEmail: input.fromEmail || brevo.extra || undefined }, brevo.key);
    }
    // 4) a global Brevo key (Netlify), if the SaaS provides one
    if (process.env.BREVO_API_KEY) return await sendViaBrevo(input, process.env.BREVO_API_KEY);
    return "Email isn't connected. Connect Gmail on the marketing engine (Hyperfx) — or in Settings → Connections — to send.";
  } catch (e) {
    return `Email send failed: ${e instanceof Error ? e.message : "error"}`;
  }
}
