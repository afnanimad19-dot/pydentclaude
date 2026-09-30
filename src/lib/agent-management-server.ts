import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { sipClient, type LivekitCreds } from "@/lib/livekit";
import type { AgentMgmtDeps, AgentMgmtStore, AgentRow, LivekitRulesRead, NumberReference } from "@/lib/agent-management";

// Server bindings for lib/agent-management.ts: Supabase (service role; every
// agent read/write is scoped by workspace_id) and a READ-ONLY LiveKit reader.
//
// LiveKit surface used here: ListSIPDispatchRule ONLY. Nothing in this module
// can create, update or delete a trunk, a dispatch rule, a phone number or any
// other provider resource.

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A table that does not exist cannot reference the agent. Any other error fails closed (throws). */
function missingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "42P01" || error.code === "PGRST205" || /relation .* does not exist|could not find the table/i.test(error.message ?? "");
}

async function countWhere(table: string, build: (q: any) => any): Promise<number> {
  const { count, error } = await build(supabase.from(table).select("id", { count: "exact", head: true }));
  if (error) {
    if (missingTable(error)) return 0;
    throw new Error(`Could not verify ${table}: ${error.message}`);
  }
  return count ?? 0;
}

export const agentMgmtStore: AgentMgmtStore = {
  async getAgent(ws, id) {
    const { data, error } = await supabase.from("agents").select("*").eq("workspace_id", ws).eq("id", id).maybeSingle();
    if (error) {
      if (/invalid input syntax for type uuid/i.test(error.message)) return null;
      throw new Error(error.message);
    }
    return (data as AgentRow) ?? null;
  },
  async listAgentNames(ws) {
    const { data, error } = await supabase.from("agents").select("id, name, kind").eq("workspace_id", ws);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r: any) => ({ id: String(r.id), name: String(r.name ?? ""), kind: String(r.kind ?? "") }));
  },
  async renameAgent(ws, id, expectedName, name) {
    const { data, error } = await supabase
      .from("agents")
      .update({ name })
      .eq("workspace_id", ws)
      .eq("id", id)
      .eq("name", expectedName)
      .select("id");
    if (error) throw new Error(error.message);
    return Array.isArray(data) && data.length === 1;
  },
  async insertAgent(row) {
    const { data, error } = await supabase.from("agents").insert(row).select("id").single();
    if (error) return { error: error.message };
    return { id: String(data.id) };
  },
  async deleteAgent(ws, id) {
    const { data, error } = await supabase.from("agents").delete().eq("workspace_id", ws).eq("id", id).select("id");
    if (error) throw new Error(error.message);
    return Array.isArray(data) && data.length === 1;
  },
  async restoreAgent(row) {
    const { error } = await supabase.from("agents").insert(row);
    return !error;
  },
  async numberReferences(agentId) {
    // Across ALL workspaces: a reference anywhere blocks the delete.
    const out: NumberReference[] = [];
    for (const field of ["agent_id", "routing_agent_id"] as const) {
      const { data, error } = await supabase.from("voice_numbers").select("*").eq(field, agentId);
      if (error) {
        // routing_agent_id only exists once migration 0064 ran.
        if (field === "routing_agent_id" && /routing_agent_id/.test(error.message)) continue;
        throw new Error(`Could not verify phone-number assignments: ${error.message}`);
      }
      for (const r of data ?? []) {
        out.push({
          workspaceId: String(r.workspace_id ?? ""),
          number: String(r.number ?? ""),
          nickname: r.nickname ?? null,
          field,
          routingProvider: String(r.routing_provider ?? "none"),
        });
      }
    }
    return out;
  },
  async unfinishedAssignments(agentId) {
    const { count, error } = await supabase
      .from("voice_number_assignments")
      .select("id", { count: "exact", head: true })
      .in("status", ["pending", "reconcile_needed"])
      .or(`from_agent_id.eq.${agentId},to_agent_id.eq.${agentId}`);
    if (error) {
      if (missingTable(error)) return 0;
      throw new Error(`Could not verify number reassignments: ${error.message}`);
    }
    return count ?? 0;
  },
  async activeNumberLeases(ws, nowIso) {
    const { count, error } = await supabase
      .from("voice_numbers")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", ws)
      .gt("assignment_lock_until", nowIso);
    if (error) {
      if (/assignment_lock_until/.test(error.message)) return 0; // pre-0064: no leases exist
      throw new Error(`Could not verify routing leases: ${error.message}`);
    }
    return count ?? 0;
  },
  async configReferences(ws, agentId) {
    const out: Record<string, number> = {};
    for (const table of ["channel_defaults", "phone_lines", "campaigns", "pipeline_stage_agents"]) {
      out[table] = await countWhere(table, (q) => q.eq("agent_id", agentId));
    }
    // Workflow steps store the agent id inside their JSON nodes.
    const { data, error } = await supabase.from("workflows").select("id, nodes").eq("workspace_id", ws);
    if (error) {
      if (!missingTable(error)) throw new Error(`Could not verify workflows: ${error.message}`);
      out.workflows = 0;
    } else {
      out.workflows = (data ?? []).filter((w: any) => JSON.stringify(w.nodes ?? null).toLowerCase().includes(agentId.toLowerCase())).length;
    }
    return out;
  },
  async cascadeCounts(ws, agentId) {
    return {
      conversationAssignments: await countWhere("agent_assignments", (q) => q.eq("agent_id", agentId)),
      followUps: await countWhere("follow_ups", (q) => q.eq("agent_id", agentId)),
    };
  },
};

/**
 * Every LiveKit project this workspace can route calls through: its own
 * livekit_config (even when disabled — rules may still exist there) and the
 * server's env project. A config read error throws (fail closed).
 */
async function livekitProjects(ws: string): Promise<LivekitCreds[]> {
  const projects: LivekitCreds[] = [];
  const { data, error } = await supabase.from("livekit_config").select("*").eq("workspace_id", ws).maybeSingle();
  if (error && !missingTable(error)) throw new Error(`Could not read the LiveKit configuration: ${error.message}`);
  if (data?.url && data?.api_key && data?.api_secret) {
    projects.push({ url: String(data.url).trim(), apiKey: String(data.api_key).trim(), apiSecret: String(data.api_secret).trim(), agentName: String(data.agent_name || "pydent-agent").trim(), source: "workspace" });
  }
  const url = (process.env.LIVEKIT_URL || "").trim();
  const apiKey = (process.env.LIVEKIT_API_KEY || "").trim();
  const apiSecret = (process.env.LIVEKIT_API_SECRET || "").trim();
  if (url && apiKey && apiSecret && !projects.some((p) => p.url === url && p.apiKey === apiKey)) {
    projects.push({ url, apiKey, apiSecret, agentName: (process.env.LIVEKIT_AGENT_NAME || "pydent-agent").trim(), source: "env" });
  }
  return projects;
}

const PAGE = 100;
const MAX_PAGES = 50;

/** READ-ONLY: all dispatch rules of one project, as RAW provider JSON (nothing dropped by the SDK). */
async function listAllRulesRaw(creds: LivekitCreds): Promise<{ id: string; json: string }[]> {
  const sip = sipClient(creds) as any;
  const seen = new Map<string, string>();
  let afterId = "";
  for (let i = 0; i < MAX_PAGES; i++) {
    const data = await sip.rpc.request("SIP", "ListSIPDispatchRule", { page: { limit: PAGE, afterId } }, await sip.authHeader({}, { admin: true }));
    const items: any[] = Array.isArray(data?.items) ? data.items : [];
    let fresh = 0;
    for (const r of items) {
      if (!r) continue;
      const id = String(r.sipDispatchRuleId ?? r.sip_dispatch_rule_id ?? "");
      if (!id || seen.has(id)) continue;
      seen.set(id, JSON.stringify(r));
      fresh++;
      afterId = id > afterId ? id : afterId;
    }
    // Done when the page is short or the server ignored pagination (nothing new).
    if (items.length < PAGE || fresh === 0) return [...seen].map(([id, json]) => ({ id, json }));
  }
  throw new Error("Too many dispatch rules to verify.");
}

export async function readLivekitRules(ws: string): Promise<LivekitRulesRead> {
  let projects: LivekitCreds[];
  try {
    projects = await livekitProjects(ws);
  } catch (e) {
    return { ok: false, reason: "unavailable", error: e instanceof Error ? e.message.slice(0, 200) : "LiveKit configuration unreadable" };
  }
  if (!projects.length) return { ok: false, reason: "not_configured", error: "No LiveKit project configured." };
  const rules: { id: string; json: string }[] = [];
  for (const p of projects) {
    try {
      rules.push(...(await listAllRulesRaw(p)));
    } catch (e) {
      return { ok: false, reason: "unavailable", error: e instanceof Error ? e.message.slice(0, 200) : "LiveKit unreachable" };
    }
  }
  return { ok: true, projects: projects.length, rules };
}

export function makeAgentMgmtDeps(ws: string): AgentMgmtDeps {
  return {
    store: agentMgmtStore,
    livekitRules: () => readLivekitRules(ws),
    workerAgentName: async () => {
      const projects = await livekitProjects(ws).catch(() => []);
      return projects[0]?.agentName || "pydent-agent";
    },
    now: () => new Date(),
  };
}
