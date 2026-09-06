import { AccessToken, RoomServiceClient, SipClient, WebhookReceiver, RoomConfiguration, RoomAgentDispatch } from "livekit-server-sdk";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { languageRule } from "@/lib/agent-reply";
import { LIVEKIT_DEFAULTS, livekitSttLanguage, type LivekitAgentSettings } from "@/lib/livekit-models";

// LiveKit voice engine — server helpers. Credentials are per workspace
// (livekit_config, migration 0059) with env fallback, so one Pydent install can
// serve clinics on their own LiveKit projects or a shared one.
//
// Architecture: LiveKit's no-code Agent Builder has no management API, so Pydent
// does NOT push agent copies into LiveKit. Instead ONE deployed worker
// (livekit-agent/, agent name "pydent-agent") is dispatched into every call with
// metadata { pydentAgentId, ws }; it fetches that agent's live config from
// /api/livekit/agent-config and runs the STT → LLM → TTS pipeline with those
// exact models/voice/instructions. Editing an agent in Pydent therefore changes
// the very next call — nothing to "sync".

export interface LivekitCreds {
  url: string;       // wss://<project>.livekit.cloud
  apiKey: string;
  apiSecret: string;
  agentName: string; // the deployed worker's agent name (explicit dispatch)
  source: "workspace" | "env" | "none";
}

export async function getLivekitCreds(ws: string | null | undefined): Promise<LivekitCreds> {
  if (ws) {
    try {
      const { data } = await supabase.from("livekit_config").select("*").eq("workspace_id", ws).maybeSingle();
      if (data && data.enabled !== false && data.url && data.api_key && data.api_secret) {
        return { url: String(data.url).trim(), apiKey: String(data.api_key).trim(), apiSecret: String(data.api_secret).trim(), agentName: String(data.agent_name || "pydent-agent").trim(), source: "workspace" };
      }
    } catch { /* table may not be migrated yet — fall through to env */ }
  }
  const url = (process.env.LIVEKIT_URL || "").trim();
  const apiKey = (process.env.LIVEKIT_API_KEY || "").trim();
  const apiSecret = (process.env.LIVEKIT_API_SECRET || "").trim();
  if (url && apiKey && apiSecret) return { url, apiKey, apiSecret, agentName: (process.env.LIVEKIT_AGENT_NAME || "pydent-agent").trim(), source: "env" };
  return { url: "", apiKey: "", apiSecret: "", agentName: "pydent-agent", source: "none" };
}

export function lkConfigured(c: LivekitCreds): boolean {
  return !!(c.url && c.apiKey && c.apiSecret);
}

// wss://x.livekit.cloud → https://x.livekit.cloud (server API base).
export function lkHttpUrl(url: string): string {
  return url.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://").replace(/\/+$/, "");
}

// The project's SIP domain (what a carrier / PBX dials into): x.sip.livekit.cloud.
export function lkSipDomain(url: string): string {
  try {
    const host = new URL(lkHttpUrl(url)).host;
    return host.replace(/\.livekit\.cloud$/i, ".sip.livekit.cloud");
  } catch {
    return "";
  }
}

// Rooms carry the workspace in their name so webhooks (which don't include our
// dispatch metadata) can still be attributed: p_<workspace uuid>_<kind>_<rand>.
export function lkRoomName(ws: string, kind: "test" | "call" | "out"): string {
  return `p_${ws}_${kind}_${Math.random().toString(36).slice(2, 8)}`;
}
export function wsFromRoom(room: string): { ws: string | null; kind: string } {
  const m = /^p_([0-9a-f-]{36})_([a-z]+)_/i.exec(room || "");
  return { ws: m ? m[1] : null, kind: m ? m[2] : "" };
}

export function roomService(c: LivekitCreds): RoomServiceClient {
  return new RoomServiceClient(lkHttpUrl(c.url), c.apiKey, c.apiSecret);
}
export function sipClient(c: LivekitCreds): SipClient {
  return new SipClient(lkHttpUrl(c.url), c.apiKey, c.apiSecret);
}
export function webhookReceiver(c: LivekitCreds): WebhookReceiver {
  return new WebhookReceiver(c.apiKey, c.apiSecret);
}

// Dispatch metadata the worker receives for every call.
export function dispatchMetadata(pydentAgentId: string, ws: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ pydentAgentId, ws, ...(extra ?? {}) });
}

export function agentRoomConfig(c: LivekitCreds, metadata: string): RoomConfiguration {
  return new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName: c.agentName, metadata })] });
}

// A join token for the browser test call; the room config auto-dispatches the
// worker for this agent the moment the room is created.
export async function mintRoomToken(c: LivekitCreds, room: string, identity: string, metadata: string): Promise<string> {
  const at = new AccessToken(c.apiKey, c.apiSecret, { identity, ttl: "1h" });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
  at.roomConfig = agentRoomConfig(c, metadata);
  return at.toJwt();
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// Everything the worker needs to run one agent, built from the saved row.
export function livekitAgentConfig(agent: any, ws: string, origin: string) {
  const vs = (agent.voice_settings ?? {}) as Record<string, any>;
  const lk: LivekitAgentSettings = { ...LIVEKIT_DEFAULTS, ...(vs.livekit ?? {}) };
  const instructions = [
    `You are ${agent.name}, an AI voice agent for a dental clinic, on a live phone call.`,
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    languageRule(agent.language),
    "MULTILINGUAL: if the caller speaks another language (Arabic, Hindi, Urdu, Russian, French ...), switch and continue the whole call in it; translate knowledge-base facts naturally.",
    agent.agent_identity && `AGENT IDENTITY:\n${agent.agent_identity}`,
    agent.instructions && `TASKS:\n${agent.instructions}`,
    agent.behavior && `STYLE GUARDRAILS:\n${agent.behavior}`,
    agent.knowledge_base && `KNOWLEDGE BASE (answer ONLY from this — the clinic's real doctors, services, prices, hours):\n${String(agent.knowledge_base).slice(0, 48000)}`,
    "VOICE OUTPUT RULES: plain spoken sentences only — no markdown, lists, emojis or URLs; one or two short sentences per turn; say numbers, prices, times and emails the way a person would.",
    agent.can_book ? "BOOKING: use get_available_slots first and offer real open times. Collect details ONE question at a time (name → email → phone), read back ONE summary, and only after the caller confirms call book_appointment. Never say it's booked unless the tool succeeded." : "You cannot book yourself — take their preferred time and say the team will confirm.",
    agent.can_reschedule ? "RESCHEDULE: confirm the new time, then call reschedule_appointment." : "",
    agent.can_cancel ? "CANCEL: confirm with the caller, then call cancel_appointment." : "",
    "EMAIL: when the caller asks for something by email, call send_email with the address they gave you.",
  ].filter(Boolean).join("\n\n");

  return {
    agentId: String(agent.id),
    agentName: String(agent.name),
    ws,
    instructions,
    greeting: agent.first_message || `Hi, this is ${agent.name} from the dental office. How can I help?`,
    greetFirst: (agent.first_message_mode ?? "assistant_first") !== "user_first",
    stt: lk.stt,
    sttLanguage: lk.sttLanguage || livekitSttLanguage(agent.language),
    llm: lk.llm || (/^(openai|google|xai|moonshotai)\//.test(agent.model ?? "") ? agent.model : LIVEKIT_DEFAULTS.llm),
    tts: lk.tts,
    voice: lk.voice,
    interruptions: lk.interruptions,
    canBook: !!agent.can_book,
    canReschedule: !!agent.can_reschedule,
    canCancel: !!agent.can_cancel,
    maxCallMinutes: Number(vs.maxCallDuration ?? 60) || 60,
    maxSilenceSec: Number(vs.maxSilenceDuration ?? 120) || 120,
    toolExecUrl: `${origin}/api/agents/tool-exec`,
    callLogUrl: `${origin}/api/livekit/call-log`,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// Shared secret the deployed worker presents to Pydent's LiveKit endpoints.
export function workerTokenOk(token: unknown): { ok: boolean; error?: string } {
  const expected = (process.env.LIVEKIT_WORKER_TOKEN || "").trim();
  if (!expected) return { ok: false, error: "LIVEKIT_WORKER_TOKEN is not set on the server — add it to the Pydent environment and to the worker's secrets." };
  if (String(token ?? "") !== expected) return { ok: false, error: "Unauthorized worker." };
  return { ok: true };
}

export function requestOrigin(req: { headers: Headers; nextUrl?: { origin: string } }): string {
  const site = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  if (site) return site;
  const fh = req.headers.get("x-forwarded-host");
  if (fh) return `https://${fh}`;
  return req.nextUrl?.origin || "https://pydent.ai";
}
