import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { authorizeRequest } from "@/lib/server-auth-deps";
import {
  approveCampaignForCalling,
  markLeadsEligible,
  placeCampaignCall,
  seedCampaignLeads,
  verifyCapturedRecording,
} from "@/lib/outbound-call-server";

// LiveKit outbound campaign calls (Phase 2A). ADMIN-ONLY and workspace-scoped
// — the replacement for the unauthenticated /api/vapi/outbound, which this
// route deliberately does not resemble: one call per invocation (single-call
// concurrency), every pre-dial gate fail-closed (verified marketing
// eligibility, do-not-call registry, campaign approval, recording must start
// or nobody is dialed), and full attribution written before the dial.
//
// Actions:
//   approve          — the explicit human approval gate (S1: admin-only,
//                      server-side; the browser cannot write approved_at).
//   seed             — create pending leads from the campaign's contact folder
//                      (NEVER marks them eligible; that is a separate,
//                      attested staff action).
//   mark-eligible    — record verified marketing eligibility via a structured
//                      attestation {basis, detail, evidenceRef?}.
//   start-next       — place ONE call (the oldest pending eligible lead, or
//                      body.leadId).
//   verify-recording — read the stored blob's size for a finished call
//                      (acceptance check: captured audio, not just a started
//                      egress; two-way audio is confirmed by a human listening
//                      to the pilot recording through the playback route).
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const auth = await authorizeRequest(req, { requireAdmin: true });
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const ws = auth.workspaceId;

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "start-next");
  const campaignId = String(body.campaignId ?? "");

  if (action === "verify-recording") {
    const callId = String(body.callId ?? "");
    if (!callId) return NextResponse.json({ ok: false, error: "callId is required." }, { status: 400 });
    const { data: row } = await supabase
      .from("voice_calls").select("workspace_id, recording_path, recording_status").eq("id", callId).maybeSingle();
    // Foreign/unknown ids answer 404 — same ownership rule as the playback route.
    if (!row || String(row.workspace_id) !== ws) return NextResponse.json({ ok: false, error: "Call not found." }, { status: 404 });
    const v = await verifyCapturedRecording(String(row.recording_path ?? ""));
    return NextResponse.json({ ok: v.ok, sizeBytes: v.sizeBytes, detail: v.detail, recordingStatus: String(row.recording_status ?? "") });
  }

  if (!campaignId) return NextResponse.json({ ok: false, error: "campaignId is required." }, { status: 400 });

  if (action === "approve") {
    const r = await approveCampaignForCalling(ws, campaignId, auth.userId);
    return NextResponse.json(r, { status: r.ok ? 200 : 400 });
  }

  if (action === "seed") {
    const r = await seedCampaignLeads(ws, campaignId);
    return NextResponse.json(r, { status: r.ok ? 200 : 400 });
  }

  if (action === "mark-eligible") {
    const leadIds = Array.isArray(body.leadIds) ? body.leadIds.map(String) : [];
    if (!leadIds.length) return NextResponse.json({ ok: false, error: "leadIds is required." }, { status: 400 });
    const r = await markLeadsEligible(ws, campaignId, leadIds, {
      basis: String(body.basis ?? ""),
      detail: String(body.detail ?? ""),
      evidenceRef: body.evidenceRef ? String(body.evidenceRef) : undefined,
    });
    return NextResponse.json(r, { status: r.ok ? 200 : 400 });
  }

  if (action === "start-next") {
    const r = await placeCampaignCall({ ws, campaignId, leadId: body.leadId ? String(body.leadId) : undefined });
    // Refusals are 200s with ok:false — they are answers, not transport errors.
    return NextResponse.json(r);
  }

  return NextResponse.json({ ok: false, error: `Unknown action "${action}".` }, { status: 400 });
}

/** Campaign outbound status: lead counts by state, for the campaigns page. */
export async function GET(req: NextRequest) {
  const auth = await authorizeRequest(req, {});
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const ws = auth.workspaceId;
  const campaignId = String(req.nextUrl.searchParams.get("campaignId") ?? "");
  if (!campaignId) return NextResponse.json({ ok: false, error: "campaignId is required." }, { status: 400 });
  const { data } = await supabase
    .from("campaign_leads").select("status, status_detail, opening_consent")
    .eq("campaign_id", campaignId).eq("workspace_id", ws);
  const counts: Record<string, number> = {};
  for (const r of data ?? []) counts[String(r.status)] = (counts[String(r.status)] ?? 0) + 1;
  const { count: notEligible } = await supabase
    .from("campaign_leads").select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId).eq("workspace_id", ws).is("marketing_eligible_at", null);
  const { data: campaign } = await supabase
    .from("campaigns").select("approved_at, halted_reason").eq("id", campaignId).eq("workspace_id", ws).maybeSingle();
  return NextResponse.json({
    ok: true,
    counts,
    notEligible: notEligible ?? 0,
    approvedAt: campaign?.approved_at ?? null,
    haltedReason: String(campaign?.halted_reason ?? ""),
  });
}
