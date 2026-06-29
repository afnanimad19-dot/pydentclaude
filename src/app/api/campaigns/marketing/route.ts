import { NextRequest, NextResponse } from "next/server";
import { fetchAccount, fetchLists, fetchCampaigns, createCampaign, type CreateCampaignInput } from "@/lib/brevo";

// Email + SMS marketing campaigns, driven through the clinic's connected Brevo
// account. GET returns the connection status, account credits, contact lists and
// the campaigns of the requested type. POST creates (and optionally sends) one.
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const ws = req.nextUrl.searchParams.get("ws");
  const type = (req.nextUrl.searchParams.get("type") === "sms" ? "sms" : "email") as "email" | "sms";
  if (!ws) return NextResponse.json({ ok: false, error: "Missing workspace." }, { status: 400 });

  const acct = await fetchAccount(ws);
  if (!acct.connected) {
    return NextResponse.json({ ok: true, connected: false, account: null, lists: [], campaigns: [] });
  }
  const [lists, camp] = await Promise.all([fetchLists(ws), fetchCampaigns(ws, type)]);
  return NextResponse.json({
    ok: true,
    connected: true,
    account: acct.account ?? null,
    lists,
    campaigns: camp.campaigns,
    error: acct.error || camp.error || null,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const ws: string | undefined = body.ws;
  if (!ws) return NextResponse.json({ ok: false, message: "Missing workspace." }, { status: 400 });
  if (!body.name?.trim()) return NextResponse.json({ ok: false, message: "Name your campaign." }, { status: 400 });

  const input: CreateCampaignInput = {
    type: body.type === "sms" ? "sms" : "email",
    name: String(body.name).trim(),
    listIds: Array.isArray(body.listIds) ? body.listIds.map((n: unknown) => Number(n)).filter((n: number) => Number.isFinite(n)) : [],
    sendNow: !!body.sendNow,
    scheduledAt: body.scheduledAt || null,
    subject: body.subject,
    html: body.html,
    senderName: body.senderName,
    smsSender: body.smsSender,
    content: body.content,
  };
  const res = await createCampaign(ws, input);
  return NextResponse.json(res, { status: res.ok ? 200 : 400 });
}
