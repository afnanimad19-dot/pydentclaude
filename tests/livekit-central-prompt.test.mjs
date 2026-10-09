// Phase 1C — LiveKit Central Knowledge prompt cutover. PURE tests: compiled
// instructions are built with livekitAgentConfig directly; the migration-state
// decision (knowledgePromptMode) runs with INJECTED assignment probes; the
// Supabase-bound probe and the route wiring are guarded by source scans.
// No database, no network, synthetic data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { livekitAgentConfig, builderMetadata, dispatchMetadata } = await import("@/lib/livekit.ts");
const { knowledgePromptMode } = await import("@/lib/knowledge-runtime");

const root = path.resolve(import.meta.dirname, "..");
const src = (p) => fs.readFileSync(path.join(root, p), "utf8");

const WS_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const WS_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const AGENT_ID = "00000000-aaaa-4000-8000-000000000001";
const BLOB_SECRET = "LEGACY-KB-SECRET osmium crown price list";

const agentRow = (overrides = {}) => ({
  id: AGENT_ID,
  name: "Laura",
  language: "en",
  agent_identity: "Warm, professional front-desk persona.",
  instructions: "Help callers book, reschedule and ask about treatments.",
  behavior: "Short sentences. Never rush the caller.",
  knowledge_base: `--- Legacy notes ---\n${BLOB_SECRET}. Open 10:00-16:00 (outdated).`,
  first_message: "Hi, this is Laura!",
  can_book: true,
  can_reschedule: true,
  can_cancel: false,
  voice_settings: {},
  ...overrides,
});

const cfg = (mode, overrides = {}) =>
  mode === undefined
    ? livekitAgentConfig(agentRow(overrides), WS_A, "https://pydent.test")
    : livekitAgentConfig(agentRow(overrides), WS_A, "https://pydent.test", undefined, undefined, mode);

// ── instruction compilation ───────────────────────────────────────────────────

test("(1,7,9,10) central mode: NO legacy KB content; search_knowledge grounding, persona and tool rules intact", () => {
  const c = cfg("central");
  assert.equal(c.knowledgePromptMode, "central");
  assert.ok(!c.instructions.includes(BLOB_SECRET), "legacy blob content absent");
  assert.ok(!c.instructions.includes("10:00-16:00"), "outdated legacy facts absent");
  assert.ok(!c.instructions.includes("KNOWLEDGE BASE (answer ONLY from this"), "legacy knowledge section absent");
  assert.ok(c.instructions.includes("search_knowledge"), "the tool is the knowledge source");
  assert.match(c.instructions, /KNOWLEDGE: the clinic's real facts .* ONLY through the search_knowledge tool/);
  assert.match(c.instructions, /NEVER guess/, "anti-invention grounding kept");
  // Persona, tasks, style, booking and voice rules are untouched by the cutover.
  for (const kept of [
    "AGENT IDENTITY:\nWarm, professional front-desk persona.",
    "TASKS:\nHelp callers book, reschedule and ask about treatments.",
    "STYLE GUARDRAILS:\nShort sentences. Never rush the caller.",
    "BOOKING: use get_available_slots first",
    "RESCHEDULE: confirm the new time",
    "VOICE OUTPUT RULES",
    "OPENING:",
  ]) {
    assert.ok(c.instructions.includes(kept), kept.slice(0, 30));
  }
  // The non-knowledge configuration is identical across modes.
  const l = cfg("legacy");
  for (const k of ["greeting", "stt", "llm", "tts", "voice", "tools", "limits", "canBook", "toolExecUrl"]) {
    assert.deepEqual(c[k], l[k], k);
  }
});

test("(2,8) legacy mode and the DEFAULT are byte-identical to the pre-1C prompt, blob included", () => {
  const legacy = cfg("legacy");
  const dflt = cfg(undefined);
  assert.equal(legacy.instructions, dflt.instructions, "default = legacy (backward compatible)");
  assert.equal(legacy.knowledgePromptMode, "legacy");
  assert.ok(legacy.instructions.includes(BLOB_SECRET), "legacy agents keep their blob");
  assert.ok(legacy.instructions.includes("KNOWLEDGE BASE (answer ONLY from this"), "legacy knowledge section present");
  assert.ok(legacy.instructions.includes("call the search_knowledge tool"), "legacy grounding still points at search_knowledge");
  // The 48K truncation path is unchanged.
  const big = cfg("legacy", { knowledge_base: "X".repeat(60000) });
  assert.ok(big.instructions.includes("X".repeat(48000)) && !big.instructions.includes("X".repeat(48001)), "48K cap intact");
});

test("(6) a blob-less agent in central mode still gets the knowledge grounding (decision is assignment-based, not content-based)", () => {
  const c = cfg("central", { knowledge_base: "" });
  assert.ok(c.instructions.includes("search_knowledge"));
  // While a blob-less LEGACY agent has no knowledge section at all (pre-1C behaviour).
  const l = cfg("legacy", { knowledge_base: "" });
  assert.ok(!l.instructions.includes("KNOWLEDGE BASE"));
});

// ── migration-state decision (knowledgePromptMode with injected probes) ───────

test("(3,4,5) assignment existence alone decides the mode — document readiness never enters it", async () => {
  // The probe reports only "an assignment exists"; there IS no document input.
  assert.equal(await knowledgePromptMode(WS_A, AGENT_ID, async () => ({ assigned: true })), "central");
  assert.equal(await knowledgePromptMode(WS_A, AGENT_ID, async () => ({ assigned: false })), "legacy");
  // The REAL probe cannot consult documents either: it reads only the
  // assignment table and never selects document status or content.
  const code = src("src/lib/knowledge-runtime.ts");
  const probe = code.slice(code.indexOf("defaultAssignmentProbe"), code.indexOf("export async function knowledgePromptMode"));
  assert.ok(probe.includes('from("agent_knowledge_resources")'), "probe reads assignments");
  assert.ok(!probe.includes("knowledge_documents") && !probe.includes("status"), "probe never reads documents/status");
});

test("(6b) failure policy: 0065 missing → legacy; any other lookup failure → central (never re-inject the blob on uncertainty)", async () => {
  assert.equal(await knowledgePromptMode(WS_A, AGENT_ID, async () => ({ error: { code: "42P01" } })), "legacy");
  assert.equal(await knowledgePromptMode(WS_A, AGENT_ID, async () => ({ error: { code: "PGRST205", message: "could not find the table" } })), "legacy");
  assert.equal(await knowledgePromptMode(WS_A, AGENT_ID, async () => ({ error: { code: "57014", message: "timeout" } })), "central");
  assert.equal(await knowledgePromptMode(WS_A, AGENT_ID, async () => { throw new Error("db down"); }), "central");
  assert.equal(await knowledgePromptMode("", AGENT_ID), "legacy", "no workspace → legacy");
  assert.equal(await knowledgePromptMode(WS_A, ""), "legacy", "no agent → legacy");
});

test("(16,17) migration-state lookup is workspace-scoped: foreign assignments cannot switch another workspace's mode", async () => {
  // A probe that mimics the real query's filters over hostile rows: workspace
  // B holds an assignment for this agent id; workspace A holds none.
  const rows = [{ workspace_id: WS_B, agent_id: AGENT_ID }];
  const filteredProbe = async (ws, agentId) => ({ assigned: rows.some((r) => r.workspace_id === ws && r.agent_id === agentId) });
  assert.equal(await knowledgePromptMode(WS_A, AGENT_ID, filteredProbe), "legacy", "B's rows don't migrate A's agent");
  assert.equal(await knowledgePromptMode(WS_B, AGENT_ID, filteredProbe), "central");
  // And the real probe carries both filters.
  const code = src("src/lib/knowledge-runtime.ts");
  const probe = code.slice(code.indexOf("defaultAssignmentProbe"), code.indexOf("export async function knowledgePromptMode"));
  assert.ok(probe.includes('.eq("workspace_id", ws)') && probe.includes('.eq("agent_id", agentId)'));
});

// ── metadata security (11, 12) ────────────────────────────────────────────────

test("(11,12) worker dispatch metadata carries NO knowledge of either kind", () => {
  const meta = JSON.parse(dispatchMetadata(AGENT_ID, WS_A, { source: "web-test" }));
  assert.deepEqual(Object.keys(meta).sort(), ["pydentAgentId", "source", "ws"]);
  const s = JSON.stringify(meta);
  assert.ok(!s.includes(BLOB_SECRET) && !/instructions|knowledge/i.test(s));
  // The session route still mints id-only metadata for the Pydent worker and
  // resolves the knowledge mode only for the external Builder branch.
  const session = src("src/app/api/livekit/session/route.ts");
  assert.match(session, /:\s*dispatchMetadata\(/);
  assert.match(session, /builderMetadata\([\s\S]*?knowledgePromptMode\(/, "Builder branch resolves the mode server-side");
});

// ── Builder contract (13, 14, 15) ─────────────────────────────────────────────

test("(13,14,15) builderMetadata keeps its contract; central drops the blob from compiled instructions; legacy/default unchanged", () => {
  const legacy = JSON.parse(builderMetadata(agentRow(), WS_A, "https://pydent.test", { source: "web-test" }));
  const dflt = JSON.parse(builderMetadata(agentRow(), WS_A, "https://pydent.test", { source: "web-test" }, undefined));
  const central = JSON.parse(builderMetadata(agentRow(), WS_A, "https://pydent.test", { source: "web-test" }, "central"));
  for (const m of [legacy, dflt, central]) {
    // The {{metadata.instructions}} contract fields all survive.
    for (const k of ["pydentAgentId", "ws", "agentName", "instructions", "greeting", "language", "canBook", "canReschedule", "canCancel", "source"]) {
      assert.ok(k in m, k);
    }
  }
  assert.equal(legacy.instructions, dflt.instructions, "omitted mode = legacy (SIP/number-routing callers unchanged)");
  assert.ok(legacy.instructions.includes(BLOB_SECRET), "legacy Builder agents keep their knowledge");
  assert.ok(!central.instructions.includes(BLOB_SECRET), "central Builder agents lose the legacy blob");
  assert.ok(central.instructions.includes("search_knowledge"));
});

// ── route wiring + channel boundary ───────────────────────────────────────────

test("agent-config compiles with the server-resolved mode and logs it (content-free)", () => {
  const code = src("src/app/api/livekit/agent-config/route.ts");
  assert.ok(code.includes("knowledgePromptMode(agentWs"), "mode resolved from the authenticated workspace + agent");
  assert.match(code, /livekitAgentConfig\(agent, agentWs, requestOrigin\(req\), tz, clinicName, knowledgeMode\)/);
  assert.match(code, /knowledge_prompt_mode=\$\{knowledgeMode\}/, "observability line");
  // The log line carries ids and mode only — no instruction/knowledge values.
  assert.ok(!/console\.log\([^)]*instructions/.test(code));
});

test("(22) channel boundary: SIP/phone, number routing, chat, WhatsApp, SMS and Vapi are untouched by 1C", () => {
  // The two SIP-side builderMetadata callers still use the 4-arg legacy form.
  assert.ok(src("src/app/api/livekit/phone/route.ts").includes('builderMetadata(agentRow, ws, requestOrigin(req), { source: "phone", number: num })'));
  assert.ok(src("src/lib/number-routing-server.ts").includes('builderMetadata(agent, workspaceId, origin, { source: "phone" })'));
  // Non-LiveKit channels keep their legacy retrieval paths (no runtime reader).
  for (const f of ["src/lib/agent-reply.ts", "src/app/api/chat/route.ts", "src/app/api/whatsapp/webhook/route.ts", "src/app/api/sms/webhook/route.ts", "src/app/api/vapi/assistants/route.ts"]) {
    assert.doesNotMatch(src(f), /knowledge-runtime|knowledgePromptMode/, f);
  }
  // The worker itself is untouched.
  assert.ok(src("livekit-agent/agent.py").includes('"/api/agents/tool-exec", {"token": WORKER_TOKEN'));
});
