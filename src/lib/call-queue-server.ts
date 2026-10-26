import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { placeLineGuardedCall, type LineGuardRefusal, type LineGuardStarted } from "@/lib/shared-line-server";
import {
  callingHoursGate,
  normalizeCallKind,
  normalizeCallingHours,
  queueAttemptIdempotencyKey,
  queueItemEligibility,
  retryDecision,
} from "@/lib/call-queue";

// Server bindings for the outbound call queue (Phase 4). The queue is a
// scheduling layer ONLY: every dial goes through placeLineGuardedCall — the
// campaign gates (approval, verified eligibility, DNC, recording-before-dial)
// and the shared FXO line controller (inbound priority, attested idle,
// atomic reservation, cooldown) all still apply, so the queue can never relax
// a safeguard. Until migrations 0069–0071 are applied, everything here
// refuses (fail closed). There is deliberately NO cron wiring: automated
// outbound initiation stays disabled until a reliable physical line-state
// source exists (deliverable K-1) — queue-run is an explicit admin action.

/* eslint-disable @typescript-eslint/no-explicit-any */

const nowIso = () => new Date().toISOString();

export async function enqueueCall(
  ws: string,
  actor: string,
  opts: { campaignId: string; leadId: string; kind: string; scheduledAt: string; notAfter?: string; maxAttempts?: number; consentBasis?: string }
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const kind = normalizeCallKind(opts.kind);
  if (!kind) return { ok: false, error: `kind must be one of the defined call kinds.` };
  const at = Date.parse(String(opts.scheduledAt ?? ""));
  if (!Number.isFinite(at)) return { ok: false, error: "scheduledAt must be a valid ISO timestamp." };
  // The lead must exist in this workspace and campaign (tenant isolation).
  const { data: lead, error: leadErr } = await supabase
    .from("campaign_leads").select("id").eq("id", opts.leadId).eq("campaign_id", opts.campaignId).eq("workspace_id", ws).maybeSingle();
  if (leadErr) return { ok: false, error: "queue tables unavailable or lead unreadable (fail closed)." };
  if (!lead) return { ok: false, error: "Lead not found in this campaign." };
  const { data, error } = await supabase
    .from("call_queue")
    .insert({
      workspace_id: ws,
      campaign_id: opts.campaignId,
      lead_id: opts.leadId,
      kind,
      consent_basis: String(opts.consentBasis ?? "").slice(0, 200),
      scheduled_at: new Date(at).toISOString(),
      not_after: opts.notAfter && Number.isFinite(Date.parse(opts.notAfter)) ? new Date(Date.parse(opts.notAfter)).toISOString() : null,
      max_attempts: Number(opts.maxAttempts) > 0 ? Math.min(Number(opts.maxAttempts), 5) : 2,
      created_by: actor,
    })
    .select("id");
  if (error) {
    if (error.code === "23505" || /duplicate key/i.test(error.message)) return { ok: false, error: "This lead already has a live queue entry (duplicate prevented)." };
    return { ok: false, error: /call_queue/.test(error.message) ? "call_queue unavailable (migration 0071 not applied)." : error.message };
  }
  return { ok: true, id: data?.[0]?.id ? String(data[0].id) : undefined };
}

export async function queueStatus(ws: string): Promise<{ ok: boolean; counts: Record<string, number>; nextDue?: Record<string, any> | null; error?: string }> {
  const { data, error } = await supabase
    .from("call_queue").select("status, kind, scheduled_at, campaign_id").eq("workspace_id", ws)
    .order("scheduled_at", { ascending: true }).limit(500);
  if (error) return { ok: false, counts: {}, error: "call_queue unavailable (migration 0071 not applied)." };
  const counts: Record<string, number> = {};
  for (const r of data ?? []) counts[String(r.status)] = (counts[String(r.status)] ?? 0) + 1;
  const next = (data ?? []).find((r: any) => String(r.status) === "scheduled");
  return { ok: true, counts, nextDue: next ? { kind: next.kind, scheduledAt: next.scheduled_at, campaignId: next.campaign_id } : null };
}

export type QueueRunResult =
  | { ok: true; itemId: string; attempt: number; call: LineGuardStarted }
  | { ok: false; reason: string; itemId?: string; detail?: string };

/**
 * Run AT MOST ONE due queue item (single-call discipline, like start-next).
 * Explicit admin action — never wired to a scheduler while automated outbound
 * stays disabled (K-1).
 */
export async function runQueueOnce(ws: string, actor: string): Promise<QueueRunResult> {
  const { data: rows, error } = await supabase
    .from("call_queue").select("*").eq("workspace_id", ws).eq("status", "scheduled")
    .lte("scheduled_at", nowIso()).order("scheduled_at", { ascending: true }).limit(10);
  if (error) return { ok: false, reason: "db_unavailable", detail: "call_queue unavailable (migration 0071 not applied)." };

  // Expire overdue windows first; the first still-eligible item runs.
  let item: any = null;
  for (const r of rows ?? []) {
    const elig = queueItemEligibility({
      status: String(r.status),
      scheduledAt: r.scheduled_at ?? null,
      notAfter: r.not_after ?? null,
      attempts: Number(r.attempts) || 0,
      maxAttempts: Number(r.max_attempts) || 1,
      retryBackoffMinutes: Number(r.retry_backoff_minutes) || 120,
    });
    if (elig === "expired") {
      await supabase.from("call_queue").update({ status: "expired", updated_at: nowIso() }).eq("id", r.id).eq("status", "scheduled");
      continue;
    }
    if (elig === "due") { item = r; break; }
  }
  if (!item) return { ok: false, reason: "nothing_due" };

  // Calling hours: the campaign's policy, defaulting conservatively.
  const { data: campaign } = await supabase
    .from("campaigns").select("calling_hours").eq("id", item.campaign_id).eq("workspace_id", ws).maybeSingle();
  const hours = callingHoursGate(normalizeCallingHours(campaign?.calling_hours));
  if (!hours.ok) return { ok: false, reason: "outside_calling_hours", itemId: String(item.id) };

  // Claim the item (compare-and-set): a concurrent runner loses cleanly.
  const attempt = (Number(item.attempts) || 0) + 1;
  const { data: claimed, error: claimErr } = await supabase
    .from("call_queue")
    .update({ status: "calling", attempts: attempt, updated_at: nowIso() })
    .eq("id", item.id).eq("status", "scheduled").select("id");
  if (claimErr || !claimed?.length) return { ok: false, reason: "claim_lost", itemId: String(item.id) };

  const placed = await placeLineGuardedCall({
    ws,
    campaignId: String(item.campaign_id),
    leadId: String(item.lead_id),
    // Stable per (item, attempt): a crashed/retried runner can never
    // double-dial the same attempt.
    idempotencyKey: queueAttemptIdempotencyKey(String(item.id), attempt),
    actor,
  });

  if (placed.ok) {
    await supabase.from("call_queue").update({ last_call_key: placed.callKey, updated_at: nowIso() }).eq("id", item.id);
    return { ok: true, itemId: String(item.id), attempt, call: placed };
  }

  // No dial happened (except sip_failed, which seized the line briefly).
  const reason = String(placed.reason);
  const terminal =
    reason === "do_not_call" || reason === "not_marketing_eligible" || reason === "invalid_phone" ||
    reason === "own_number" || reason === "special_service" || reason === "not_uae_mobile" || reason === "invalid";
  if (terminal) {
    await supabase.from("call_queue")
      .update({ status: "cancelled", last_outcome: reason, updated_at: nowIso() })
      .eq("id", item.id).eq("status", "calling");
    return { ok: false, reason, itemId: String(item.id) };
  }
  if (reason === "sip_failed") {
    const d = retryDecision({ attempts: attempt, maxAttempts: Number(item.max_attempts) || 1, retryBackoffMinutes: Number(item.retry_backoff_minutes) || 120 }, "sip_failed");
    await supabase.from("call_queue")
      .update(
        d.action === "retry"
          ? { status: "scheduled", scheduled_at: new Date(d.nextAttemptAtMs!).toISOString(), last_outcome: reason, updated_at: nowIso() }
          : { status: "failed", last_outcome: reason, updated_at: nowIso() }
      )
      .eq("id", item.id).eq("status", "calling");
    return { ok: false, reason, itemId: String(item.id), detail: placed.detail };
  }
  // Transient refusal (line busy/unknown/cooldown, campaign paused, DB):
  // the attempt did not happen — roll the counter back and retry shortly.
  await supabase.from("call_queue")
    .update({
      status: "scheduled",
      attempts: Number(item.attempts) || 0,
      scheduled_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      last_outcome: reason,
      updated_at: nowIso(),
    })
    .eq("id", item.id).eq("status", "calling");
  return { ok: false, reason, itemId: String(item.id), detail: (placed as LineGuardRefusal).detail };
}

/** Close out the queue item whose call just ended (worker call-log hook).
 *  Keyed by call_key; late/replayed posts cannot touch newer items. */
export async function closeQueueItemForCallEnd(ws: string, callKey: string, outcome: string): Promise<void> {
  if (!String(callKey ?? "")) return;
  const { data, error } = await supabase
    .from("call_queue").select("*").eq("workspace_id", ws).eq("last_call_key", callKey).eq("status", "calling").limit(1);
  if (error) return; // tables absent / transient — queue state reconciled manually
  const item = data?.[0];
  if (!item) return;
  const d = retryDecision(
    { attempts: Number(item.attempts) || 0, maxAttempts: Number(item.max_attempts) || 1, retryBackoffMinutes: Number(item.retry_backoff_minutes) || 120 },
    outcome
  );
  const patch =
    d.action === "retry"
      ? { status: "scheduled", scheduled_at: new Date(d.nextAttemptAtMs!).toISOString(), last_outcome: String(outcome ?? "") }
      : { status: d.action === "done" ? "done" : d.action === "cancelled" ? "cancelled" : "failed", last_outcome: String(outcome ?? "") };
  await supabase.from("call_queue").update({ ...patch, updated_at: nowIso() }).eq("id", item.id).eq("status", "calling");
}
