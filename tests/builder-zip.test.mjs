// LiveKit Builder "Download code" ZIP import: safe ZIP handling, the narrow
// Python-source parser, secret exclusion, model-mapping honesty, and
// non-destructive idempotent merging. Fixture values mirror the production
// reference package (acceptance fixtures only — nothing is hard-coded in the
// implementation).

import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";

const { extractAgentPy, parseAgentPy, parseBuilderZip, ZIP_LIMITS } = await import("@/lib/livekit-zip-import");
const { mapBuilderModels, mergeImportedTools, mergeImportedAgent } = await import("@/lib/livekit-builder-import");

const INSTRUCTIONS = `You are Laura, the AI receptionist of the Leila Hariri Dental and Sleep Apnea Clinic.

Task 1: Greet the Caller
If pat_num is present, greet them by their title and last name.

Task 7, Rule 2: Never ask the caller for a "fee" or price.`;

const AGENT_PY = `from livekit.agents import Agent, AgentSession, function_tool, inference
from livekit.plugins import noise_cancellation

WELCOME_MESSAGE = "Hello! Thank you for Calling Leila Hariri Dental. How can i help you today"

END_CALL_INSTRUCTIONS = (
    "Only end the call after the caller has either received the requested "
    "information or confirmed their message and next step. Before ending, restate what will happen next."
)

@function_tool
async def end_call(reason: str = "") -> str:
    """End the call."""
    return "ended"

@function_tool
async def lookup_patient(phone: str = "") -> str:
    return "..."

async def entrypoint(ctx):
    session = AgentSession(
        stt=inference.STT("xai/stt-1", language="en"),
        llm=inference.LLM("openai/gpt-5.6-luna", extra_kwargs={"reasoning_effort": "low"}),
        tts=inference.TTS("cartesia/sonic-3.6", voice="ec1e269e-9ca0-402f-8a18-58e0e022355a", language="en-US"),
        turn_detection=inference.TurnDetector(),
        preemptive_generation=True,
        noise_cancellation=noise_cancellation.QUAIL_VF_S(),
        delete_room=False,
    )
    agent = Agent(instructions="""${INSTRUCTIONS}""", tools=[end_call, lookup_patient])
    await session.start(agent=agent, room=ctx.room)
    await session.say(WELCOME_MESSAGE, allow_interruptions=True)
`.replace("${INSTRUCTIONS}", INSTRUCTIONS);

function makeZip(extra = {}, agentPy = AGENT_PY) {
  return zipSync({
    "src/agent.py": strToU8(agentPy),
    "README.md": strToU8("# generated"),
    "pyproject.toml": strToU8("[project]"),
    ".env": strToU8("LIVEKIT_API_SECRET=FAKE_ZIP_SECRET_999\n"),
    ".env.local": strToU8("OPENAI_API_KEY=FAKE_ZIP_SECRET_999\n"),
    ...extra,
  });
}

test("1+2: valid Builder ZIP parses and finds src/agent.py", async () => {
  const r = await parseBuilderZip(makeZip());
  assert.equal(r.sourceFile, "src/agent.py");
  assert.equal(r.fingerprint.length, 64);
});

test("3: full multiline Instructions extracted exactly, untruncated", () => {
  const { parsed } = parseAgentPy(AGENT_PY);
  assert.equal(parsed.snapshot.instructions, INSTRUCTIONS);
});

test("4+5: welcome message via constant + say(); greeting interruption true", () => {
  const { parsed } = parseAgentPy(AGENT_PY);
  assert.equal(parsed.snapshot.welcomeMessage, "Hello! Thank you for Calling Leila Hariri Dental. How can i help you today");
  assert.equal(parsed.snapshot.welcomeEnabled, true);
  assert.equal(parsed.snapshot.greetingInterruptible, true);
});

test("6: End Call — enabled, final response from adjacent-string constant, deleteRoom false", () => {
  const { parsed, tools } = parseAgentPy(AGENT_PY);
  assert.equal(parsed.snapshot.endCallEnabled, true);
  assert.match(parsed.snapshot.endCallFinalResponse, /Before ending, restate what will happen next/);
  assert.equal(tools.endCall.deleteRoom, false);
  assert.equal(tools.endCall.summaryUrl, "");
});

test("7-15: models, languages, voice, reasoning, noise model, preemptive generation", () => {
  const { parsed } = parseAgentPy(AGENT_PY);
  const s = parsed.snapshot;
  assert.equal(s.stt, "xai/stt-1");
  assert.equal(s.sttLanguage, "en");
  assert.equal(s.llm, "openai/gpt-5.6-luna");
  assert.equal(s.reasoningEffort, "low");
  assert.equal(s.tts, "cartesia/sonic-3.6");
  assert.equal(s.voiceLanguage, "en-US");
  assert.equal(s.voice, "ec1e269e-9ca0-402f-8a18-58e0e022355a");
  assert.equal(s.noiseCancellation, true);
  assert.equal(s.noiseCancellationModel, "QUAIL_VF_S");
  assert.equal(s.turnDetector, "livekit-inference");
  assert.equal(s.preemptiveGeneration, true);
});

test("16: missing optional fields stay unavailable — never guessed", () => {
  const { parsed } = parseAgentPy("x = 1\n");
  assert.equal(parsed.snapshot.stt, undefined);
  assert.equal(parsed.status.stt, "unavailable");
  assert.equal(parsed.status.backgroundAudio, "unavailable");
  assert.ok(parsed.warnings.length >= 1);
});

test("17: malformed ZIP rejected with a clear error", async () => {
  await assert.rejects(() => parseBuilderZip(strToU8("this is not a zip at all")), /could not be read as a ZIP/);
});

test("18: missing agent.py rejected", async () => {
  const z = zipSync({ "README.md": strToU8("hi") });
  await assert.rejects(() => parseBuilderZip(z), /No agent\.py found/);
});

test("19: multiple ambiguous agent.py files rejected; canonical src/agent.py wins when present", async () => {
  const ambiguous = zipSync({ "a/agent.py": strToU8("x=1"), "b/agent.py": strToU8("y=2") });
  await assert.rejects(() => parseBuilderZip(ambiguous), /cannot choose safely/);
  const canonical = zipSync({ "b/agent.py": strToU8("y=2"), "src/agent.py": strToU8(AGENT_PY) });
  const r = await parseBuilderZip(canonical);
  assert.equal(r.sourceFile, "src/agent.py");
});

test("20+21: traversal and absolute-path entries rejected outright", () => {
  assert.throws(() => extractAgentPy(zipSync({ "../evil/agent.py": strToU8("x") })), /path-traversal/);
  assert.throws(() => extractAgentPy(zipSync({ "/abs/agent.py": strToU8("x") })), /absolute path/);
});

test("22-24: size and entry limits enforced", () => {
  const limits = { ...ZIP_LIMITS, maxZipBytes: 100 };
  assert.throws(() => extractAgentPy(makeZip(), limits), /larger than/);

  const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}.txt`, strToU8("x")]));
  assert.throws(() => extractAgentPy(zipSync(many), { ...ZIP_LIMITS, maxEntries: 10 }), /more than 10 entries/);

  const big = zipSync({ "big.bin": new Uint8Array(300_000), "src/agent.py": strToU8("x=1") });
  assert.throws(() => extractAgentPy(big, { ...ZIP_LIMITS, maxTotalUncompressedBytes: 200_000 }), /uncompressed limit/);

  const bigAgent = zipSync({ "src/agent.py": new Uint8Array(60_000) });
  assert.throws(() => extractAgentPy(bigAgent, { ...ZIP_LIMITS, maxAgentPyBytes: 50_000 }), /agent\.py limit/);
});

test("25+26: malformed / unknown Python yields unavailable fields, no crash", () => {
  const { parsed } = parseAgentPy('def broken(:\n  ???\ninstructions="ok though"');
  assert.equal(parsed.snapshot.instructions, "ok though", "recognizable kwargs still parse");
  const weird = parseAgentPy("for i in range(10):\n    compute(i)\n");
  assert.equal(Object.keys(weird.parsed.snapshot).length, 0);
});

test("27: .env contents are excluded before decompression and never appear anywhere", async () => {
  const r = await parseBuilderZip(makeZip());
  assert.ok(!JSON.stringify(r).includes("FAKE_ZIP_SECRET_999"));
});

test("28: a secret assigned in Python source never lands in the snapshot", () => {
  const { parsed, tools } = parseAgentPy(AGENT_PY + '\napi_key = "PY_SECRET_42"\nheaders = {"Authorization": "Bearer PY_SECRET_42"}\n');
  const j = JSON.stringify({ parsed, tools });
  assert.ok(!j.includes("PY_SECRET_42"));
});

test("29+30: unsupported models stay unmapped with warnings; supported ones map", () => {
  const { parsed } = parseAgentPy(AGENT_PY);
  const m = mapBuilderModels(parsed.snapshot);
  assert.equal(m.stt, undefined, "xai/stt-1 not in catalog — must NOT be substituted");
  assert.equal(m.llm, undefined, "openai/gpt-5.6-luna not in catalog — must NOT be substituted");
  assert.equal(m.tts, "cartesia/sonic-3.6", "supported model maps exactly");
  assert.equal(m.voice, "ec1e269e-9ca0-402f-8a18-58e0e022355a", "voice id stays exact");
  assert.equal(m.warnings.length, 2);
});

test("31-35: merge preserves KB, abilities, binding; absent fields never overwrite", () => {
  const existing = {
    canBook: true, canReschedule: true, canCancel: false,
    kbFiles: ["doc1.pdf"], knowledgeBase: "--- doc1.pdf ---\nfacts",
    firstMessage: "existing greeting", instructions: "existing prompt",
    voiceSettings: { livekit: { agentName: "receptionist-livekit-laura" } },
  };
  const merged = mergeImportedAgent(existing, { instructions: "", firstMessage: undefined });
  assert.deepEqual(merged, existing);
});

test("36+37: same ZIP parsed+merged 10 times is idempotent; unrelated tools survive", async () => {
  let tools = [{ name: "custom_http", displayName: "Custom", type: "http", enabled: true, source: "livekit-builder", executable: false, url: "https://keep.example/x" }];
  let fingerprints = new Set();
  for (let i = 0; i < 10; i++) {
    const again = await parseBuilderZip(makeZip());
    fingerprints.add(again.fingerprint);
    tools = mergeImportedTools(tools, again.tools.tools);
  }
  assert.equal(fingerprints.size, 1, "same code -> same fingerprint");
  assert.equal(tools.filter((t) => t.name === "end_call").length, 1);
  assert.equal(tools.filter((t) => t.name === "lookup_patient").length, 1);
  assert.ok(tools.some((t) => t.name === "custom_http" && t.url === "https://keep.example/x"), "unrelated tool intact");
});

test("38+39: provenance round-trips; old blobs still fine", async () => {
  const { normalizeVoiceSettings } = await import("@/lib/agent-config");
  const meta = { source: "livekit-builder-zip", agentName: "receptionist-livekit-laura", importedAt: "2026-09-19T00:00:00Z", fields: {}, filename: "laura.zip", sourceFile: "src/agent.py", sourceFingerprint: "ab".repeat(32), rawModels: { stt: "xai/stt-1" } };
  const v = normalizeVoiceSettings({ builderImport: meta });
  assert.deepEqual(normalizeVoiceSettings(v).builderImport, meta);
  assert.equal(normalizeVoiceSettings({}).builderImport, undefined);
});

test("40: CALL ENDING is never duplicated in the compiled prompt (zip-derived endCall + legacy behavior)", async () => {
  const { livekitAgentConfig } = await import("@/lib/livekit.ts");
  const { tools } = parseAgentPy(AGENT_PY);
  const agent = {
    id: "a", name: "Laura", behavior: "CALL ENDING — before ending: restate what will happen next.",
    voice_settings: { endCall: tools.endCall }, can_book: false,
  };
  const i = livekitAgentConfig(agent, "ws", "https://x").instructions;
  assert.equal((i.match(/restate what will happen next/gi) ?? []).length, 1);
});

test("41+42: the ZIP importer performs zero network requests and never executes source", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("src/lib/livekit-zip-import.ts", "utf-8");
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|axios|\beval\s*\(|new Function|child_process|(?<![.\w])exec\s*\(/.test(src));
  // and dynamically: parsing runs with fetch stubbed to throw
  const origFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("network call during ZIP parse!"); };
  try {
    await parseBuilderZip(makeZip());
  } finally {
    globalThis.fetch = origFetch;
  }
});
