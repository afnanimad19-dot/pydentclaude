import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { canonicalPhone } from "@/lib/outbound-call";
import { placeCampaignCall, type PlaceCallRefusal, type PlaceCallStarted } from "@/lib/outbound-call-server";
import {
  ACTIVE_RESERVATION_TTL_SECONDS,
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_OBSERVATION_TTL_SECONDS,
  HOLDING_RESERVATION_STATUSES,
  INBOUND_LIVE_WINDOW_MIN,
  RESERVATION_TTL_SECONDS,
  callEndReleases,
  canTransitionReservation,
  deriveLineState,
  lineAdmission,
  normalizeIdempotencyKey,
  outboundDestinationPolicy,
  reservationSweepAction,
  type SharedLineRefusal,
  type SharedLineState,
} from "@/lib/shared-line";

// Server bindings for the shared FXO line controller (Phase 2B). NEW file on
// purpose: the inbound pipeline (webhook, session, number routing) is not
// touched, and outbound-call-server.ts keeps its own gate unchanged — this
// controller runs IN FRONT of it, strictly narrowing admission (defense in
// depth: both gates must pass). Every database failure here is a refusal,
// never a pass-through: an unknown line state is never treated as idle.
//
// Until migrations 0069+0070 are applied (separately-approved step), every
// admission fails closed with a db_unavailable refusal — the controller
// cannot invent a line row it cannot read.

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The one physical line this phase manages (D-Link Trunk1 / FXO port 1). */
export const SHARED_LINE_KEY = "fxo1";

export type LineGuardRefusalReason = SharedLineRefusal | "db_unavailable" | "no_pending_lead";

export interface LineGuardRefusal {
  ok: false;
  reason: LineGuardRefusalReason | PlaceCallRefusal["reason"];
  detail?: string;
  lineState?: SharedLineState;
  reservationId?: string;
  halted?: boolean;
}
export interface LineGuardStarted extends PlaceCallStarted {
  reservationId: string;
}

interface LineRow {
  id: string;
  workspace_id: string;
  maintenance: boolean;
  auto_outbound_enabled: boolean;
  cooldown_seconds: number;
  cooldown_until: string | null;
  observed_state: string;
  observed_at: string | null;
  observed_source: string;
  observed_ttl_seconds: number;
  [k: string]: any;
}

const nowIso = () => new Date().toISOString();

async function logLineEvent(e: {
  ws: string;
  lineId: string;
  reservationId?: string;
  campaignId?: string;
  leadId?: string;
  callKey?: string;
  fromState?: string;
  toState?: string;
  reason: string;
  actor: string;
}): Promise<void> {
  // Best-effort append-only audit; an audit hiccup never flips a decision.
  try {
    await supabase.from("shared_line_events").insert({
      workspace_id: e.ws,
      line_id: e.lineId,
      reservation_id: e.reservationId ?? null,
      campaign_id: e.campaignId ?? null,
      lead_id: e.leadId ?? null,
      call_key: e.callKey ?? "",
      from_state: e.fromState ?? "",
      to_state: e.toState ?? "",
      reason: e.reason,
      actor: e.actor,
    });
  } catch {
    /* audited decision still stands */
  }
}

/** Load (or create, once) the workspace's shared-line row. Any failure returns
 *  null and the caller refuses — a line we cannot read is never dialable. */
async function ensureLine(ws: string): Promise<LineRow | null> {
  const sel = () =>
    supabase.from("shared_lines").select("*").eq("workspace_id", ws).eq("line_key", SHARED_LINE_KEY).maybeSingle();
  const { data, error } = await sel();
  if (error) return null;
  if (data) return data as LineRow;
  const { error: insErr } = await supabase.from("shared_lines").insert({
    workspace_id: ws,
    line_key: SHARED_LINE_KEY,
    observed_state: "unknown",
    cooldown_seconds: DEFAULT_COOLDOWN_SECONDS,
    observed_ttl_seconds: DEFAULT_OBSERVATION_TTL_SECONDS,
  });
  if (insErr && insErr.code !== "23505") return null; // 23505 = concurrent create won the race
  const again = await sel();
  return again.error ? null : ((again.data as LineRow) ?? null);
}

/** Live inbound LiveKit calls right now. Errors count as "inbound present"
 *  (fail closed): if we cannot see inbound state we must not dial. */
async function liveInboundCount(ws: string): Promise<number> {
  const { count, error } = await supabase
    .from("voice_calls")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", ws)
    .eq("direction", "inbound")
    .eq("engine", "livekit")
    .in("status", ["live", "in-progress"])
    .gte("started_at", new Date(Date.now() - INBOUND_LIVE_WINDOW_MIN * 60_000).toISOString());
  if (error) return 1;
  return count ?? 0;
}

/** The reservation currently holding the line slot, if any. On a read error
 *  the caller must refuse, so errors read as a synthetic holder. */
async function holdingReservation(lineId: string): Promise<{ row: any | null; readFailed: boolean }> {
  const { data, error } = await supabase
    .from("line_reservations")
    .select("*")
    .eq("line_id", lineId)
    .in("status", HOLDING_RESERVATION_STATUSES as unknown as string[])
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return { row: null, readFailed: true };
  return { row: data?.[0] ?? null, readFailed: false };
}

async function transitionReservation(
  res: { id: string; status: string },
  to: "dialing" | "active" | "released" | "expired" | "failed",
  fields: Record<string, any>
): Promise<boolean> {
  if (!canTransitionReservation(String(res.status), to)) return false;
  // Compare-and-set on the previous status so a concurrent transition loses
  // cleanly instead of overwriting a newer state.
  const { data, error } = await supabase
    .from("line_reservations")
    .update({ status: to, updated_at: nowIso(), ...fields })
    .eq("id", res.id)
    .eq("status", res.status)
    .select("id");
  return !error && !!data?.length;
}

async function startCooldown(line: LineRow, ws: string, reason: string, reservationId?: string): Promise<void> {
  const secs = Number(line.cooldown_seconds) > 0 ? Number(line.cooldown_seconds) : DEFAULT_COOLDOWN_SECONDS;
  const until = new Date(Date.now() + secs * 1000).toISOString();
  await supabase.from("shared_lines").update({ cooldown_until: until, updated_at: nowIso() }).eq("id", line.id);
  await logLineEvent({ ws, lineId: line.id, reservationId, reason: `cooldown until ${until}: ${reason}`, toState: "cooldown", actor: "system" });
}

/** Is the reservation's call verifiably live / verifiably ended? Read errors
 *  report "neither verified", which keeps the reservation held (fail closed —
 *  a held line blocks calls, never places one). */
async function callVerdict(ws: string, callKey: string): Promise<{ inProgress: boolean; ended: boolean }> {
  if (!callKey) return { inProgress: false, ended: false };
  const { data, error } = await supabase
    .from("voice_calls")
    .select("status, started_at, ended_at")
    .eq("workspace_id", ws)
    .eq("vapi_call_id", callKey)
    .limit(1)
    .maybeSingle();
  if (error || !data) return { inProgress: false, ended: false };
  const status = String(data.status ?? "");
  const startedAt = data.started_at ? Date.parse(String(data.started_at)) : NaN;
  const fresh = Number.isFinite(startedAt) && Date.now() - startedAt < ACTIVE_RESERVATION_TTL_SECONDS * 1000;
  return {
    inProgress: (status === "in-progress" || status === "live") && fresh,
    ended: status === "ended" || status === "failed" || !!data.ended_at,
  };
}

/** Expiry / crash-cleanup / reconciliation sweep for the line's holding
 *  reservation. Never releases a verifiably in-flight call; promotes a
 *  'dialing' reservation whose call is confirmed in progress to 'active'. */
async function sweepReservation(ws: string, line: LineRow): Promise<void> {
  const { row } = await holdingReservation(line.id);
  if (!row) return;
  const verdict = await callVerdict(ws, String(row.call_key ?? ""));
  const action = reservationSweepAction(
    { status: String(row.status), expiresAt: row.expires_at ?? null, callInProgress: verdict.inProgress, callEnded: verdict.ended },
    new Date()
  );
  if (action === "keep") {
    if (String(row.status) === "dialing" && verdict.inProgress) {
      const ok = await transitionReservation(row, "active", {});
      if (ok)
        await logLineEvent({ ws, lineId: line.id, reservationId: String(row.id), callKey: String(row.call_key ?? ""), fromState: "outbound_dialing", toState: "outbound_active", reason: "call confirmed in progress", actor: "system" });
    }
    return;
  }
  if (action === "extend") {
    await supabase
      .from("line_reservations")
      .update({ expires_at: new Date(Date.now() + ACTIVE_RESERVATION_TTL_SECONDS * 1000).toISOString(), updated_at: nowIso() })
      .eq("id", row.id);
    await logLineEvent({ ws, lineId: line.id, reservationId: String(row.id), reason: "expiry extended: call still in progress (an expired reservation never releases an active call)", actor: "system" });
    return;
  }
  if (action === "release_reconciled") {
    const ok = await transitionReservation(row, "released", { release_reason: "reconciled: call ended", released_at: nowIso() });
    if (ok) await startCooldown(line, ws, "reconciled call end", String(row.id));
    await logLineEvent({ ws, lineId: line.id, reservationId: String(row.id), callKey: String(row.call_key ?? ""), fromState: String(row.status), toState: "released", reason: "reconciled with verified call end", actor: "system" });
    return;
  }
  // expire: a stale claim with no live call behind it (worker crash cleanup).
  const ok = await transitionReservation(row, "expired", { release_reason: "ttl expired with no live call", released_at: nowIso() });
  if (ok)
    await logLineEvent({ ws, lineId: line.id, reservationId: String(row.id), fromState: String(row.status), toState: "expired", reason: "reservation TTL expired; no verifiable call in progress", actor: "system" });
}

/** Deterministic derived state for the line, after the sweep. */
async function derivedState(ws: string, line: LineRow, opts?: { excludeReservationId?: string }): Promise<{ state: SharedLineState; holding: any | null }> {
  const inbound = await liveInboundCount(ws);
  const { row, readFailed } = await holdingReservation(line.id);
  const holding = opts?.excludeReservationId && row && String(row.id) === opts.excludeReservationId ? null : row;
  const state = deriveLineState({
    maintenance: !!line.maintenance,
    liveInboundCalls: inbound,
    // A failed reservation read is reported as a holder: unknown occupancy
    // must block, and "reserved" maps to a refusal (fail closed).
    activeReservationStatus: readFailed ? "reserved" : holding ? (String(holding.status) as any) : "",
    cooldownUntil: line.cooldown_until ?? null,
    observation: {
      state: String(line.observed_state ?? ""),
      at: line.observed_at ?? null,
      source: String(line.observed_source ?? ""),
      ttlSeconds: Number(line.observed_ttl_seconds) || DEFAULT_OBSERVATION_TTL_SECONDS,
    },
  });
  return { state, holding };
}

// ── public API ────────────────────────────────────────────────────────────────

/** Line status for the UI / operator: derived state + holding reservation. */
export async function getLineStatus(ws: string): Promise<{
  ok: boolean;
  state: SharedLineState;
  line?: Record<string, any>;
  reservation?: Record<string, any> | null;
  error?: string;
}> {
  const line = await ensureLine(ws);
  if (!line) return { ok: false, state: "unknown", error: "shared-line tables unavailable (migration 0070 not applied) — outbound is disabled (fail closed)." };
  await sweepReservation(ws, line);
  const { data: fresh } = await supabase.from("shared_lines").select("*").eq("id", line.id).maybeSingle();
  const row = (fresh as LineRow) ?? line;
  const { state, holding } = await derivedState(ws, row);
  return {
    ok: true,
    state,
    line: {
      id: row.id,
      maintenance: !!row.maintenance,
      autoOutboundEnabled: !!row.auto_outbound_enabled,
      cooldownUntil: row.cooldown_until ?? null,
      observedState: String(row.observed_state ?? ""),
      observedAt: row.observed_at ?? null,
      observedSource: String(row.observed_source ?? ""),
      observedTtlSeconds: Number(row.observed_ttl_seconds) || DEFAULT_OBSERVATION_TTL_SECONDS,
    },
    reservation: holding
      ? { id: holding.id, status: holding.status, campaignId: holding.campaign_id, leadId: holding.lead_id, callKey: holding.call_key, expiresAt: holding.expires_at }
      : null,
  };
}

/** Operator attestation: a staff admin personally verified the physical line
 *  is idle RIGHT NOW (supervised pilot procedure). Valid for the observation
 *  TTL only. This is the ONLY trusted idle source until a supported D-Link
 *  read-only state interface is verified (documented missing prerequisite). */
export async function attestLineIdle(ws: string, actor: string, note: string): Promise<{ ok: boolean; validForSeconds?: number; error?: string }> {
  const line = await ensureLine(ws);
  if (!line) return { ok: false, error: "shared-line tables unavailable (migration 0070 not applied)." };
  const ttl = Number(line.observed_ttl_seconds) > 0 ? Number(line.observed_ttl_seconds) : DEFAULT_OBSERVATION_TTL_SECONDS;
  const { error } = await supabase
    .from("shared_lines")
    .update({ observed_state: "idle", observed_at: nowIso(), observed_source: "operator_attested", observed_note: String(note ?? "").slice(0, 500), updated_at: nowIso() })
    .eq("id", line.id);
  if (error) return { ok: false, error: error.message };
  await logLineEvent({ ws, lineId: line.id, toState: "idle", reason: `operator attested line idle${note ? `: ${String(note).slice(0, 200)}` : ""}`, actor });
  return { ok: true, validForSeconds: ttl };
}

/** Maintenance switch: blocks all outbound admission while enabled. */
export async function setLineMaintenance(ws: string, actor: string, enabled: boolean, note: string): Promise<{ ok: boolean; error?: string }> {
  const line = await ensureLine(ws);
  if (!line) return { ok: false, error: "shared-line tables unavailable (migration 0070 not applied)." };
  const { error } = await supabase.from("shared_lines").update({ maintenance: !!enabled, updated_at: nowIso() }).eq("id", line.id);
  if (error) return { ok: false, error: error.message };
  await logLineEvent({ ws, lineId: line.id, toState: enabled ? "unavailable" : "unknown", reason: `maintenance ${enabled ? "enabled" : "disabled"}${note ? `: ${String(note).slice(0, 200)}` : ""}`, actor });
  return { ok: true };
}

/**
 * The guarded outbound sequence (§7 of the approved design):
 * admission → atomic reservation → final availability re-check → dial via the
 * existing fail-closed campaign dialer → reservation tracks the call until a
 * verified termination releases it (call-log close-out or reconciliation).
 */
export async function placeLineGuardedCall(opts: {
  ws: string;
  campaignId: string;
  leadId?: string;
  idempotencyKey: unknown;
  actor: string;
}): Promise<LineGuardRefusal | LineGuardStarted> {
  const { ws, campaignId } = opts;
  const idem = normalizeIdempotencyKey(opts.idempotencyKey);
  if (!idem) return { ok: false, reason: "bad_idempotency_key", detail: "idempotencyKey (8–128 chars of A-Za-z0-9._:-) is required." };

  const line = await ensureLine(ws);
  if (!line) return { ok: false, reason: "db_unavailable", detail: "shared-line tables unavailable (migration 0070 not applied) — outbound is disabled (fail closed)." };

  // Replay? The SAME request never creates a second call.
  {
    const { data, error } = await supabase
      .from("line_reservations").select("*").eq("workspace_id", ws).eq("idempotency_key", idem).limit(1);
    if (error) return { ok: false, reason: "db_unavailable", detail: error.message };
    const prior = data?.[0];
    if (prior) {
      return {
        ok: false,
        reason: "duplicate_request",
        detail: `this idempotency key was already used (reservation ${prior.id}, status ${prior.status})`,
        reservationId: String(prior.id),
      };
    }
  }

  await sweepReservation(ws, line);

  // Resolve the lead FIRST so the destination policy runs before anything is
  // reserved; the controller then pins the dialer to this exact lead.
  let leadQuery = supabase
    .from("campaign_leads").select("id, phone, status").eq("campaign_id", campaignId).eq("workspace_id", ws).eq("status", "pending")
    .order("created_at", { ascending: true }).limit(1);
  if (opts.leadId) leadQuery = supabase.from("campaign_leads").select("id, phone, status").eq("id", opts.leadId).eq("workspace_id", ws).limit(1);
  const { data: leadRows, error: leadErr } = await leadQuery;
  if (leadErr) return { ok: false, reason: "db_unavailable", detail: leadErr.message };
  const lead = leadRows?.[0];
  if (!lead) return { ok: false, reason: "no_pending_lead" };

  // Destination policy (application copy — the proposed Asterisk context
  // enforces the same rules again at the telephony boundary).
  const phone = canonicalPhone(lead.phone);
  const { data: ownNums } = await supabase.from("voice_numbers").select("phone").eq("workspace_id", ws);
  const ownCanonical = (ownNums ?? []).map((n: any) => canonicalPhone(n.phone)).filter(Boolean);
  const policy = outboundDestinationPolicy(phone, ownCanonical);
  if (!policy.ok) {
    await supabase
      .from("campaign_leads")
      .update({ status: "blocked", status_detail: `destination_policy:${policy.reason}`, updated_at: nowIso() })
      .eq("id", lead.id).eq("status", "pending");
    return { ok: false, reason: policy.reason };
  }

  // Shared-line admission (strictly before any reservation).
  const pre = await derivedState(ws, line);
  const admission = lineAdmission(pre.state);
  if (!admission.ok) return { ok: false, reason: admission.reason, lineState: pre.state };

  // Atomic reservation: the partial unique index makes the single slot a
  // database fact across all workers; the loser of a race gets 23505.
  const { data: created, error: resErr } = await supabase
    .from("line_reservations")
    .insert({
      workspace_id: ws,
      line_id: line.id,
      campaign_id: campaignId,
      lead_id: lead.id,
      idempotency_key: idem,
      status: "reserved",
      expires_at: new Date(Date.now() + RESERVATION_TTL_SECONDS * 1000).toISOString(),
    })
    .select("*");
  if (resErr) {
    if (resErr.code === "23505" || /duplicate key/i.test(resErr.message)) {
      const dup = /idem/i.test(resErr.message);
      return { ok: false, reason: dup ? "duplicate_request" : "line_busy_outbound", detail: dup ? "concurrent duplicate request" : "another reservation holds the line" };
    }
    return { ok: false, reason: "db_unavailable", detail: resErr.message };
  }
  const reservation = created?.[0];
  if (!reservation) return { ok: false, reason: "reservation_conflict" };
  const reservationId = String(reservation.id);
  await logLineEvent({ ws, lineId: line.id, reservationId, campaignId, leadId: String(lead.id), fromState: pre.state, toState: "outbound_reserved", reason: "reservation acquired", actor: opts.actor });

  const releaseAndRefuse = async (reason: LineGuardRefusal["reason"], detail?: string, cooldown = false, halted?: boolean): Promise<LineGuardRefusal> => {
    await transitionReservation({ id: reservationId, status: "reserved" }, "released", { release_reason: String(reason), released_at: nowIso() });
    await logLineEvent({ ws, lineId: line.id, reservationId, campaignId, leadId: String(lead.id), fromState: "outbound_reserved", toState: "released", reason: `refused: ${reason}${detail ? ` (${detail})` : ""}`, actor: "system" });
    if (cooldown) await startCooldown(line, ws, `failed dial attempt: ${reason}`, reservationId);
    return { ok: false, reason, detail, reservationId, halted };
  };

  // Final availability re-check between reservation and dial: inbound may
  // have started in the window. Our own fresh reservation is excluded.
  const post = await derivedState(ws, line, { excludeReservationId: reservationId });
  const postAdmission = lineAdmission(post.state);
  if (!postAdmission.ok) return releaseAndRefuse(postAdmission.reason, `final pre-dial check: line ${post.state}`);

  // Existing fail-closed dialer: campaign approval, eligibility, DNC,
  // recording-before-dial, single calling slot — all still enforced.
  const placed = await placeCampaignCall({ ws, campaignId, leadId: String(lead.id) });
  if (!placed.ok) {
    // sip_failed means the line may have been seized briefly — cool down.
    return releaseAndRefuse(placed.reason, placed.detail, placed.reason === "sip_failed", placed.halted);
  }

  const moved = await transitionReservation({ id: reservationId, status: "reserved" }, "dialing", {
    call_key: placed.callKey,
    expires_at: new Date(Date.now() + ACTIVE_RESERVATION_TTL_SECONDS * 1000).toISOString(),
  });
  if (moved)
    await logLineEvent({ ws, lineId: line.id, reservationId, campaignId, leadId: placed.leadId, callKey: placed.callKey, fromState: "outbound_reserved", toState: "outbound_dialing", reason: "SIP dial started (egress already recording)", actor: "system" });
  return { ...placed, reservationId };
}

/** Verified-termination release, called from the worker's call-log post. Only
 *  the reservation whose call_key matches is touched; a late or replayed
 *  event for an older call can never release a newer reservation. */
export async function releaseReservationForCallEnd(ws: string, callKey: string): Promise<void> {
  if (!String(callKey ?? "")) return;
  const { data, error } = await supabase
    .from("line_reservations")
    .select("*")
    .eq("workspace_id", ws)
    .eq("call_key", callKey)
    .in("status", HOLDING_RESERVATION_STATUSES as unknown as string[])
    .limit(1);
  if (error) return; // tables absent / transient — the sweep reconciles later
  const row = data?.[0];
  if (!row || !callEndReleases({ status: String(row.status), callKey: String(row.call_key ?? "") }, callKey)) return;
  const ok = await transitionReservation(row, "released", { release_reason: "call ended (worker call-log)", released_at: nowIso() });
  if (!ok) return;
  const line = await ensureLine(ws);
  if (line) {
    await startCooldown(line, ws, "verified call termination", String(row.id));
    await logLineEvent({ ws, lineId: line.id, reservationId: String(row.id), callKey, fromState: String(row.status), toState: "released", reason: "released on verified call termination", actor: "worker" });
  }
}
