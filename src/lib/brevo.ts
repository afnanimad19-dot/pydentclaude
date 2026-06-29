// Marketing campaigns through the clinic's own connected Brevo account.
// One Brevo API key (connected per-clinic in Settings → Integrations) drives
// BOTH email and SMS campaigns, plus the contact lists they send to. The clinic
// never touches Netlify — we read their key from oauth_tokens per workspace.

import { getConnectionApiKey } from "@/lib/google-api";

const BREVO = "https://api.brevo.com/v3";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BrevoConn {
  key: string;
  senderEmail: string | null; // the verified sender saved when connecting
}

async function conn(ws: string): Promise<BrevoConn | null> {
  const c = await getConnectionApiKey(ws, "brevo");
  if (!c?.key) return null;
  return { key: c.key, senderEmail: c.extra };
}

function hdrs(key: string) {
  return { "api-key": key, "Content-Type": "application/json", Accept: "application/json" };
}

async function asError(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return body?.message || body?.error || `Brevo error ${res.status}`;
}

// ------------------------------------------------------------------ account
export interface BrevoAccount {
  email: string;
  companyName: string;
  emailCredits: number;
  smsCredits: number;
  planLabel: string;
}

export async function fetchAccount(ws: string): Promise<{ ok: boolean; connected: boolean; account?: BrevoAccount; error?: string }> {
  const c = await conn(ws);
  if (!c) return { ok: true, connected: false };
  try {
    const res = await fetch(`${BREVO}/account`, { headers: hdrs(c.key) });
    if (!res.ok) return { ok: false, connected: true, error: await asError(res) };
    const d: any = await res.json();
    const plans: any[] = Array.isArray(d?.plan) ? d.plan : [];
    const emailCredits = plans.filter((p) => /email|sendLimit/i.test(p?.creditsType ?? p?.type ?? "")).reduce((n, p) => n + Number(p?.credits ?? 0), 0);
    const smsCredits = plans.filter((p) => /sms/i.test(p?.creditsType ?? p?.type ?? "")).reduce((n, p) => n + Number(p?.credits ?? 0), 0);
    const planType = plans[0]?.type ?? "";
    return {
      ok: true,
      connected: true,
      account: {
        email: d?.email ?? "",
        companyName: d?.companyName ?? "",
        emailCredits,
        smsCredits,
        planLabel: planType ? `${planType}` : "Connected",
      },
    };
  } catch (e) {
    return { ok: false, connected: true, error: e instanceof Error ? e.message : "Could not reach Brevo." };
  }
}

// -------------------------------------------------------------------- lists
export interface BrevoList {
  id: number;
  name: string;
  subscribers: number;
}

export async function fetchLists(ws: string): Promise<BrevoList[]> {
  const c = await conn(ws);
  if (!c) return [];
  try {
    const res = await fetch(`${BREVO}/contacts/lists?limit=50&sort=desc`, { headers: hdrs(c.key) });
    if (!res.ok) return [];
    const d: any = await res.json();
    return (d?.lists ?? []).map((l: any) => ({ id: l.id, name: l.name, subscribers: Number(l.totalSubscribers ?? 0) }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- campaigns
export interface BrevoCampaign {
  id: number;
  name: string;
  subject: string;
  status: string;
  scheduledAt: string | null;
  sent: number;
  opened: number; // email only
  clicked: number;
}

function mapCampaign(c: any): BrevoCampaign {
  const g = c?.statistics?.globalStats ?? c?.statistics ?? {};
  return {
    id: c.id,
    name: c.name ?? "",
    subject: c.subject ?? "",
    status: String(c.status ?? "draft"),
    scheduledAt: c.scheduledAt ?? null,
    sent: Number(g.sent ?? 0),
    opened: Number(g.uniqueViews ?? g.viewed ?? 0),
    clicked: Number(g.uniqueClicks ?? g.clickers ?? 0),
  };
}

export async function fetchCampaigns(ws: string, type: "email" | "sms"): Promise<{ ok: boolean; campaigns: BrevoCampaign[]; error?: string }> {
  const c = await conn(ws);
  if (!c) return { ok: true, campaigns: [] };
  const path = type === "sms" ? "smsCampaigns" : "emailCampaigns";
  try {
    const res = await fetch(`${BREVO}/${path}?limit=50&sort=desc`, { headers: hdrs(c.key) });
    if (!res.ok) return { ok: false, campaigns: [], error: await asError(res) };
    const d: any = await res.json();
    return { ok: true, campaigns: (d?.campaigns ?? []).map(mapCampaign) };
  } catch (e) {
    return { ok: false, campaigns: [], error: e instanceof Error ? e.message : "Could not reach Brevo." };
  }
}

// ------------------------------------------------------------------ create
export interface CreateCampaignInput {
  type: "email" | "sms";
  name: string;
  listIds: number[];
  sendNow: boolean;
  scheduledAt?: string | null; // ISO; used when not sendNow
  // email
  subject?: string;
  html?: string;
  senderName?: string;
  // sms
  smsSender?: string; // alphanumeric, max 11 chars
  content?: string;
}

export async function createCampaign(ws: string, input: CreateCampaignInput): Promise<{ ok: boolean; id?: number; message: string }> {
  const c = await conn(ws);
  if (!c) return { ok: false, message: "Connect Brevo in Settings → Integrations first." };
  if (!input.listIds.length) return { ok: false, message: "Pick at least one Brevo contact list to send to." };

  const path = input.type === "sms" ? "smsCampaigns" : "emailCampaigns";
  // Brevo: a campaign with scheduledAt sends itself at that time. Without it,
  // it's created as a draft; we then call /sendNow to fire it immediately.
  const scheduledAt = !input.sendNow && input.scheduledAt ? input.scheduledAt : undefined;

  let body: Record<string, any>;
  if (input.type === "sms") {
    const sender = (input.smsSender || "Clinic").replace(/[^a-zA-Z0-9 ]/g, "").slice(0, 11) || "Clinic";
    if (!input.content?.trim()) return { ok: false, message: "Write the SMS message." };
    body = { name: input.name, sender, content: input.content.trim(), recipients: { listIds: input.listIds }, ...(scheduledAt ? { scheduledAt } : {}) };
  } else {
    if (!c.senderEmail) return { ok: false, message: "No verified sender email on the Brevo connection. Reconnect Brevo with a verified sender." };
    if (!input.subject?.trim()) return { ok: false, message: "Add a subject line." };
    body = {
      name: input.name,
      subject: input.subject.trim(),
      sender: { name: input.senderName || input.subject.slice(0, 40) || "Clinic", email: c.senderEmail },
      type: "classic",
      htmlContent: input.html || `<p>${(input.subject || "").trim()}</p>`,
      recipients: { listIds: input.listIds },
      ...(scheduledAt ? { scheduledAt } : {}),
    };
  }

  try {
    const res = await fetch(`${BREVO}/${path}`, { method: "POST", headers: hdrs(c.key), body: JSON.stringify(body) });
    if (!res.ok) return { ok: false, message: await asError(res) };
    const d: any = await res.json().catch(() => ({}));
    const id = d?.id;
    if (input.sendNow && id) {
      const send = await fetch(`${BREVO}/${path}/${id}/sendNow`, { method: "POST", headers: hdrs(c.key) });
      if (!send.ok) return { ok: false, id, message: `Campaign created as a draft, but sending now failed: ${await asError(send)}` };
      return { ok: true, id, message: "Campaign sent." };
    }
    return { ok: true, id, message: scheduledAt ? "Campaign scheduled." : "Campaign saved as a draft in Brevo." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not reach Brevo." };
  }
}
