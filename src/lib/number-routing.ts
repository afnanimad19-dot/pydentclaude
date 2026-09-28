// Provider-aware phone-number routing — pure transaction logic.
//
// A voice number has exactly ONE receiving agent. Changing it is a guarded
// transaction across two systems (Pydent's database + the provider that really
// routes calls), so the database only ever says "Tina" after the provider has
// been changed AND read back as Tina:
//
//   authorize (route) → validate → idempotency → compare-and-set on the
//   expected current agent → provider PREFLIGHT (read-only) → audit row with
//   the BEFORE snapshot → version-CAS lease → provider UPDATE → provider
//   READBACK → commit (only on a verified readback) → otherwise restore the
//   BEFORE snapshot, read it back, and mark `failed` (verified unchanged) or
//   `reconcile_needed` (provider state unknown).
//
// LiveKit: the linked dispatch rule is REPLACED IN PLACE (same rule id) with a
// copy of itself whose roomConfig.agents is the only thing changed. The inbound
// trunk is read for verification and NEVER written — the adapter interface has
// no trunk-mutation method at all. Rules are never deleted or recreated.
// Existing calls keep their agent: a dispatch rule is evaluated only when a new
// call arrives.
//
// Vapi: only numbers with an explicit stored Vapi phone-number id; the number's
// assistantId is patched, read back, and restored on failure. Never created,
// never looked up by digits.
//
// Every dependency (database, LiveKit, Vapi, clock) is injected, so the whole
// transaction is exercised in tests with synthetic fakes. Server bindings live
// in number-routing-server.ts.

/* eslint-disable @typescript-eslint/no-explicit-any */

export type RoutingProvider = "none" | "livekit" | "vapi";
export type RoutingStatus = "unverified" | "synced" | "pending" | "failed" | "reconcile_needed";
export type AuditStatus = "pending" | "applied" | "failed" | "rolled_back" | "reconcile_needed";
export type AuditAction = "reassign" | "rollback" | "link" | "reconcile";

export interface NumberRow {
  id: string;
  workspace_id: string;
  number: string;
  nickname?: string | null;
  provider: string;
  agent_id: string | null;
  vapi_phone_number_id: string | null;
  routing_provider: RoutingProvider;
  livekit_trunk_id: string | null;
  livekit_dispatch_rule_id: string | null;
  routing_agent_id: string | null;
  routing_status: RoutingStatus;
  routing_verified_at: string | null;
  routing_error: string | null;
  routing_protected: boolean;
  assignment_version: number;
  assignment_lock_until: string | null;
}

export interface AgentRow {
  id: string;
  workspace_id: string;
  name: string;
  kind: string;
  status: string;
  vapi_assistant_id?: string | null;
  voice_settings?: any;
  [k: string]: unknown;
}

/** SIPDispatchRuleInfo in protobuf JSON form (toJson / fromJson round-trips losslessly). */
export type RuleJson = Record<string, any>;
/** Sanitized inbound-trunk view — never carries auth credentials. */
export interface TrunkInfo { id: string; name: string; numbers: string[] }
export interface DeployedAgent { agentName: string; status: string }

export interface LivekitRoutingAdapter {
  /** Name the deployed Pydent worker registers with (livekit_config.agent_name). */
  workerAgentName: string;
  workerTokenConfigured: boolean;
  getRule(ruleId: string): Promise<RuleJson | null>;
  /**
   * The same rule as the RAW server JSON (before SDK parsing). The SDK drops
   * fields it does not know; since replaceRule is a FULL replace, any such
   * field would be silently erased — so a rule carrying one is refused.
   */
  getRuleRaw(ruleId: string): Promise<Record<string, any> | null>;
  /** Every rule that can match calls on this trunk: rules listing it AND wildcard rules. */
  listRulesForTrunk(trunkId: string): Promise<RuleJson[]>;
  getInboundTrunk(trunkId: string): Promise<TrunkInfo | null>;
  listDeployedAgents(): Promise<DeployedAgent[]>;
  /** UpdateSIPDispatchRule(action = replace) on the SAME rule id. The only LiveKit write. */
  replaceRule(ruleId: string, rule: RuleJson): Promise<void>;
}

export interface VapiRoutingAdapter {
  getAssistantId(phoneNumberId: string): Promise<string | null>;
  setAssistantId(phoneNumberId: string, assistantId: string | null): Promise<void>;
}

export interface AuditRow {
  id: string;
  workspace_id: string;
  voice_number_id: string;
  action: AuditAction;
  provider: RoutingProvider;
  from_agent_id: string | null;
  to_agent_id: string | null;
  actor_user_id: string | null;
  idempotency_key: string;
  status: AuditStatus;
  provider_before: any;
  provider_after: any;
  error: string | null;
  created_at?: string;
  completed_at?: string | null;
}

export type NumberPatch = Partial<Omit<NumberRow, "id" | "workspace_id" | "number" | "provider">>;

export interface RoutingStore {
  getNumber(workspaceId: string, numberId: string): Promise<NumberRow | null>;
  getAgent(workspaceId: string, agentId: string): Promise<AgentRow | null>;
  listVoiceAgents(workspaceId: string): Promise<AgentRow[]>;
  /** Atomic compare-and-set: applies `patch` only if assignment_version still equals `expectedVersion`. */
  updateNumberIfVersion(workspaceId: string, numberId: string, expectedVersion: number, patch: NumberPatch): Promise<boolean>;
  /** Any number row (ANY workspace) already linked to this dispatch rule. */
  findNumberByRule(ruleId: string): Promise<{ id: string; workspace_id: string } | null>;
  findAuditByKey(workspaceId: string, key: string): Promise<AuditRow | null>;
  getAudit(workspaceId: string, auditId: string): Promise<AuditRow | null>;
  listAudits(workspaceId: string, numberId: string, limit: number): Promise<AuditRow[]>;
  /** Insert; `conflict` when the (workspace, idempotency key) already exists. */
  insertAudit(row: Omit<AuditRow, "id">): Promise<{ id: string } | { conflict: true } | { error: string }>;
  updateAudit(auditId: string, patch: Partial<AuditRow>): Promise<void>;
}

export interface RoutingDeps {
  store: RoutingStore;
  livekit: LivekitRoutingAdapter | null;
  vapi: VapiRoutingAdapter | null;
  now: () => Date;
  /** Job metadata for a console-built (external) LiveKit agent — builderMetadata() in production. */
  externalMetadata: (agent: AgentRow, workspaceId: string) => string;
  lockMs?: number;
}

export interface RoutingOutcome {
  httpStatus: number;
  body: {
    ok: boolean;
    status: RoutingStatus | "noop" | "error";
    code?: string;
    message: string;
    numberId?: string;
    agentId?: string | null;
    assignmentId?: string;
    idempotent?: boolean;
    details?: Record<string, unknown>;
  };
}

const LOCK_MS_DEFAULT = 120_000;

// ── small pure helpers ────────────────────────────────────────────────────────

export function digitsOf(s: unknown): string {
  return String(s ?? "").replace(/\D/g, "");
}

/** Same phone number across E.164 / international / national (leading 0) spellings. */
export function sameNumber(a: unknown, b: unknown): boolean {
  const da = digitsOf(a).replace(/^0+/, "");
  const db = digitsOf(b).replace(/^0+/, "");
  if (!da || !db) return false;
  if (da === db) return true;
  const [short, long] = da.length <= db.length ? [da, db] : [db, da];
  return short.length >= 8 && long.endsWith(short);
}

function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}
export function stableJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}
export function sameRule(a: RuleJson | null | undefined, b: RuleJson | null | undefined): boolean {
  return !!a && !!b && stableJson(a) === stableJson(b);
}

export function ruleIdOf(rule: RuleJson | null | undefined): string {
  return String(rule?.sipDispatchRuleId ?? "");
}
export function ruleTrunkIds(rule: RuleJson | null | undefined): string[] {
  return Array.isArray(rule?.trunkIds) ? rule!.trunkIds.map(String) : [];
}
export function ruleAgents(rule: RuleJson | null | undefined): { agentName?: string; metadata?: string; deployment?: string; [k: string]: any }[] {
  const a = rule?.roomConfig?.agents;
  return Array.isArray(a) ? a : [];
}

function lockActive(n: NumberRow, now: Date): boolean {
  return !!n.assignment_lock_until && new Date(n.assignment_lock_until).getTime() > now.getTime();
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e ?? "unknown error")).slice(0, 300);
}

/** The LiveKit agent name a Pydent agent dispatches to (mirrors boundLivekitAgent in lib/livekit.ts). */
export function livekitTargetName(agent: AgentRow, workerAgentName: string): { name: string; external: boolean } {
  const bound = String(agent?.voice_settings?.livekit?.agentName ?? "").trim();
  if (bound && bound !== workerAgentName) return { name: bound, external: true };
  return { name: workerAgentName, external: false };
}

/**
 * The worker's job-metadata contract — identical to dispatchMetadata() in
 * lib/livekit.ts ({ pydentAgentId, ws, ...extra }), which the deployed worker
 * reads in livekit-agent/agent.py (meta["pydentAgentId"], meta["ws"]).
 */
export function workerDispatchMetadata(pydentAgentId: string, workspaceId: string): string {
  return JSON.stringify({ pydentAgentId, ws: workspaceId, source: "phone" });
}

/** The single roomConfig.agents entry that routes calls to `agent`. */
export function dispatchEntryFor(agent: AgentRow, workspaceId: string, workerAgentName: string, externalMetadata: RoutingDeps["externalMetadata"]) {
  const t = livekitTargetName(agent, workerAgentName);
  return t.external
    ? { agentName: t.name, metadata: externalMetadata(agent, workspaceId) }
    : { agentName: t.name, metadata: workerDispatchMetadata(agent.id, workspaceId) };
}

/** A copy of `before` whose ONLY difference is roomConfig.agents = [entry]. */
export function buildReplacementRule(before: RuleJson, entry: { agentName: string; metadata: string }): RuleJson {
  const after = JSON.parse(JSON.stringify(before));
  after.roomConfig = { ...(after.roomConfig ?? {}), agents: [{ agentName: entry.agentName, ...(entry.metadata ? { metadata: entry.metadata } : {}) }] };
  return after;
}

/** Defensive invariant: everything except roomConfig.agents is byte-identical. */
export function onlyAgentsDiffer(before: RuleJson, after: RuleJson): boolean {
  const strip = (r: RuleJson) => {
    const c = JSON.parse(JSON.stringify(r));
    if (c.roomConfig) {
      delete c.roomConfig.agents;
      if (Object.keys(c.roomConfig).length === 0) delete c.roomConfig;
    }
    return c;
  };
  return stableJson(strip(before)) === stableJson(strip(after));
}

// Map-valued fields: their keys are user data, not schema fields.
const MAP_KEYS = new Set(["attributes", "headers", "headersToAttributes", "attributesToHeaders"]);
const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
function isDefault(v: any): boolean {
  return v === null || v === undefined || v === "" || v === 0 || v === false || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
}
function fieldPaths(v: any, prefix: string, out: Set<string>) {
  if (Array.isArray(v)) { v.forEach((x) => fieldPaths(x, `${prefix}[]`, out)); return; }
  if (!v || typeof v !== "object") return;
  for (const [k0, val] of Object.entries(v)) {
    if (isDefault(val)) continue;
    const k = camel(k0);
    const p = prefix ? `${prefix}.${k}` : k;
    out.add(p);
    if (!MAP_KEYS.has(k)) fieldPaths(val, p, out);
  }
}
/** Non-default fields present in the server's raw JSON but lost by SDK parsing. */
export function unsupportedRuleFields(raw: Record<string, any> | null, parsed: RuleJson | null): string[] {
  if (!raw || !parsed) return [];
  const a = new Set<string>(); const b = new Set<string>();
  fieldPaths(raw, "", a); fieldPaths(parsed, "", b);
  return [...a].filter((p) => !b.has(p)).sort();
}

export interface RouteCheck { ok: boolean; code?: string; error?: string; overlapping?: string[] }

/** Read-only structural verification of a linked LiveKit route (trunk + rule). */
export function checkLivekitRoute(opts: { number: string; trunkId: string; ruleId: string; rule: RuleJson | null; rulesForTrunk: RuleJson[]; trunk: TrunkInfo | null }): RouteCheck {
  const { rule, trunk, trunkId, ruleId } = opts;
  if (!rule || ruleIdOf(rule) !== ruleId) return { ok: false, code: "rule_not_found", error: `Dispatch rule ${ruleId} was not found on the LiveKit project.` };
  const trunks = ruleTrunkIds(rule);
  if (trunks.length === 0) return { ok: false, code: "rule_wildcard", error: "The dispatch rule matches ALL trunks — refusing to manage a wildcard rule." };
  if (trunks.length !== 1 || trunks[0] !== trunkId) return { ok: false, code: "rule_trunk_mismatch", error: "The dispatch rule is not bound to exactly the linked inbound trunk." };
  if (rule.roomConfig?.egress) return { ok: false, code: "rule_has_egress", error: "The dispatch rule starts an egress (recording) — refusing to manage it." };
  if (ruleAgents(rule).length !== 1) return { ok: false, code: "rule_agents_unexpected", error: "The dispatch rule does not dispatch exactly one agent." };
  if (!trunk || trunk.id !== trunkId) return { ok: false, code: "trunk_not_found", error: `Inbound trunk ${trunkId} was not found on the LiveKit project.` };
  if (trunk.numbers.length > 0 && !trunk.numbers.some((n) => sameNumber(n, opts.number))) {
    return { ok: false, code: "trunk_number_mismatch", error: "The inbound trunk does not accept this phone number." };
  }
  const listed = opts.rulesForTrunk.map(ruleIdOf);
  if (!listed.includes(ruleId)) return { ok: false, code: "rule_listing_inconsistent", error: "LiveKit did not list the linked rule for its own trunk — refusing to continue." };
  const overlapping = listed.filter((id) => id !== ruleId);
  if (overlapping.length) {
    return { ok: false, code: "overlapping_rule", error: "Another dispatch rule (or a wildcard rule) also matches calls on this trunk.", overlapping };
  }
  return { ok: true };
}

export interface ResolvedProviderAgent { agentId: string | null; agentName: string; external: boolean; reason?: string }

/** Which Pydent agent a dispatch rule actually sends calls to. */
export function resolveRuleAgent(rule: RuleJson, agents: AgentRow[], workspaceId: string, workerAgentName: string): ResolvedProviderAgent {
  const entry = ruleAgents(rule)[0];
  const name = String(entry?.agentName ?? "");
  if (!name) return { agentId: null, agentName: "", external: false, reason: "no agent dispatched" };
  let meta: any = {};
  try { meta = entry?.metadata ? JSON.parse(String(entry.metadata)) : {}; } catch { meta = {}; }
  if (name === workerAgentName) {
    const id = String(meta?.pydentAgentId ?? "");
    const hit = agents.find((a) => a.id === id);
    if (!hit || String(meta?.ws ?? "") !== workspaceId) {
      return { agentId: null, agentName: name, external: false, reason: "worker dispatch without a valid pydentAgentId for this workspace" };
    }
    return { agentId: hit.id, agentName: name, external: false };
  }
  const bound = agents.filter((a) => livekitTargetName(a, workerAgentName).name === name);
  const byMeta = bound.find((a) => a.id === String(meta?.pydentAgentId ?? ""));
  if (byMeta) return { agentId: byMeta.id, agentName: name, external: true };
  if (bound.length === 1) return { agentId: bound[0].id, agentName: name, external: true };
  return { agentId: null, agentName: name, external: true, reason: bound.length ? "several Pydent agents are bound to this LiveKit agent" : "no Pydent agent is bound to this LiveKit agent" };
}

export interface Eligibility { agentId: string; name: string; eligible: boolean; reason?: string }

export function targetEligibility(agent: AgentRow, provider: RoutingProvider, ctx: { deployed?: DeployedAgent[]; workerAgentName?: string; workerTokenConfigured?: boolean }): Eligibility {
  const base = { agentId: agent.id, name: agent.name };
  if (agent.kind !== "voice") return { ...base, eligible: false, reason: "Not a voice agent." };
  if (agent.status !== "Live") return { ...base, eligible: false, reason: `Agent is ${agent.status || "not Live"}.` };
  if (provider === "livekit") {
    const t = livekitTargetName(agent, ctx.workerAgentName ?? "pydent-agent");
    const hit = (ctx.deployed ?? []).find((d) => d.agentName === t.name);
    if (!hit) return { ...base, eligible: false, reason: `LiveKit agent "${t.name}" is not deployed.` };
    if (!/^running$/i.test(hit.status)) return { ...base, eligible: false, reason: `LiveKit agent "${t.name}" is ${hit.status}, not Running.` };
    if (!t.external && !ctx.workerTokenConfigured) return { ...base, eligible: false, reason: "The Pydent worker token is not configured." };
  }
  if (provider === "vapi" && !agent.vapi_assistant_id) return { ...base, eligible: false, reason: "Agent is not synced to Vapi." };
  return { ...base, eligible: true };
}

// ── shared guards ─────────────────────────────────────────────────────────────

const KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

function fail(httpStatus: number, code: string, message: string, extra: Partial<RoutingOutcome["body"]> = {}): RoutingOutcome {
  return { httpStatus, body: { ok: false, status: "error", code, message, ...extra } };
}

function replay(a: AuditRow): RoutingOutcome {
  const base = { numberId: a.voice_number_id, assignmentId: a.id, idempotent: true };
  switch (a.status) {
    case "applied":
      return { httpStatus: 200, body: { ok: true, status: "synced", message: "Already applied (duplicate request).", agentId: a.to_agent_id, ...base } };
    case "rolled_back":
    case "failed":
      return { httpStatus: 409, body: { ok: false, status: "failed", code: "previous_attempt_failed", message: `This request already ran and failed: ${a.error ?? "provider update failed"}. Use a new request to retry.`, agentId: a.from_agent_id, ...base } };
    case "reconcile_needed":
      return { httpStatus: 409, body: { ok: false, status: "reconcile_needed", code: "reconcile_needed", message: "This request already ran; provider state must be reconciled.", ...base } };
    default:
      return { httpStatus: 409, body: { ok: false, status: "pending", code: "in_progress", message: "This request is still in progress.", ...base } };
  }
}

/** Common pre-checks on the number's lease / status. */
function gate(n: NumberRow, now: Date): RoutingOutcome | null {
  if (n.routing_status === "reconcile_needed") {
    return fail(409, "reconcile_needed", "Provider routing for this number must be reconciled before it can be changed.", { status: "reconcile_needed" });
  }
  if (lockActive(n, now)) return fail(409, "in_progress", "Another change to this number is in progress.", { status: "pending" });
  if (n.routing_status === "pending") {
    // A lease that expired while pending = a crashed attempt: the provider state is unknown.
    return fail(409, "reconcile_needed", "A previous change did not finish — reconcile this number first.", { status: "reconcile_needed" });
  }
  return null;
}

async function beginAudit(deps: RoutingDeps, row: Omit<AuditRow, "id">): Promise<{ id: string } | RoutingOutcome> {
  const ins = await deps.store.insertAudit(row);
  if ("id" in ins) return ins;
  if ("conflict" in ins) {
    const existing = await deps.store.findAuditByKey(row.workspace_id, row.idempotency_key);
    return existing ? replay(existing) : fail(409, "in_progress", "A request with this idempotency key is in progress.");
  }
  return fail(500, "audit_failed", `Could not record the change: ${ins.error}`);
}

// ── the provider change (shared by reassign + rollback) ──────────────────────

interface ChangeCtx {
  deps: RoutingDeps;
  number: NumberRow;
  auditId: string;
  version: number;
  toAgentId: string;
  before: any;
  after: any;
  fromName: string;
  toName: string;
}

async function executeChange(c: ChangeCtx): Promise<RoutingOutcome> {
  const { deps, number } = c;
  const now = () => deps.now();
  const ws = number.workspace_id;
  const lockMs = deps.lockMs ?? LOCK_MS_DEFAULT;

  // Lease: version-CAS so exactly one concurrent attempt proceeds.
  const leased = await deps.store.updateNumberIfVersion(ws, number.id, c.version, {
    routing_status: "pending",
    routing_error: null,
    assignment_lock_until: new Date(now().getTime() + lockMs).toISOString(),
    assignment_version: c.version + 1,
  });
  if (!leased) {
    await deps.store.updateAudit(c.auditId, { status: "failed", error: "concurrent change", completed_at: now().toISOString() });
    return fail(409, "concurrent_change", "Another change to this number happened at the same time — refresh and try again.");
  }
  const v1 = c.version + 1;

  const write = async (snap: any) => {
    if (number.routing_provider === "livekit") await deps.livekit!.replaceRule(number.livekit_dispatch_rule_id!, snap);
    else await deps.vapi!.setAssistantId(number.vapi_phone_number_id!, snap.assistantId);
  };
  const read = async (): Promise<any> => {
    if (number.routing_provider === "livekit") return deps.livekit!.getRule(number.livekit_dispatch_rule_id!);
    const id = await deps.vapi!.getAssistantId(number.vapi_phone_number_id!);
    return id ? { assistantId: id } : null;
  };
  const same = (a: any, b: any) => !!a && !!b && stableJson(a) === stableJson(b);

  let mutErr: string | null = null;
  try { await write(c.after); } catch (e) { mutErr = errText(e); }
  let got: any = undefined;
  try { got = await read(); } catch (e) { got = undefined; mutErr = mutErr ?? `readback failed: ${errText(e)}`; }

  if (same(got, c.after)) {
    // Even if the write call errored (e.g. a lost response), the readback proves it applied.
    const committed = await deps.store.updateNumberIfVersion(ws, number.id, v1, {
      agent_id: c.toAgentId,
      routing_agent_id: c.toAgentId,
      routing_status: "synced",
      routing_verified_at: now().toISOString(),
      routing_error: null,
      assignment_lock_until: null,
      assignment_version: v1 + 1,
    });
    if (committed) {
      await deps.store.updateAudit(c.auditId, { status: "applied", provider_after: got, completed_at: now().toISOString() });
      return {
        httpStatus: 200,
        body: {
          ok: true,
          status: "synced",
          message: `Verified: NEW calls to ${number.number} now go to ${c.toName}. Calls already in progress stay with their original agent.`,
          numberId: number.id,
          agentId: c.toAgentId,
          assignmentId: c.auditId,
        },
      };
    }
    mutErr = "database commit failed after the provider update";
  } else if (!mutErr) {
    mutErr = got === undefined || got === null ? "provider readback unavailable" : "provider readback did not match the requested routing";
  }

  // ── restore the BEFORE snapshot and prove it ──
  let restored = same(got, c.before);
  if (!restored) {
    try { await write(c.before); } catch { /* verified below */ }
    try { restored = same(await read(), c.before); } catch { restored = false; }
  }
  if (restored) {
    await deps.store.updateNumberIfVersion(ws, number.id, v1, {
      routing_status: "failed",
      routing_error: mutErr,
      routing_verified_at: now().toISOString(),
      assignment_lock_until: null,
      assignment_version: v1 + 1,
    });
    await deps.store.updateAudit(c.auditId, { status: "rolled_back", error: mutErr, completed_at: now().toISOString() });
    return {
      httpStatus: 502,
      body: {
        ok: false,
        status: "failed",
        code: "provider_update_failed",
        message: `Routing was NOT changed — calls still go to ${c.fromName}. (${mutErr})`,
        numberId: number.id,
        agentId: number.agent_id,
        assignmentId: c.auditId,
      },
    };
  }
  await deps.store.updateNumberIfVersion(ws, number.id, v1, {
    routing_status: "reconcile_needed",
    routing_error: `${mutErr}; the previous routing could not be verified after rollback`,
    assignment_lock_until: null,
    assignment_version: v1 + 1,
  });
  await deps.store.updateAudit(c.auditId, { status: "reconcile_needed", error: mutErr, completed_at: now().toISOString() });
  return {
    httpStatus: 502,
    body: {
      ok: false,
      status: "reconcile_needed",
      code: "reconcile_needed",
      message: `The provider update could not be verified and the previous routing could not be confirmed. Check the number's routing status and reconcile before making further changes. (${mutErr})`,
      numberId: number.id,
      assignmentId: c.auditId,
    },
  };
}

// ── provider snapshot reads ───────────────────────────────────────────────────

interface LivekitSnapshot { rule: RuleJson; actual: ResolvedProviderAgent; deployed: DeployedAgent[]; agents: AgentRow[] }

async function readLivekit(deps: RoutingDeps, n: NumberRow): Promise<LivekitSnapshot | RoutingOutcome> {
  const lk = deps.livekit;
  if (!lk) return fail(503, "livekit_not_configured", "LiveKit is not configured for this workspace (workspace credentials required).");
  if (!n.livekit_trunk_id || !n.livekit_dispatch_rule_id) return fail(409, "not_linked", "This number is not linked to a LiveKit trunk and dispatch rule.");
  let rule: RuleJson | null, raw: Record<string, any> | null, rulesForTrunk: RuleJson[], trunk: TrunkInfo | null, deployed: DeployedAgent[];
  try {
    [rule, raw, rulesForTrunk, trunk, deployed] = await Promise.all([
      lk.getRule(n.livekit_dispatch_rule_id),
      lk.getRuleRaw(n.livekit_dispatch_rule_id),
      lk.listRulesForTrunk(n.livekit_trunk_id),
      lk.getInboundTrunk(n.livekit_trunk_id),
      lk.listDeployedAgents(),
    ]);
  } catch (e) {
    return fail(502, "provider_unavailable", `Could not read LiveKit routing (nothing was changed): ${errText(e)}`);
  }
  const check = checkLivekitRoute({ number: n.number, trunkId: n.livekit_trunk_id, ruleId: n.livekit_dispatch_rule_id, rule, rulesForTrunk, trunk });
  if (!check.ok) return fail(409, check.code!, check.error!, { details: check.overlapping ? { overlapping: check.overlapping } : undefined });
  const unsupported = unsupportedRuleFields(raw, rule);
  if (unsupported.length) {
    return fail(409, "rule_has_unsupported_fields", "The dispatch rule has settings this server's LiveKit SDK cannot preserve — refusing to replace it (they would be erased).", { details: { fields: unsupported } });
  }
  const agents = await deps.store.listVoiceAgents(n.workspace_id);
  return { rule: rule!, actual: resolveRuleAgent(rule!, agents, n.workspace_id, lk.workerAgentName), deployed, agents };
}

// ── public operations ─────────────────────────────────────────────────────────

export interface ReassignRequest {
  workspaceId: string;
  actorUserId: string;
  numberId: string;
  targetAgentId: string | null;
  expectedCurrentAgentId: string | null;
  idempotencyKey: string;
  confirmNumber?: string;
}

export async function reassignNumber(deps: RoutingDeps, req: ReassignRequest): Promise<RoutingOutcome> {
  const ws = req.workspaceId;
  if (!req.numberId) return fail(400, "bad_request", "numberId is required.");
  if (!KEY_RE.test(String(req.idempotencyKey ?? ""))) return fail(400, "bad_request", "A valid idempotencyKey (8–128 chars) is required.");

  const prior = await deps.store.findAuditByKey(ws, req.idempotencyKey);
  if (prior) {
    if (prior.voice_number_id !== req.numberId || (prior.to_agent_id ?? null) !== (req.targetAgentId ?? null)) {
      return fail(422, "idempotency_key_reused", "This idempotency key was already used for a different change.");
    }
    return replay(prior);
  }

  const number = await deps.store.getNumber(ws, req.numberId);
  if (!number) return fail(404, "number_not_found", "Phone number not found.");
  if (number.routing_protected && !sameNumber(req.confirmNumber, number.number)) {
    return fail(400, "confirmation_required", `This is a protected production number — type ${number.number} to confirm.`);
  }
  if ((number.agent_id ?? null) !== (req.expectedCurrentAgentId ?? null)) {
    return fail(409, "stale_assignment", "The number's assignment changed since you loaded the page — refresh and try again.", { details: { currentAgentId: number.agent_id } });
  }
  const g = gate(number, deps.now());
  if (g) return g;

  let target: AgentRow | null = null;
  if (req.targetAgentId) {
    target = await deps.store.getAgent(ws, req.targetAgentId);
    if (!target) return fail(404, "agent_not_found", "Target agent not found in this workspace.");
  } else if (number.routing_provider !== "none") {
    return fail(409, "unassign_routed_forbidden", "A provider-routed number cannot be left without an agent — reassign it instead.");
  }

  const auditBase = {
    workspace_id: ws,
    voice_number_id: number.id,
    action: "reassign" as const,
    provider: number.routing_provider,
    from_agent_id: number.agent_id,
    to_agent_id: req.targetAgentId ?? null,
    actor_user_id: req.actorUserId,
    idempotency_key: req.idempotencyKey,
    status: "pending" as const,
    error: null,
  };

  // ── database-only numbers (no provider routing managed by Pydent) ──
  if (number.routing_provider === "none") {
    if (target) {
      const el = targetEligibility(target, "none", {});
      if (!el.eligible) return fail(422, "target_ineligible", el.reason!);
    }
    const a = await beginAudit(deps, { ...auditBase, provider_before: { agentId: number.agent_id }, provider_after: { agentId: target?.id ?? null } });
    if ("httpStatus" in a) return a;
    const ok = await deps.store.updateNumberIfVersion(ws, number.id, number.assignment_version, {
      agent_id: target?.id ?? null,
      assignment_version: number.assignment_version + 1,
    });
    if (!ok) {
      await deps.store.updateAudit(a.id, { status: "failed", error: "concurrent change", completed_at: deps.now().toISOString() });
      return fail(409, "concurrent_change", "Another change to this number happened at the same time — refresh and try again.");
    }
    await deps.store.updateAudit(a.id, { status: "applied", completed_at: deps.now().toISOString() });
    return {
      httpStatus: 200,
      body: {
        ok: true,
        status: "unverified",
        message: target
          ? `Saved in Pydent only — ${number.number} has no provider routing managed by Pydent, so this does not change which agent answers calls.`
          : "Number unassigned in Pydent.",
        numberId: number.id,
        agentId: target?.id ?? null,
        assignmentId: a.id,
      },
    };
  }

  // ── LiveKit ──
  if (number.routing_provider === "livekit") {
    const snap = await readLivekit(deps, number);
    if ("httpStatus" in snap) return snap;
    const { rule, actual, deployed, agents } = snap;
    if (!actual.agentId || actual.agentId !== number.routing_agent_id || number.routing_agent_id !== number.agent_id) {
      return fail(409, "drift", "LiveKit routing no longer matches Pydent's records — reconcile this number before reassigning.", {
        details: { providerAgentId: actual.agentId, providerAgentName: actual.agentName, databaseAgentId: number.agent_id, routingAgentId: number.routing_agent_id },
      });
    }
    if (target!.id === actual.agentId) {
      return { httpStatus: 200, body: { ok: true, status: "noop", message: `${target!.name} already receives ${number.number} (verified on LiveKit).`, numberId: number.id, agentId: target!.id } };
    }
    const el = targetEligibility(target!, "livekit", { deployed, workerAgentName: deps.livekit!.workerAgentName, workerTokenConfigured: deps.livekit!.workerTokenConfigured });
    if (!el.eligible) return fail(422, "target_ineligible", el.reason!);
    const after = buildReplacementRule(rule, dispatchEntryFor(target!, ws, deps.livekit!.workerAgentName, deps.externalMetadata));
    if (!onlyAgentsDiffer(rule, after) || ruleIdOf(after) !== number.livekit_dispatch_rule_id) {
      return fail(500, "invariant_violation", "Refusing: the replacement rule would change more than the dispatched agent.");
    }
    const a = await beginAudit(deps, { ...auditBase, provider_before: rule, provider_after: after });
    if ("httpStatus" in a) return a;
    const fromName = agents.find((x) => x.id === actual.agentId)?.name ?? "the current agent";
    return executeChange({ deps, number, auditId: a.id, version: number.assignment_version, toAgentId: target!.id, before: rule, after, fromName, toName: target!.name });
  }

  // ── Vapi ──
  if (!deps.vapi) return fail(503, "vapi_not_configured", "Vapi is not configured.");
  if (!number.vapi_phone_number_id) return fail(409, "vapi_number_not_registered", "This number has no stored Vapi phone-number id.");
  if (!target!.vapi_assistant_id) return fail(422, "target_ineligible", "Agent is not synced to Vapi.");
  let current: string | null;
  try { current = await deps.vapi.getAssistantId(number.vapi_phone_number_id); } catch (e) {
    return fail(502, "provider_unavailable", `Could not read Vapi routing (nothing was changed): ${errText(e)}`);
  }
  const agents = await deps.store.listVoiceAgents(ws);
  const actualAgent = agents.find((x) => !!current && x.vapi_assistant_id === current) ?? null;
  if (!actualAgent || actualAgent.id !== number.routing_agent_id || number.routing_agent_id !== number.agent_id) {
    // A number synced before migration 0064 has no routing_agent_id yet: adopt it only when Vapi and the DB agree.
    const adoptable = !number.routing_agent_id && !(current && !actualAgent) && (actualAgent?.id ?? null) === (number.agent_id ?? null);
    if (!adoptable) {
      return fail(409, "drift", "Vapi routing no longer matches Pydent's records — reconcile this number before reassigning.", {
        details: { providerAgentId: actualAgent?.id ?? null, databaseAgentId: number.agent_id },
      });
    }
  }
  if (actualAgent && target!.id === actualAgent.id) {
    return { httpStatus: 200, body: { ok: true, status: "noop", message: `${target!.name} already receives ${number.number} (verified on Vapi).`, numberId: number.id, agentId: target!.id } };
  }
  const before = { assistantId: current };
  const after = { assistantId: target!.vapi_assistant_id };
  const a = await beginAudit(deps, { ...auditBase, provider_before: before, provider_after: after });
  if ("httpStatus" in a) return a;
  return executeChange({ deps, number, auditId: a.id, version: number.assignment_version, toAgentId: target!.id, before, after, fromName: actualAgent?.name ?? "the current agent", toName: target!.name });
}

/** Restore the exact provider snapshot recorded before an applied change. */
export async function rollbackAssignment(
  deps: RoutingDeps,
  req: { workspaceId: string; actorUserId: string; numberId: string; assignmentId: string; idempotencyKey: string; confirmNumber?: string }
): Promise<RoutingOutcome> {
  const ws = req.workspaceId;
  if (!KEY_RE.test(String(req.idempotencyKey ?? ""))) return fail(400, "bad_request", "A valid idempotencyKey (8–128 chars) is required.");
  const prior = await deps.store.findAuditByKey(ws, req.idempotencyKey);
  if (prior) return prior.voice_number_id === req.numberId && prior.action === "rollback" ? replay(prior) : fail(422, "idempotency_key_reused", "This idempotency key was already used for a different change.");

  const number = await deps.store.getNumber(ws, req.numberId);
  if (!number) return fail(404, "number_not_found", "Phone number not found.");
  if (number.routing_protected && !sameNumber(req.confirmNumber, number.number)) {
    return fail(400, "confirmation_required", `This is a protected production number — type ${number.number} to confirm.`);
  }
  const g = gate(number, deps.now());
  if (g) return g;
  const target = await deps.store.getAudit(ws, req.assignmentId);
  if (!target || target.voice_number_id !== number.id) return fail(404, "assignment_not_found", "Assignment not found for this number.");
  const latest = (await deps.store.listAudits(ws, number.id, 20)).find((x) => x.status === "applied" && (x.action === "reassign" || x.action === "rollback"));
  if (!latest || latest.id !== target.id) return fail(409, "not_latest", "Only the most recent applied change can be rolled back.");
  if (target.provider !== number.routing_provider || number.routing_provider === "none") return fail(409, "not_rollbackable", "This change has no provider routing to restore.");
  if (number.agent_id !== target.to_agent_id || number.routing_agent_id !== target.to_agent_id) {
    return fail(409, "drift", "The number changed after this assignment — reconcile before rolling back.");
  }

  let current: any;
  let fromName = "the current agent";
  let toName = "the previous agent";
  const agents = await deps.store.listVoiceAgents(ws);
  if (number.routing_provider === "livekit") {
    const snap = await readLivekit(deps, number);
    if ("httpStatus" in snap) return snap;
    current = snap.rule;
  } else {
    if (!deps.vapi || !number.vapi_phone_number_id) return fail(503, "vapi_not_configured", "Vapi is not configured.");
    try { current = { assistantId: await deps.vapi.getAssistantId(number.vapi_phone_number_id) }; } catch (e) {
      return fail(502, "provider_unavailable", `Could not read Vapi routing (nothing was changed): ${errText(e)}`);
    }
  }
  if (stableJson(current) !== stableJson(target.provider_after)) {
    return fail(409, "provider_changed_since", "Provider routing changed after this assignment — refusing to overwrite it; reconcile first.");
  }
  fromName = agents.find((x) => x.id === target.to_agent_id)?.name ?? fromName;
  toName = agents.find((x) => x.id === target.from_agent_id)?.name ?? toName;
  if (!target.from_agent_id) return fail(409, "not_rollbackable", "The previous state had no agent.");

  const a = await beginAudit(deps, {
    workspace_id: ws,
    voice_number_id: number.id,
    action: "rollback",
    provider: number.routing_provider,
    from_agent_id: target.to_agent_id,
    to_agent_id: target.from_agent_id,
    actor_user_id: req.actorUserId,
    idempotency_key: req.idempotencyKey,
    status: "pending",
    provider_before: current,
    provider_after: target.provider_before,
    error: null,
  });
  if ("httpStatus" in a) return a;
  return executeChange({ deps, number, auditId: a.id, version: number.assignment_version, toAgentId: target.from_agent_id, before: current, after: target.provider_before, fromName, toName });
}

/** Register an EXISTING trunk + dispatch rule against a number — read-only on LiveKit. */
export async function linkLivekitRoute(
  deps: RoutingDeps,
  req: { workspaceId: string; actorUserId: string; numberId: string; trunkId: string; ruleId: string; idempotencyKey: string; protect?: boolean }
): Promise<RoutingOutcome> {
  const ws = req.workspaceId;
  if (!KEY_RE.test(String(req.idempotencyKey ?? ""))) return fail(400, "bad_request", "A valid idempotencyKey (8–128 chars) is required.");
  if (!/^ST_[A-Za-z0-9]+$/.test(String(req.trunkId ?? "")) || !/^SDR_[A-Za-z0-9]+$/.test(String(req.ruleId ?? ""))) {
    return fail(400, "bad_request", "trunkId (ST_…) and ruleId (SDR_…) are required.");
  }
  const prior = await deps.store.findAuditByKey(ws, req.idempotencyKey);
  if (prior) return prior.voice_number_id === req.numberId && prior.action === "link" ? replay(prior) : fail(422, "idempotency_key_reused", "This idempotency key was already used for a different change.");

  const number = await deps.store.getNumber(ws, req.numberId);
  if (!number) return fail(404, "number_not_found", "Phone number not found.");
  if (number.routing_provider !== "none") return fail(409, "already_linked", "This number already has provider routing.");
  const g = gate(number, deps.now());
  if (g) return g;
  const other = await deps.store.findNumberByRule(req.ruleId);
  if (other && other.id !== number.id) return fail(409, "rule_already_linked", "That dispatch rule is already linked to another number.");

  const probe: NumberRow = { ...number, routing_provider: "livekit", livekit_trunk_id: req.trunkId, livekit_dispatch_rule_id: req.ruleId };
  const snap = await readLivekit(deps, probe);
  if ("httpStatus" in snap) return snap;
  if (!snap.actual.agentId) {
    return fail(409, "provider_agent_unknown", `The rule dispatches "${snap.actual.agentName}", which does not map to exactly one Pydent agent (${snap.actual.reason}).`);
  }
  if (snap.actual.agentId !== number.agent_id) {
    return fail(409, "db_provider_mismatch", "LiveKit routes this number to a different agent than Pydent shows — fix the assignment first; nothing was linked.", {
      details: { providerAgentId: snap.actual.agentId, databaseAgentId: number.agent_id },
    });
  }

  const a = await beginAudit(deps, {
    workspace_id: ws,
    voice_number_id: number.id,
    action: "link",
    provider: "livekit",
    from_agent_id: number.agent_id,
    to_agent_id: number.agent_id,
    actor_user_id: req.actorUserId,
    idempotency_key: req.idempotencyKey,
    status: "pending",
    provider_before: snap.rule,
    provider_after: snap.rule,
    error: null,
  });
  if ("httpStatus" in a) return a;
  const ok = await deps.store.updateNumberIfVersion(ws, number.id, number.assignment_version, {
    routing_provider: "livekit",
    livekit_trunk_id: req.trunkId,
    livekit_dispatch_rule_id: req.ruleId,
    routing_agent_id: snap.actual.agentId,
    routing_status: "synced",
    routing_verified_at: deps.now().toISOString(),
    routing_error: null,
    routing_protected: req.protect !== false,
    assignment_version: number.assignment_version + 1,
  });
  if (!ok) {
    await deps.store.updateAudit(a.id, { status: "failed", error: "concurrent change", completed_at: deps.now().toISOString() });
    return fail(409, "concurrent_change", "The number changed while linking — refresh and try again.");
  }
  await deps.store.updateAudit(a.id, { status: "applied", completed_at: deps.now().toISOString() });
  return {
    httpStatus: 200,
    body: { ok: true, status: "synced", message: `Linked (no LiveKit changes made). ${number.number} is verified as routed to the current agent.`, numberId: number.id, agentId: number.agent_id, assignmentId: a.id },
  };
}

/** Adopt the provider's verified routing into Pydent's records — never writes to the provider. */
export async function reconcileNumber(
  deps: RoutingDeps,
  req: { workspaceId: string; actorUserId: string; numberId: string; idempotencyKey: string }
): Promise<RoutingOutcome> {
  const ws = req.workspaceId;
  if (!KEY_RE.test(String(req.idempotencyKey ?? ""))) return fail(400, "bad_request", "A valid idempotencyKey (8–128 chars) is required.");
  const prior = await deps.store.findAuditByKey(ws, req.idempotencyKey);
  if (prior) return prior.voice_number_id === req.numberId && prior.action === "reconcile" ? replay(prior) : fail(422, "idempotency_key_reused", "This idempotency key was already used for a different change.");
  const number = await deps.store.getNumber(ws, req.numberId);
  if (!number) return fail(404, "number_not_found", "Phone number not found.");
  if (number.routing_provider === "none") return fail(409, "not_routed", "This number has no provider routing to reconcile.");
  if (lockActive(number, deps.now())) return fail(409, "in_progress", "A change is in progress — wait for it to finish.");

  let actualId: string | null = null;
  let snapshot: any = null;
  if (number.routing_provider === "livekit") {
    const snap = await readLivekit(deps, number);
    if ("httpStatus" in snap) return snap;
    actualId = snap.actual.agentId;
    snapshot = snap.rule;
  } else {
    if (!deps.vapi || !number.vapi_phone_number_id) return fail(503, "vapi_not_configured", "Vapi is not configured.");
    let current: string | null;
    try { current = await deps.vapi.getAssistantId(number.vapi_phone_number_id); } catch (e) {
      return fail(502, "provider_unavailable", `Could not read Vapi routing: ${errText(e)}`);
    }
    actualId = (await deps.store.listVoiceAgents(ws)).find((x) => !!current && x.vapi_assistant_id === current)?.id ?? null;
    snapshot = { assistantId: current };
  }
  if (!actualId) return fail(409, "provider_agent_unknown", "The provider routes this number to an agent Pydent cannot identify — fix it in the provider console.");

  const a = await beginAudit(deps, {
    workspace_id: ws, voice_number_id: number.id, action: "reconcile", provider: number.routing_provider,
    from_agent_id: number.agent_id, to_agent_id: actualId, actor_user_id: req.actorUserId, idempotency_key: req.idempotencyKey,
    status: "pending", provider_before: snapshot, provider_after: snapshot, error: null,
  });
  if ("httpStatus" in a) return a;
  const ok = await deps.store.updateNumberIfVersion(ws, number.id, number.assignment_version, {
    agent_id: actualId,
    routing_agent_id: actualId,
    routing_status: "synced",
    routing_verified_at: deps.now().toISOString(),
    routing_error: null,
    assignment_lock_until: null,
    assignment_version: number.assignment_version + 1,
  });
  if (!ok) {
    await deps.store.updateAudit(a.id, { status: "failed", error: "concurrent change", completed_at: deps.now().toISOString() });
    return fail(409, "concurrent_change", "The number changed while reconciling — refresh and try again.");
  }
  await deps.store.updateAudit(a.id, { status: "applied", completed_at: deps.now().toISOString() });
  return { httpStatus: 200, body: { ok: true, status: "synced", message: "Reconciled: Pydent now shows the agent the provider actually routes to (no provider changes made).", numberId: number.id, agentId: actualId, assignmentId: a.id } };
}

/** Read-only routing status for the Voice Agent Settings page. */
export async function getRoutingStatus(deps: RoutingDeps, workspaceId: string, numberId: string) {
  const number = await deps.store.getNumber(workspaceId, numberId);
  if (!number) return { httpStatus: 404, body: { ok: false, error: "Phone number not found." } };
  const agents = await deps.store.listVoiceAgents(workspaceId);
  const nameOf = (id: string | null) => (id ? agents.find((a) => a.id === id)?.name ?? null : null);

  let providerAgent: { agentId: string | null; name: string | null; livekitAgentName?: string; reason?: string } | null = null;
  let providerError: string | null = null;
  let deployed: DeployedAgent[] = [];
  let route: Record<string, unknown> | null = null;
  let currentProviderSnapshot: any = null;

  if (number.routing_provider === "livekit") {
    const snap = await readLivekit(deps, number);
    if ("httpStatus" in snap) {
      providerError = snap.body.message;
      try { deployed = deps.livekit ? await deps.livekit.listDeployedAgents() : []; } catch { deployed = []; }
    } else {
      deployed = snap.deployed;
      currentProviderSnapshot = snap.rule;
      providerAgent = { agentId: snap.actual.agentId, name: nameOf(snap.actual.agentId), livekitAgentName: snap.actual.agentName, reason: snap.actual.reason };
      route = { trunkId: number.livekit_trunk_id, ruleId: number.livekit_dispatch_rule_id, ruleName: String(snap.rule.name ?? "") };
    }
  } else if (number.routing_provider === "vapi" && number.vapi_phone_number_id) {
    if (!deps.vapi) providerError = "Vapi is not configured.";
    else {
      try {
        const current = await deps.vapi.getAssistantId(number.vapi_phone_number_id);
        currentProviderSnapshot = { assistantId: current };
        const hit = agents.find((a) => !!current && a.vapi_assistant_id === current) ?? null;
        providerAgent = { agentId: hit?.id ?? null, name: hit?.name ?? null, reason: hit ? undefined : "assistant not mapped to a Pydent agent" };
      } catch (e) {
        providerError = `Could not read Vapi routing: ${errText(e)}`;
      }
    }
  }

  const drift =
    number.routing_provider !== "none" &&
    !!providerAgent &&
    (providerAgent.agentId !== number.routing_agent_id || number.routing_agent_id !== number.agent_id);

  const audits = await deps.store.listAudits(workspaceId, number.id, 5);
  const lastApplied = audits.find((x) => x.status === "applied" && (x.action === "reassign" || x.action === "rollback"));
  const rollbackCandidate =
    lastApplied &&
    number.routing_provider !== "none" &&
    lastApplied.from_agent_id &&
    !drift &&
    currentProviderSnapshot &&
    stableJson(currentProviderSnapshot) === stableJson(lastApplied.provider_after)
      ? { assignmentId: lastApplied.id, restoresAgentId: lastApplied.from_agent_id, restoresAgentName: nameOf(lastApplied.from_agent_id) }
      : null;

  const ctx = { deployed, workerAgentName: deps.livekit?.workerAgentName, workerTokenConfigured: deps.livekit?.workerTokenConfigured };
  const eligibleTargets = agents.map((a) => targetEligibility(a, number.routing_provider, ctx));

  return {
    httpStatus: 200,
    body: {
      ok: true,
      numberId: number.id,
      number: number.number,
      provider: number.routing_provider,
      protected: number.routing_protected,
      status: number.routing_status,
      database: { agentId: number.agent_id, name: nameOf(number.agent_id) },
      routing: { agentId: number.routing_agent_id, name: nameOf(number.routing_agent_id) },
      providerAgent,
      providerError,
      drift,
      verifiedAt: number.routing_verified_at,
      error: number.routing_error,
      route,
      assignmentVersion: number.assignment_version,
      eligibleTargets,
      rollbackCandidate,
      recent: audits.map((x) => ({ id: x.id, action: x.action, status: x.status, fromAgentId: x.from_agent_id, toAgentId: x.to_agent_id, error: x.error, createdAt: x.created_at ?? null })),
    },
  };
}
