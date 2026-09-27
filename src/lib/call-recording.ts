// LiveKit call recording (Stage C2) — pure decision/mapping logic.
//
// Recording is a per-agent, DEFAULT-OFF consent setting, enforced entirely
// server-side: the browser can neither request a recording nor ever see the
// storage credentials (the egress request is server→LiveKit only — the
// RoomConfiguration-in-token path is deliberately not used because a join
// token is readable by the browser).
//
// Scope: worker-bound ("Tina") agents only. External Builder agents (Laura)
// and SIP calls are out of scope until Stage C4 is separately approved.
//
// call-recording-server.ts binds LiveKit + Azure + Supabase to these rules.

import { authorizeSummaryRetry, type RetryAuthDeps, type RetryAuthResult } from "@/lib/call-summary";

// ── storage environment ──────────────────────────────────────────────────────

export interface RecordingEnv {
  account: string;
  key: string;
  container: string;
}

/** All three RECORDING_AZURE_* variables, or null (feature entirely off). */
export function recordingEnvFrom(env: Record<string, string | undefined>): RecordingEnv | null {
  const account = String(env.RECORDING_AZURE_ACCOUNT ?? "").trim();
  const key = String(env.RECORDING_AZURE_KEY ?? "").trim();
  const container = String(env.RECORDING_AZURE_CONTAINER ?? "").trim();
  return account && key && container ? { account, key, container } : null;
}

// ── eligibility (server-enforced, default off) ───────────────────────────────

export type RecordingRefusal = "storage_not_configured" | "external_agent" | "no_store" | "disabled";

export function recordingEligible(opts: {
  /** The agent's consent toggle (voice_settings.recordCalls) — default OFF. */
  recordCalls: boolean;
  /** The agent's data-storage privacy mode. no_store always wins. */
  dataStorage: string;
  /** True when the agent is bound to an external (console-built) LiveKit agent. */
  external: boolean;
  envReady: boolean;
}): { ok: true } | { ok: false; reason: RecordingRefusal } {
  if (!opts.envReady) return { ok: false, reason: "storage_not_configured" };
  if (opts.external) return { ok: false, reason: "external_agent" };
  if (opts.dataStorage === "no_store") return { ok: false, reason: "no_store" };
  if (opts.recordCalls !== true) return { ok: false, reason: "disabled" };
  return { ok: true };
}

// ── object naming ────────────────────────────────────────────────────────────

/** Workspace-scoped blob path — built ONLY from server-generated names. */
export function recordingObjectPath(ws: string, room: string): string {
  return `recordings/${ws}/${room}.ogg`;
}

// ── egress lifecycle mapping ─────────────────────────────────────────────────

// EgressStatus (livekit_egress.proto): terminal states we act on. The webhook
// receiver may surface the enum as its number or its JSON name — accept both.
const EGRESS_STATUS_NAMES: Record<number, string> = {
  0: "EGRESS_STARTING",
  1: "EGRESS_ACTIVE",
  2: "EGRESS_ENDING",
  3: "EGRESS_COMPLETE",
  4: "EGRESS_FAILED",
  5: "EGRESS_ABORTED",
  6: "EGRESS_LIMIT_REACHED",
};

function egressStatusName(v: unknown): string {
  if (typeof v === "number") return EGRESS_STATUS_NAMES[v] ?? "";
  if (typeof v === "string") return v;
  return "";
}

export interface RecordingUpdate {
  recording_status: string;
  recording_path?: string;
}

/**
 * Map an egress_ended EgressInfo to the voice_calls update, or null when the
 * event is not terminal. Only recording_* columns are ever produced here —
 * the Stage B rule (automated writers never touch other writers' columns)
 * applies to recordings too.
 */
export function egressEndedUpdate(info: {
  status?: unknown;
  error?: unknown;
  fileResults?: { filename?: unknown }[];
}): RecordingUpdate | null {
  const status = egressStatusName(info?.status);
  if (status === "EGRESS_COMPLETE") {
    const filename = String(info?.fileResults?.[0]?.filename ?? "").trim();
    return { recording_status: "complete", ...(filename ? { recording_path: filename } : {}) };
  }
  if (status === "EGRESS_FAILED") {
    const err = String(info?.error ?? "").trim();
    return { recording_status: `failed: ${err || "egress failed"}`.slice(0, 500) };
  }
  if (status === "EGRESS_ABORTED") return { recording_status: "failed: aborted" };
  if (status === "EGRESS_LIMIT_REACHED") return { recording_status: "failed: time limit reached" };
  return null; // starting / active / ending / unknown — nothing to persist
}

// ── playback gating & UI state ───────────────────────────────────────────────

export type RecordingViewKind = "none" | "pending" | "complete" | "failed";

/** What the Call Details page (and the playback route) may do with a row. */
export function recordingView(row: { recordingStatus: string; recordingPath: string }): RecordingViewKind {
  const status = String(row.recordingStatus ?? "");
  if (status === "complete" && String(row.recordingPath ?? "")) return "complete";
  if (status.startsWith("failed")) return "failed";
  if (status === "active") return "pending";
  return "none";
}

// ── access authorization (same ownership rule as summary/outcome) ────────────

export const authorizeRecordingAccess: (
  deps: RetryAuthDeps,
  token: string | null | undefined,
  callId: string
) => Promise<RetryAuthResult> = authorizeSummaryRetry;
