import {
  AgentDispatchClient,
  AzureBlobUpload,
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  SipClient,
} from "livekit-server-sdk";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import {
  boundLivekitAgent,
  dispatchMetadata,
  getLivekitCreds,
  lkConfigured,
  lkHttpUrl,
  lkRoomName,
  roomService,
} from "@/lib/livekit";
import { recordingEnvFrom, recordingObjectPath, type RecordingEnv } from "@/lib/call-recording";
import {
  RECORDING_BLOCK_DETAIL,
  RECORDING_HALT_THRESHOLD,
  canonicalPhone,
  capturedRecordingOk,
  consecutiveRecordingBlocks,
  dialStringFor,
  leadBlockDetailFor,
  marketingEligibilitySource,
  outboundCallGate,
  outboundDispatchExtra,
  type MarketingAttestation,
  type OutboundRefusal,
} from "@/lib/outbound-call";

// Server bindings for LiveKit OUTBOUND campaign calls (Phase 2A). NEW file on
// purpose: the inbound recording pipeline (call-recording-server.ts, the
// session route, the webhook) is not touched, and the number-routing /
// agent-management files stay free of egress + outbound-trunk tokens (their
// safety tests forbid them). Secrets never leave this process: the Azure key
// goes only into the egress request and blob-properties reads; SIP dialing
// uses the workspace's own LiveKit credentials.
//
// Sequence (§2.2 of the approved design), fail closed at every step, and the
// SIP leg dials ONLY after the egress is confirmed started — the mandatory
// "this call is recorded" disclosure is therefore true on every placed call.

/* eslint-disable @typescript-eslint/no-explicit-any */

const LIVE_CALL_WINDOW_MIN = 15; // an outbound call older than this no longer blocks concurrency

export interface PlaceCallRefusal {
  ok: false;
  reason: OutboundRefusal | "not_found" | "lead_claim_lost" | "db_write_failed" | "livekit_unconfigured" | "sip_failed";
  detail?: string;
  halted?: boolean;
}
export interface PlaceCallStarted {
  ok: true;
  room: string;
  callKey: string;
  leadId: string;
  egressId: string;
}

async function markLead(leadId: string, fields: Record<string, any>): Promise<void> {
  await supabase.from("campaign_leads").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", leadId);
}

/** Trailing recording-failure streak for a campaign; halts it at the P2 threshold. */
async function recordingStreak(campaignId: string): Promise<number> {
  const { data } = await supabase
    .from("campaign_leads")
    .select("status, status_detail")
    .eq("campaign_id", campaignId)
    .neq("status", "pending")
    .order("updated_at", { ascending: false })
    .limit(10);
  return consecutiveRecordingBlocks((data ?? []).map((r: any) => ({ status: String(r.status), statusDetail: String(r.status_detail ?? "") })));
}

async function haltIfNeeded(campaignId: string): Promise<boolean> {
  const streak = await recordingStreak(campaignId);
  if (streak < RECORDING_HALT_THRESHOLD) return false;
  await supabase
    .from("campaigns")
    .update({ halted_reason: `recording: ${streak} consecutive failures (policy P2) — resolve storage/egress, clear this field to resume` })
    .eq("id", campaignId);
  return true;
}

/**
 * Place ONE outbound campaign call (single-call concurrency by design). Picks
 * the given lead, or the oldest pending one. Everything is checked before any
 * external call; the lead is claimed with a compare-and-set so concurrent
 * invocations cannot dial the same person twice.
 */
export async function placeCampaignCall(opts: { ws: string; campaignId: string; leadId?: string }): Promise<PlaceCallRefusal | PlaceCallStarted> {
  const { ws, campaignId } = opts;

  const { data: campaign } = await supabase
    .from("campaigns").select("*").eq("id", campaignId).eq("workspace_id", ws).maybeSingle();
  if (!campaign) return { ok: false, reason: "not_found", detail: "campaign" };

  // Release stale "calling" claims (worker crash / lost call-log): a lead that
  // has held the single calling slot longer than the live-call window is marked
  // failed so the campaign cannot deadlock. A real call this old has ended too.
  await supabase
    .from("campaign_leads")
    .update({ status: "failed", status_detail: "stale_calling", updated_at: new Date().toISOString() })
    .eq("workspace_id", ws).eq("status", "calling")
    .lt("updated_at", new Date(Date.now() - LIVE_CALL_WINDOW_MIN * 60_000).toISOString());

  let leadQuery = supabase
    .from("campaign_leads").select("*").eq("campaign_id", campaignId).eq("workspace_id", ws).eq("status", "pending")
    .order("created_at", { ascending: true }).limit(1);
  if (opts.leadId) leadQuery = supabase.from("campaign_leads").select("*").eq("id", opts.leadId).eq("workspace_id", ws).limit(1);
  const { data: leadRows } = await leadQuery;
  const lead = leadRows?.[0];
  if (!lead) return { ok: false, reason: "not_found", detail: "no pending lead" };

  // S2: ONE canonical phone form for the DNC check, the dial and the records.
  const phone = canonicalPhone(lead.phone);

  const [{ data: number }, { data: agent }, { count: dncCount }, { count: liveCalls }, { count: callingLeads }] = await Promise.all([
    supabase.from("voice_numbers").select("*").eq("id", campaign.number_id ?? "").maybeSingle(),
    supabase.from("agents").select("*").eq("id", campaign.agent_id ?? "").maybeSingle(),
    supabase.from("voice_dnc").select("id", { count: "exact", head: true }).eq("workspace_id", ws).eq("phone", phone || "-"),
    supabase
      .from("voice_calls").select("id", { count: "exact", head: true })
      .eq("workspace_id", ws).eq("direction", "outbound").eq("engine", "livekit").eq("status", "in-progress")
      .gte("started_at", new Date(Date.now() - LIVE_CALL_WINDOW_MIN * 60_000).toISOString()),
    supabase.from("campaign_leads").select("id", { count: "exact", head: true }).eq("workspace_id", ws).eq("status", "calling"),
  ]);
  if (!number || !agent) return { ok: false, reason: "not_found", detail: !number ? "number" : "agent" };

  const creds = await getLivekitCreds(ws);
  if (!lkConfigured(creds)) return { ok: false, reason: "livekit_unconfigured" };
  const bound = boundLivekitAgent(agent, creds);
  const env = recordingEnvFrom(process.env as Record<string, string | undefined>);

  const gate = outboundCallGate({
    campaign: {
      direction: String(campaign.direction ?? ""),
      status: String(campaign.status ?? ""),
      approvedAt: campaign.approved_at ?? null,
      haltedReason: String(campaign.halted_reason ?? ""),
    },
    lead: { status: String(lead.status), phone, marketingEligibleAt: lead.marketing_eligible_at ?? null },
    dnc: (dncCount ?? 0) > 0,
    externalAgent: bound.external,
    outboundTrunkId: String(number.livekit_outbound_trunk_id ?? ""),
    recordingEnvReady: !!env,
    // S4 defense in depth: a live voice_calls row OR a lead already holding the
    // single calling slot both count; the 0069 partial unique index is the
    // race-proof enforcement underneath.
    liveOutboundCalls: (liveCalls ?? 0) + (callingLeads ?? 0),
    consecutiveRecordingBlocks: await recordingStreak(campaignId),
  });
  if (!gate.ok) {
    const block = leadBlockDetailFor(gate.reason);
    if (block) await markLead(String(lead.id), { status: "blocked", status_detail: block });
    const halted = gate.reason === "recording_unavailable" ? await haltIfNeeded(campaignId) : false;
    return { ok: false, reason: gate.reason, halted };
  }

  // S4: claim the lead straight into the single CALLING slot (compare-and-set
  // on status). The 0069 partial unique index (one 'calling' row per
  // workspace) makes two concurrent claims impossible at the database, not
  // just unlikely: the loser gets a unique-violation and is refused. Every
  // failure path below moves the lead out of 'calling', freeing the slot.
  const { data: claimed, error: claimErr } = await supabase
    .from("campaign_leads")
    .update({ status: "calling", status_detail: "", attempts: Number(lead.attempts ?? 0) + 1, updated_at: new Date().toISOString() })
    .eq("id", lead.id).eq("status", "pending").select("id");
  if (claimErr) {
    const duplicate = claimErr.code === "23505" || /duplicate key/i.test(claimErr.message);
    return { ok: false, reason: duplicate ? "another_call_live" : "db_write_failed", detail: duplicate ? undefined : claimErr.message };
  }
  if (!claimed?.length) return { ok: false, reason: "lead_claim_lost" };

  const room = lkRoomName(ws, "out");
  const callKey = `lk:${room}`;
  const path = recordingObjectPath(ws, room);

  // Attributed intent row FIRST — webhook/call-log upserts then land on it,
  // and the recording/campaign/lead association exists before anything rings.
  const { error: rowErr } = await supabase.from("voice_calls").insert({
    vapi_call_id: callKey,
    workspace_id: ws,
    agent_id: campaign.agent_id,
    agent_name: String(agent.name ?? ""),
    campaign_id: campaignId,
    patient_id: lead.patient_id ?? null,
    direction: "outbound",
    status: "in-progress",
    started_at: new Date().toISOString(),
    to_phone: phone,
    engine: "livekit",
    structured_data: { engine: "livekit", room, source: "campaign", leadId: String(lead.id) },
    recording_status: "active",
    recording_path: path,
  });
  if (rowErr) {
    await markLead(String(lead.id), { status: "pending" }); // release the claim
    return { ok: false, reason: "db_write_failed", detail: rowErr.message };
  }

  const rs = roomService(creds);
  const fail = async (stage: string, recording: boolean): Promise<PlaceCallRefusal> => {
    try { await rs.deleteRoom(room); } catch { /* emptyTimeout reaps it */ }
    await supabase.from("voice_calls")
      .update({ status: "failed", ended_at: new Date().toISOString(), recording_status: `failed: ${stage}` })
      .eq("vapi_call_id", callKey);
    await markLead(String(lead.id), {
      status: recording ? "blocked" : "failed",
      status_detail: recording ? RECORDING_BLOCK_DETAIL : stage,
      last_call_key: callKey,
    });
    const halted = recording ? await haltIfNeeded(campaignId) : false;
    return { ok: false, reason: recording ? "recording_unavailable" : "sip_failed", detail: stage, halted };
  };

  try {
    await rs.createRoom({ name: room, emptyTimeout: 300, departureTimeout: 20 });
  } catch (e) {
    return fail(`room create: ${e instanceof Error ? e.message : "error"}`, true);
  }
  try {
    const dispatch = new AgentDispatchClient(lkHttpUrl(creds.url), creds.apiKey, creds.apiSecret);
    await dispatch.createDispatch(room, bound.name, {
      metadata: dispatchMetadata(String(agent.id), ws, outboundDispatchExtra(campaignId, String(lead.id), phone)),
    });
  } catch (e) {
    return fail(`agent dispatch: ${e instanceof Error ? e.message : "error"}`, true);
  }

  // Recording BEFORE dialing: if the egress cannot start, nobody's phone rings.
  let egressId = "";
  try {
    const egress = new EgressClient(lkHttpUrl(creds.url), creds.apiKey, creds.apiSecret);
    const info = await egress.startRoomCompositeEgress(
      room,
      {
        file: new EncodedFileOutput({
          fileType: EncodedFileType.OGG,
          filepath: path,
          output: {
            case: "azure",
            value: new AzureBlobUpload({ accountName: env!.account, accountKey: env!.key, containerName: env!.container }),
          },
        }),
      },
      { audioOnly: true }
    );
    egressId = String(info?.egressId ?? "");
    await supabase.from("voice_calls").update({ recording_egress_id: egressId }).eq("vapi_call_id", callKey);
  } catch (e) {
    return fail(`egress start: ${e instanceof Error ? e.message : "error"}`, true);
  }

  try {
    const sip = new SipClient(lkHttpUrl(creds.url), creds.apiKey, creds.apiSecret);
    await sip.createSipParticipant(String(number.livekit_outbound_trunk_id).trim(), dialStringFor(phone), room, {
      participantIdentity: `sip-out-${String(lead.id).slice(0, 8)}`,
      participantName: "Outbound call",
    });
  } catch (e) {
    return fail(`sip create: ${e instanceof Error ? e.message : "error"}`, false);
  }

  await markLead(String(lead.id), { last_call_key: callKey }); // stays 'calling' until call-log closes it
  return { ok: true, room, callKey, leadId: String(lead.id), egressId };
}

// ── lead seeding & eligibility (staff actions, workspace-checked by caller) ──

/** Create pending leads for every folder contact with a phone number that is
 *  not already in the campaign. marketing_eligible_at is NEVER set here: the
 *  seeded leads stay undialable until eligibility is verified explicitly. */
export async function seedCampaignLeads(ws: string, campaignId: string): Promise<{ ok: boolean; added: number; total: number; error?: string }> {
  const { data: campaign } = await supabase.from("campaigns").select("*").eq("id", campaignId).eq("workspace_id", ws).maybeSingle();
  if (!campaign) return { ok: false, added: 0, total: 0, error: "Campaign not found." };
  if (!campaign.folder_id) return { ok: false, added: 0, total: 0, error: "The campaign has no contact list (folder)." };
  const [{ data: patients }, { data: existing }] = await Promise.all([
    supabase.from("patients").select("id, phone, folder_id").eq("workspace_id", ws).eq("folder_id", campaign.folder_id),
    supabase.from("campaign_leads").select("phone").eq("campaign_id", campaignId),
  ]);
  const seen = new Set((existing ?? []).map((r: any) => canonicalPhone(r.phone) || String(r.phone)));
  // S2: leads are stored in the ONE canonical phone form; numbers that do not
  // canonicalize are skipped (an invalid phone can never become a dialable lead).
  const rows = (patients ?? [])
    .map((p: any) => ({ workspace_id: ws, campaign_id: campaignId, patient_id: p.id, phone: canonicalPhone(p.phone) }))
    .filter((r: any) => r.phone && !seen.has(r.phone));
  if (rows.length) {
    const { error } = await supabase.from("campaign_leads").insert(rows);
    if (error) return { ok: false, added: 0, total: seen.size, error: error.message };
  }
  return { ok: true, added: rows.length, total: seen.size + rows.length };
}

/** Record verified marketing eligibility for leads via a STRUCTURED
 *  ATTESTATION (basis + where the documented evidence lives). Eligibility
 *  turns on verified permission, never on a form's label: a registration form
 *  with an explicit automated-promotional-calls clause is a valid basis. */
export async function markLeadsEligible(ws: string, campaignId: string, leadIds: string[], attestation: MarketingAttestation): Promise<{ ok: boolean; updated: number; error?: string }> {
  const att = marketingEligibilitySource(attestation);
  if (!att.ok) return { ok: false, updated: 0, error: att.error };
  const { data, error } = await supabase
    .from("campaign_leads")
    .update({ marketing_eligible_at: new Date().toISOString(), marketing_eligibility_source: att.source, updated_at: new Date().toISOString() })
    .eq("campaign_id", campaignId).eq("workspace_id", ws).in("id", leadIds).select("id");
  if (error) return { ok: false, updated: 0, error: error.message };
  return { ok: true, updated: data?.length ?? 0 };
}

/** S1: campaign approval is an ADMIN server action (the route enforces the
 *  role); the browser no longer writes approved_at directly. */
export async function approveCampaignForCalling(ws: string, campaignId: string, approvedBy: string): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase
    .from("campaigns")
    .update({ approved_at: new Date().toISOString(), approved_by: approvedBy })
    .eq("id", campaignId).eq("workspace_id", ws).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: "Campaign not found." };
  return { ok: true };
}

// ── capture verification (acceptance requirement: not just egress creation) ──

/** Read the stored blob's size over the authenticated Azure API (read-only).
 *  Proves a non-empty file was captured; TWO-WAY audio is confirmed by a human
 *  listening to the staged pilot recording via the normal playback route. */
export async function verifyCapturedRecording(path: string): Promise<{ ok: boolean; sizeBytes: number; detail: string }> {
  const env: RecordingEnv | null = recordingEnvFrom(process.env as Record<string, string | undefined>);
  if (!env) return { ok: false, sizeBytes: 0, detail: "storage not configured" };
  if (!String(path ?? "").trim()) return { ok: false, sizeBytes: 0, detail: "no recording path" };
  try {
    const svc = new BlobServiceClient(
      `https://${env.account}.blob.core.windows.net`,
      new StorageSharedKeyCredential(env.account, env.key)
    );
    const props = await svc.getContainerClient(env.container).getBlobClient(path).getProperties();
    const size = Number(props.contentLength ?? 0);
    return capturedRecordingOk(size)
      ? { ok: true, sizeBytes: size, detail: "captured" }
      : { ok: false, sizeBytes: size, detail: "blob exists but holds no usable audio" };
  } catch (e: any) {
    return { ok: false, sizeBytes: 0, detail: e?.statusCode === 404 ? "blob not found" : "properties read failed" };
  }
}
