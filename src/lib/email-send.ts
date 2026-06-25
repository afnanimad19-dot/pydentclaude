// Sends transactional/campaign email for Angela via Brevo (formerly Sendinblue).
// Brevo has a generous free tier and a simple REST API (key in BREVO_API_KEY).
// Other providers (Mailchimp, Klaviyo, SendFox, Resend) follow the same pattern.

export async function sendEmail(input: { to: string; subject: string; html: string; fromName?: string; fromEmail?: string }): Promise<string> {
  const key = process.env.BREVO_API_KEY;
  if (!key) return "Email sending isn't connected. Add BREVO_API_KEY (Brevo) in Netlify to send emails.";
  const fromEmail = input.fromEmail || process.env.BREVO_FROM_EMAIL;
  if (!fromEmail) return "No sender email configured. Set BREVO_FROM_EMAIL to a verified sender in Brevo.";
  try {
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
    const t = await res.text();
    return `Email failed (${res.status}): ${t.slice(0, 200)}`;
  } catch (e) {
    return `Email send failed: ${e instanceof Error ? e.message : "error"}`;
  }
}
