import { SIPDispatchRuleInfo } from "livekit-server-sdk";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { getLivekitCreds, lkConfigured, sipClient, listCloudAgents, workerTokenConfigured, builderMetadata } from "@/lib/livekit";
import type {
  AgentRow,
  AuditRow,
  LivekitRoutingAdapter,
  NumberRow,
  RoutingDeps,
  RoutingStore,
  RuleJson,
  VapiRoutingAdapter,
} from "@/lib/number-routing";

// Server bindings for lib/number-routing.ts: Supabase (service role, every
// query scoped by workspace_id), the workspace's LiveKit project, and Vapi.
//
// LiveKit surface used here — the ONLY write is updateSipDispatchRule
// (UpdateSIPDispatchRule, action = replace) on an existing rule id. Trunks are
// only ever LISTED; nothing in this module can create, update or delete a
// trunk, or create / delete a dispatch rule.

/* eslint-disable @typescript-eslint/no-explicit-any */

export class RoutingMigrationMissing extends Error {
  constructor() {
    super("Run migration 0064_voice_number_routing.sql before changing phone-number routing.");
  }
}

function toNumberRow(r: any): NumberRow {
  if (!r || !("assignment_version" in r) || !("routing_provider" in r)) throw new RoutingMigrationMissing();
  return {
    id: String(r.id),
    workspace_id: String(r.workspace_id),
    number: String(r.number ?? ""),
    nickname: r.nickname ?? null,
    provider: String(r.provider ?? ""),
    agent_id: r.agent_id ?? null,
    vapi_phone_number_id: r.vapi_phone_number_id ?? null,
    routing_provider: (r.routing_provider ?? "none") as NumberRow["routing_provider"],
    livekit_trunk_id: r.livekit_trunk_id ?? null,
    livekit_dispatch_rule_id: r.livekit_dispatch_rule_id ?? null,
    routing_agent_id: r.routing_agent_id ?? null,
    routing_status: (r.routing_status ?? "unverified") as NumberRow["routing_status"],
    routing_verified_at: r.routing_verified_at ?? null,
    routing_error: r.routing_error ?? null,
    routing_protected: !!r.routing_protected,
    assignment_version: Number(r.assignment_version ?? 0),
    assignment_lock_until: r.assignment_lock_until ?? null,
  };
}

const AUDIT = "voice_number_assignments";

export const routingStore: RoutingStore = {
  async getNumber(ws, id) {
    const { data, error } = await supabase.from("voice_numbers").select("*").eq("workspace_id", ws).eq("id", id).maybeSingle();
    if (error) {
      if (/invalid input syntax for type uuid/i.test(error.message)) return null;
      throw new Error(error.message);
    }
    return data ? toNumberRow(data) : null;
  },
  async getAgent(ws, id) {
    const { data, error } = await supabase.from("agents").select("*").eq("workspace_id", ws).eq("id", id).maybeSingle();
    if (error) return null; // malformed ids read as "not found"
    return (data as AgentRow) ?? null;
  },
  async listVoiceAgents(ws) {
    const { data } = await supabase.from("agents").select("*").eq("workspace_id", ws).eq("kind", "voice").order("created_at");
    return (data ?? []) as AgentRow[];
  },
  async updateNumberIfVersion(ws, id, expectedVersion, patch) {
    const { data, error } = await supabase
      .from("voice_numbers")
      .update(patch)
      .eq("workspace_id", ws)
      .eq("id", id)
      .eq("assignment_version", expectedVersion)
      .select("id");
    return !error && Array.isArray(data) && data.length === 1;
  },
  async findNumberByRule(ruleId) {
    const { data } = await supabase.from("voice_numbers").select("id, workspace_id").eq("livekit_dispatch_rule_id", ruleId).limit(1).maybeSingle();
    return data ? { id: String(data.id), workspace_id: String(data.workspace_id) } : null;
  },
  async findAuditByKey(ws, key) {
    const { data } = await supabase.from(AUDIT).select("*").eq("workspace_id", ws).eq("idempotency_key", key).maybeSingle();
    return (data as AuditRow) ?? null;
  },
  async getAudit(ws, id) {
    const { data, error } = await supabase.from(AUDIT).select("*").eq("workspace_id", ws).eq("id", id).maybeSingle();
    return error ? null : ((data as AuditRow) ?? null);
  },
  async listAudits(ws, numberId, limit) {
    const { data } = await supabase.from(AUDIT).select("*").eq("workspace_id", ws).eq("voice_number_id", numberId).order("created_at", { ascending: false }).limit(limit);
    return (data ?? []) as AuditRow[];
  },
  async insertAudit(row) {
    const { data, error } = await supabase.from(AUDIT).insert(row).select("id").single();
    if (error) return error.code === "23505" ? { conflict: true as const } : { error: error.message };
    return { id: String(data.id) };
  },
  async updateAudit(id, patch) {
    await supabase.from(AUDIT).update(patch).eq("id", id);
  },
};

/**
 * The workspace's LiveKit project — WORKSPACE credentials only. The global env
 * fallback is deliberately not used for routing changes (it may be another
 * project). Returns null when the workspace has no LiveKit configuration.
 */
export async function livekitRoutingAdapter(ws: string): Promise<LivekitRoutingAdapter | null> {
  const creds = await getLivekitCreds(ws);
  if (!lkConfigured(creds) || creds.source !== "workspace") return null;
  const sip = sipClient(creds);
  const json = (r: SIPDispatchRuleInfo) => r.toJson() as RuleJson;
  return {
    workerAgentName: creds.agentName,
    workerTokenConfigured: await workerTokenConfigured(ws),
    async getRule(ruleId) {
      const items = await sip.listSipDispatchRule({ dispatchRuleIds: [ruleId] });
      const hit = items.find((r) => r && r.sipDispatchRuleId === ruleId);
      return hit ? json(hit) : null;
    },
    async getRuleRaw(ruleId) {
      // Same transport + auth the SDK uses, but BEFORE fromJson(ignoreUnknownFields)
      // so fields this SDK version cannot represent are visible (read-only).
      const s = sip as any;
      const data = await s.rpc.request("SIP", "ListSIPDispatchRule", { dispatchRuleIds: [ruleId] }, await s.authHeader({}, { admin: true }));
      const items: any[] = Array.isArray(data?.items) ? data.items : [];
      return items.find((r) => r && (r.sipDispatchRuleId ?? r.sip_dispatch_rule_id) === ruleId) ?? null;
    },
    async listRulesForTrunk(trunkId) {
      // LiveKit returns every rule containing the trunk AND every wildcard rule.
      const items = await sip.listSipDispatchRule({ trunkIds: [trunkId] });
      return items.filter(Boolean).map(json);
    },
    async getInboundTrunk(trunkId) {
      const items = await sip.listSipInboundTrunk({ trunkIds: [trunkId] });
      const t = items.find((x) => x && x.sipTrunkId === trunkId);
      // Sanitized: auth username/password and allowed addresses never leave here.
      return t ? { id: t.sipTrunkId, name: t.name, numbers: [...(t.numbers ?? [])] } : null;
    },
    async listDeployedAgents() {
      return (await listCloudAgents(creds)).map((a) => ({ agentName: a.agentName, status: a.status }));
    },
    async replaceRule(ruleId, rule) {
      // In-place replace of the SAME rule id — never delete + create.
      await sip.updateSipDispatchRule(ruleId, SIPDispatchRuleInfo.fromJson(rule as any));
    },
  };
}

const VAPI_BASE = "https://api.vapi.ai";

export function vapiRoutingAdapter(): VapiRoutingAdapter | null {
  const key = (process.env.VAPI_API_KEY || "").trim();
  if (!key) return null;
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  return {
    async getAssistantId(id) {
      const res = await fetch(`${VAPI_BASE}/phone-number/${encodeURIComponent(id)}`, { headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message ?? `Vapi error ${res.status}`);
      return data?.assistantId ?? null;
    },
    async setAssistantId(id, assistantId) {
      const res = await fetch(`${VAPI_BASE}/phone-number/${encodeURIComponent(id)}`, { method: "PATCH", headers, body: JSON.stringify({ assistantId }) });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.message ?? `Vapi error ${res.status}`);
      }
    },
  };
}

export async function makeRoutingDeps(ws: string, origin: string): Promise<RoutingDeps> {
  return {
    store: routingStore,
    livekit: await livekitRoutingAdapter(ws),
    vapi: vapiRoutingAdapter(),
    now: () => new Date(),
    externalMetadata: (agent, workspaceId) => builderMetadata(agent, workspaceId, origin, { source: "phone" }),
  };
}
