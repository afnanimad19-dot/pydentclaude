// Agent management — Rename, Duplicate and Delete for Pydent agents. Pure logic
// with injected lookups (bound to Supabase + a READ-ONLY LiveKit reader in
// agent-management-server.ts), so every decision is unit-testable.
//
// Identities that are deliberately NOT touched here (see the Phase 1 audit):
//   • agents.id                         — what dispatch metadata, voice_numbers
//                                         and Builder tool URLs reference.
//   • voice_settings.livekit.agentName  — the LiveKit console agent that
//                                         answers for this Pydent agent.
//   • LiveKit worker name, dispatch rules, trunks, phone-number routing,
//     vapi_assistant_id, xai_agent_id.
// Nothing in this module can write to a provider: the only provider access is
// the read-only `livekitRules` dependency used to verify a delete.

/* eslint-disable @typescript-eslint/no-explicit-any */

export type AgentRow = Record<string, any> & {
  id: string;
  workspace_id: string | null;
  name: string;
  kind: string;
};

export type MgmtOutcome = { httpStatus: number; body: Record<string, unknown> };

/** Roles allowed to rename, duplicate and delete agents (enforced server-side). */
export const AGENT_MANAGER_ROLES: readonly string[] = ["owner", "manager"];
export const MAX_AGENT_NAME_LENGTH = 80;
/**
 * Names ensureNovaAgents() (lib/db.ts) claims: it takes the FIRST agent whose
 * name matches this and overwrites its name, role, identity and instructions.
 * Until that seeding is fixed, no rename or duplicate may produce such a name,
 * and the seeded Nova itself cannot be renamed.
 */
export const RESERVED_AGENT_NAME = /phoenix|nova/i;

export const LIVEKIT_UNVERIFIABLE_MESSAGE =
  "Deletion could not be safely verified because LiveKit routing is currently unavailable. No changes were made.";

export interface NumberReference {
  workspaceId: string;
  number: string;
  nickname: string | null;
  field: "agent_id" | "routing_agent_id";
  routingProvider: string;
}

export interface AgentMgmtStore {
  /** One agent in this workspace, or null. */
  getAgent(ws: string, id: string): Promise<AgentRow | null>;
  /** Every agent's id / name / kind in this workspace (for name uniqueness). */
  listAgentNames(ws: string): Promise<{ id: string; name: string; kind: string }[]>;
  /** Update ONLY agents.name, and only while it still equals expectedName. False = changed concurrently. */
  renameAgent(ws: string, id: string, expectedName: string, name: string): Promise<boolean>;
  /** Insert a new agent row; returns the NEW id. */
  insertAgent(row: Record<string, unknown>): Promise<{ id: string } | { error: string }>;
  /** Delete the agents row (workspace-scoped). True when exactly that row was removed. */
  deleteAgent(ws: string, id: string): Promise<boolean>;
  /** Re-insert a deleted agent row exactly as snapshotted (same id). */
  restoreAgent(row: AgentRow): Promise<boolean>;
  /** Phone numbers in ANY workspace whose agent_id or routing_agent_id is this agent. */
  numberReferences(agentId: string): Promise<NumberReference[]>;
  /** Number-assignment audit rows naming this agent that have not finished (pending / reconcile_needed). */
  unfinishedAssignments(agentId: string): Promise<number>;
  /** Numbers in this workspace holding an active reassignment lease right now. */
  activeNumberLeases(ws: string, nowIso: string): Promise<number>;
  /** Other configuration that uses this agent (channel defaults, campaigns, workflows, …) — counts per kind. */
  configReferences(ws: string, agentId: string): Promise<Record<string, number>>;
  /** Rows the database will CASCADE-delete with the agent. */
  cascadeCounts(ws: string, agentId: string): Promise<{ conversationAssignments: number; followUps: number }>;
}

export type LivekitRulesRead =
  | { ok: true; projects: number; rules: { id: string; json: string }[] }
  | { ok: false; reason: "not_configured" | "unavailable"; error: string };

export interface AgentMgmtDeps {
  store: AgentMgmtStore;
  /** READ-ONLY: every dispatch rule on every LiveKit project this workspace may use. */
  livekitRules: () => Promise<LivekitRulesRead>;
  /** The workspace's Pydent worker agent name (e.g. "pydent-agent"). */
  workerAgentName: () => Promise<string>;
  now: () => Date;
}

const ok = (body: Record<string, unknown>, httpStatus = 200): MgmtOutcome => ({ httpStatus, body: { ok: true, ...body } });
const fail = (httpStatus: number, code: string, message: string, extra: Record<string, unknown> = {}): MgmtOutcome => ({
  httpStatus,
  body: { ok: false, code, error: message, ...extra },
});

// ------------------------------------------------------------------ names

export type NameCheck = { ok: true; name: string } | { ok: false; code: string; message: string };

/** Trim, collapse inner whitespace, and enforce non-empty / max length / printable. */
export function normalizeAgentName(raw: unknown): NameCheck {
  if (typeof raw !== "string") return { ok: false, code: "name_required", message: "Enter a name for the agent." };
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, code: "name_invalid", message: "The name contains invalid characters." };
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) return { ok: false, code: "name_required", message: "Enter a name for the agent." };
  if (name.length > MAX_AGENT_NAME_LENGTH) {
    return { ok: false, code: "name_too_long", message: `Keep the name to ${MAX_AGENT_NAME_LENGTH} characters or fewer.` };
  }
  return { ok: true, name };
}

export const NOVA_SYSTEM_MANAGED_MESSAGE = "Nova is a system-managed agent and cannot be renamed.";

/**
 * The seeded Nova (or its legacy "Phoenix" name): the agent ensureNovaAgents()
 * owns. It cannot be renamed at all — renaming it away would make the seeding
 * create a fresh Nova on the next Campaigns visit.
 */
export function isSystemManagedNova(agent: { name: string }): boolean {
  return RESERVED_AGENT_NAME.test(String(agent.name ?? ""));
}

/** Reserved Nova/Phoenix names: no rename or duplicate may produce one. */
export function reservedNameProblem(name: string): string | null {
  if (!RESERVED_AGENT_NAME.test(name)) return null;
  return 'Names containing "Nova" or "Phoenix" are reserved for the built-in Nova agent. Choose a different name.';
}

/** Case-insensitive uniqueness among agents of the same kind in the workspace. */
export function nameTaken(list: { id: string; name: string; kind: string }[], kind: string, name: string, excludeId?: string): boolean {
  const want = name.toLowerCase();
  return list.some((a) => a.id !== excludeId && a.kind === kind && String(a.name ?? "").replace(/\s+/g, " ").trim().toLowerCase() === want);
}

// ------------------------------------------------------------------ rename

export async function renameAgent(deps: AgentMgmtDeps, input: { workspaceId: string; agentId: string; name: unknown }): Promise<MgmtOutcome> {
  const agent = await deps.store.getAgent(input.workspaceId, input.agentId);
  if (!agent) return fail(404, "agent_not_found", "Agent not found in this workspace.");
  const n = normalizeAgentName(input.name);
  if (!n.ok) return fail(400, n.code, n.message);
  if (n.name === agent.name) return ok({ agentId: agent.id, name: agent.name, unchanged: true, message: "Name unchanged." });
  if (isSystemManagedNova(agent)) return fail(403, "system_managed_agent", NOVA_SYSTEM_MANAGED_MESSAGE);
  const reserved = reservedNameProblem(n.name);
  if (reserved) return fail(400, "name_reserved", reserved);
  const list = await deps.store.listAgentNames(input.workspaceId);
  if (nameTaken(list, agent.kind, n.name, agent.id)) {
    return fail(409, "name_taken", `Another ${agent.kind} agent is already called "${n.name}".`);
  }
  // agents.name ONLY — never the id, voice_settings (LiveKit binding), provider
  // ids or any routing. CAS on the old name so a concurrent rename isn't clobbered.
  const done = await deps.store.renameAgent(input.workspaceId, agent.id, agent.name, n.name);
  if (!done) return fail(409, "agent_changed", "This agent was changed by someone else. Reload and try again.");
  return ok({
    agentId: agent.id,
    name: n.name,
    previousName: agent.name,
    message: "Agent renamed. The agent may introduce itself using this new name on its next call.",
  });
}

// ------------------------------------------------------------------ duplicate

export interface DuplicateSections {
  instructions: boolean;
  voice: boolean;
  tools: boolean;
  knowledge: boolean;
  callEnding: boolean;
}

export const ALL_SECTIONS: DuplicateSections = { instructions: true, voice: true, tools: true, knowledge: true, callEnding: true };

const COLUMNS_BY_SECTION: Record<keyof DuplicateSections, string[]> = {
  instructions: ["agent_identity", "instructions", "behavior", "first_message", "first_message_mode"],
  voice: ["model", "voice", "voice_id", "language"],
  tools: ["can_book", "can_reschedule", "can_cancel"],
  knowledge: ["knowledge_base", "kb_files"],
  callEnding: [],
};
/** Agent-level configuration that is always safe to copy. */
const ALWAYS_COLUMNS = ["role", "purpose", "channels"];

const VS_BY_SECTION: Record<keyof DuplicateSections, string[]> = {
  instructions: [],
  voice: [
    "livekit", "interruptions", "backgroundAudio",
    "minSpeechDuration", "minSilenceDuration", "activationThreshold", "prefixPaddingDuration", "endOfSpeechTimeout",
    "turnDetectionEnabled", "detectionMode", "transcriber", "detectionTimeout",
    "noiseReductionEnabled", "reductionLevel",
    "amdEnabled", "multilingualAmd", "amdTimeout",
    "silenceBeforeCheck", "maxCheckAttempts", "maxSilenceDuration", "maxCallDuration",
  ],
  tools: ["tools", "importedTools"],
  knowledge: [],
  callEnding: ["callEnding", "endCall"],
};
/** Privacy, recording consent, transfer and extraction configuration. */
const ALWAYS_VS = ["dataStorage", "recordCalls", "transferNumber", "transferMessage", "extractionFields", "configVersion"];

/** Columns that are NEVER copied (documented for the report and tests). */
export const NEVER_COPIED_COLUMNS = ["id", "created_at", "status", "workspace_id", "vapi_assistant_id", "xai_agent_id"];

function deepCopy<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function mentions(value: unknown, id: string): boolean {
  if (!id) return false;
  try {
    return JSON.stringify(value ?? null).toLowerCase().includes(id.toLowerCase());
  } catch {
    return true; // unserializable → treat as unsafe
  }
}

/**
 * Build the new agents row for a duplicate. Allow-list only: a column or
 * voice_settings key is copied only when it is listed above for a selected
 * section; everything else (ids, timestamps, status, provider ids, the
 * LiveKit console binding, builderImport provenance, unknown keys) is left out
 * and falls back to its default. Configuration that references the SOURCE
 * agent's id (e.g. a Builder HTTP tool URL /api/builder-tools/<id>/…) is
 * dropped so the duplicate never acts on the source's behalf.
 */
export function buildDuplicateRow(
  source: AgentRow,
  opts: { workspaceId: string; name: string; sections: DuplicateSections }
): { row: Record<string, unknown>; excluded: string[] } {
  const excluded: string[] = [];
  const row: Record<string, unknown> = { workspace_id: opts.workspaceId, name: opts.name, kind: source.kind, status: "Draft" };
  const take = (col: string) => {
    if (col in source && source[col] !== undefined) row[col] = deepCopy(source[col]);
  };
  ALWAYS_COLUMNS.forEach(take);
  for (const s of Object.keys(COLUMNS_BY_SECTION) as (keyof DuplicateSections)[]) {
    if (opts.sections[s]) COLUMNS_BY_SECTION[s].forEach(take);
  }

  if (source.kind !== "voice") {
    row.voice_settings = {};
    return { row, excluded };
  }

  const src = (source.voice_settings && typeof source.voice_settings === "object" ? source.voice_settings : {}) as Record<string, any>;
  const vs: Record<string, any> = {};
  const allowed = new Set(ALWAYS_VS);
  for (const s of Object.keys(VS_BY_SECTION) as (keyof DuplicateSections)[]) {
    if (opts.sections[s]) VS_BY_SECTION[s].forEach((k) => allowed.add(k));
  }
  for (const k of Object.keys(src)) {
    if (!allowed.has(k)) {
      if (k === "builderImport") excluded.push("builderImport (LiveKit import provenance / identity)");
      continue;
    }
    if (src[k] === undefined) continue;
    let v = deepCopy(src[k]);
    if (k === "livekit" && v && typeof v === "object") {
      // Drop the console binding: the duplicate runs on the Pydent worker.
      if (String(v.agentName ?? "").trim()) excluded.push(`livekit.agentName (console binding "${String(v.agentName).slice(0, 60)}")`);
      v = { ...v, agentName: "" };
    }
    if (k === "importedTools" && Array.isArray(v)) {
      const kept = v.filter((t: unknown) => !mentions(t, source.id));
      if (kept.length !== v.length) excluded.push(`${v.length - kept.length} imported tool(s) that call the source agent's id`);
      v = kept;
    } else if (mentions(v, source.id)) {
      excluded.push(`${k} (references the source agent's id)`);
      continue;
    }
    vs[k] = v;
  }
  row.voice_settings = vs;
  return { row, excluded };
}

export function parseSections(raw: unknown): DuplicateSections {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = (k: keyof DuplicateSections) => (k in r ? r[k] === true : true);
  return { instructions: pick("instructions"), voice: pick("voice"), tools: pick("tools"), knowledge: pick("knowledge"), callEnding: pick("callEnding") };
}

/** The default name offered in the Duplicate dialog — empty when it would be reserved or too long. */
export function defaultDuplicateName(sourceName: string): string {
  const n = normalizeAgentName(`${sourceName} Copy`);
  if (!n.ok || RESERVED_AGENT_NAME.test(n.name)) return "";
  return n.name;
}

export async function duplicateAgent(
  deps: AgentMgmtDeps,
  input: { workspaceId: string; agentId: string; name: unknown; sections?: unknown }
): Promise<MgmtOutcome> {
  const source = await deps.store.getAgent(input.workspaceId, input.agentId);
  if (!source) return fail(404, "agent_not_found", "Agent not found in this workspace.");
  const n = normalizeAgentName(input.name);
  if (!n.ok) return fail(400, n.code, n.message);
  // A duplicate can never take a reserved name — not even "Nova".
  const reserved = reservedNameProblem(n.name);
  if (reserved) return fail(400, "name_reserved", reserved);
  const list = await deps.store.listAgentNames(input.workspaceId);
  if (nameTaken(list, source.kind, n.name)) return fail(409, "name_taken", `Another ${source.kind} agent is already called "${n.name}".`);

  const sections = parseSections(input.sections);
  const { row, excluded } = buildDuplicateRow(source, { workspaceId: input.workspaceId, name: n.name, sections });
  // Belt and braces: the new row may never carry the source's identity.
  const lkBinding = String((row.voice_settings as any)?.livekit?.agentName ?? "");
  if (NEVER_COPIED_COLUMNS.some((c) => c !== "workspace_id" && c !== "status" && c in row) || row.status !== "Draft" || lkBinding || "builderImport" in ((row.voice_settings as any) ?? {})) {
    return fail(500, "duplicate_invalid", "Refusing to create a duplicate that carries the source agent's identity.");
  }
  const res = await deps.store.insertAgent(row);
  if ("error" in res) return fail(500, "insert_failed", `Could not create the duplicate: ${res.error.slice(0, 200)}`);
  if (res.id === source.id) return fail(500, "duplicate_invalid", "The duplicate did not receive a new id.");
  return ok(
    {
      agentId: res.id,
      sourceAgentId: source.id,
      name: n.name,
      status: "Draft",
      sections,
      excluded,
      message: `Created "${n.name}" as a Draft. Phone routing and provider routing are never copied.`,
    },
    201
  );
}

// ------------------------------------------------------------------ delete

export interface DeletionBlocker {
  code: string;
  message: string;
}

export interface DeletionInspection {
  agent: { id: string; name: string; kind: string };
  blockers: DeletionBlocker[];
  requiresTypedConfirmation: boolean;
  typedConfirmationReasons: string[];
  cascade: { conversationAssignments: number; followUps: number };
}

const CONFIG_LABELS: Record<string, string> = {
  channel_defaults: "a messaging-channel default (Agent Hub)",
  phone_lines: "a phone line",
  campaigns: "a calling campaign",
  pipeline_stage_agents: "a pipeline stage",
  workflows: "a workflow",
};

/** Console-bound (dispatches a LiveKit console agent) or imported from LiveKit Builder. */
export function externalBindingReasons(agent: AgentRow, workerAgentName: string): string[] {
  const vs = (agent.voice_settings && typeof agent.voice_settings === "object" ? agent.voice_settings : {}) as Record<string, any>;
  const out: string[] = [];
  const bound = String(vs.livekit?.agentName ?? "").trim();
  if (bound && bound !== workerAgentName) out.push(`bound to the LiveKit console agent "${bound.slice(0, 60)}"`);
  if (vs.builderImport && typeof vs.builderImport === "object") out.push("imported from LiveKit Builder");
  if (Array.isArray(vs.importedTools) && vs.importedTools.length > 0) out.push("has tools imported from LiveKit Builder (they may call this agent's id)");
  return out;
}

function numberLabel(ref: NumberReference, ws: string): string {
  if (ref.workspaceId !== ws) return "a phone number in another workspace";
  const nick = ref.nickname ? ` (${String(ref.nickname).slice(0, 40)})` : "";
  return `${ref.number}${nick}`;
}

/** Every server-side safety check for deleting an agent. Read-only. */
export async function inspectDeletion(deps: AgentMgmtDeps, input: { workspaceId: string; agentId: string }): Promise<DeletionInspection | null> {
  const ws = input.workspaceId;
  const agent = await deps.store.getAgent(ws, input.agentId);
  if (!agent) return null;
  const blockers: DeletionBlocker[] = [];

  // 1 + 2. Phone numbers (voice_numbers.agent_id / routing_agent_id), ANY workspace.
  const refs = await deps.store.numberReferences(agent.id);
  if (refs.length) {
    const labels = [...new Set(refs.map((r) => numberLabel(r, ws)))];
    blockers.push({
      code: "assigned_to_number",
      message: `Cannot delete this agent because it is currently assigned to a phone number (${labels.join(", ")}). Reassign or unlink the number first.`,
    });
  }
  // 3. Reassignments in progress / unfinished.
  const unfinished = await deps.store.unfinishedAssignments(agent.id);
  if (unfinished > 0) {
    blockers.push({ code: "assignment_in_progress", message: "A phone-number reassignment involving this agent has not finished (pending or needs reconciling). Resolve it first." });
  }
  const leases = await deps.store.activeNumberLeases(ws, deps.now().toISOString());
  if (leases > 0) {
    blockers.push({ code: "routing_change_in_progress", message: "A phone-number routing change is in progress in this workspace. Try again in a minute." });
  }
  // 4. LiveKit dispatch rules whose metadata (or anything else) names this agent — READ-ONLY, fail closed.
  const lk = await deps.livekitRules();
  if (!lk.ok) {
    blockers.push({
      code: "livekit_unverifiable",
      message:
        lk.reason === "not_configured"
          ? "Deletion could not be safely verified because no LiveKit project is configured to check routing against. No changes were made."
          : LIVEKIT_UNVERIFIABLE_MESSAGE,
    });
  } else {
    const hits = lk.rules.filter((r) => r.json.toLowerCase().includes(agent.id.toLowerCase()));
    if (hits.length) {
      blockers.push({
        code: "referenced_by_dispatch_rule",
        message: `Cannot delete this agent because a LiveKit dispatch rule routes calls to it (${hits.map((h) => h.id).slice(0, 5).join(", ")}). Reassign or unlink the number first.`,
      });
    }
  }
  // Other active configuration that would silently lose its agent.
  const cfg = await deps.store.configReferences(ws, agent.id);
  for (const [table, count] of Object.entries(cfg)) {
    if (count > 0) {
      blockers.push({ code: `used_by_${table}`, message: `This agent is used by ${CONFIG_LABELS[table] ?? table}${count > 1 ? ` (${count})` : ""}. Remove it there first.` });
    }
  }

  const typedConfirmationReasons = externalBindingReasons(agent, await deps.workerAgentName());
  const cascade = await deps.store.cascadeCounts(ws, agent.id);
  return {
    agent: { id: agent.id, name: agent.name, kind: agent.kind },
    blockers,
    requiresTypedConfirmation: typedConfirmationReasons.length > 0,
    typedConfirmationReasons,
    cascade,
  };
}

export async function checkDeletion(deps: AgentMgmtDeps, input: { workspaceId: string; agentId: string }): Promise<MgmtOutcome> {
  const insp = await inspectDeletion(deps, input);
  if (!insp) return fail(404, "agent_not_found", "Agent not found in this workspace.");
  return ok({ ...insp, deletable: insp.blockers.length === 0 });
}

/**
 * Delete the PYDENT agent only. Never touches a number, dispatch rule, trunk
 * or provider resource. All checks re-run server-side immediately before the
 * delete; afterwards the phone-number checks run again and, if a concurrent
 * reassignment attached the agent in between, the row is restored.
 */
export async function deleteAgent(
  deps: AgentMgmtDeps,
  input: { workspaceId: string; agentId: string; confirm?: unknown; confirmName?: unknown }
): Promise<MgmtOutcome> {
  if (input.confirm !== true) return fail(400, "confirmation_required", "Confirm the deletion first.");
  const insp = await inspectDeletion(deps, input);
  if (!insp) return fail(404, "agent_not_found", "Agent not found in this workspace.");
  if (insp.blockers.length) {
    return fail(409, insp.blockers[0].code, insp.blockers[0].message, { blockers: insp.blockers, deleted: false });
  }
  if (insp.requiresTypedConfirmation && String(input.confirmName ?? "").trim() !== insp.agent.name) {
    return fail(400, "typed_confirmation_required", `Type the agent's name ("${insp.agent.name}") to confirm.`, {
      reasons: insp.typedConfirmationReasons,
    });
  }
  const snapshot = await deps.store.getAgent(input.workspaceId, input.agentId);
  if (!snapshot) return fail(404, "agent_not_found", "Agent not found in this workspace.");
  const removed = await deps.store.deleteAgent(input.workspaceId, snapshot.id);
  if (!removed) return fail(409, "delete_failed", "The agent could not be deleted (it may already be gone). No other changes were made.");

  // Post-check: a reassignment that raced the delete must not leave a number
  // pointing at a missing agent.
  const late = await deps.store.numberReferences(snapshot.id);
  const lateUnfinished = await deps.store.unfinishedAssignments(snapshot.id);
  if (late.length || lateUnfinished) {
    const restored = await deps.store.restoreAgent(snapshot);
    return fail(409, restored ? "delete_reverted" : "delete_reverted_failed",
      restored
        ? "A phone number was assigned to this agent while it was being deleted, so the agent was restored. Its conversation assignments and follow-ups may need to be re-created."
        : "A phone number was assigned to this agent while it was being deleted and the agent could NOT be restored. Contact support immediately.",
      { deleted: !restored });
  }
  return ok({ agentId: snapshot.id, name: snapshot.name, deleted: true, message: `Deleted "${snapshot.name}" from Pydent. No LiveKit, phone-number or provider resources were changed.` });
}
