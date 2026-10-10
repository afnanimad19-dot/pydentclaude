// Phase 2C — Central Knowledge in TEXT channels. Behavior tests stub
// globalThis.fetch (no network): an injected retrieval must land in the system
// prompt and the legacy blob must stay out; the overflow slim-retry must trim
// the injected source, never swap it. Source guards pin the webhook wiring:
// one server-side retrieval per turn, computed before the reply input, and the
// retrieval field never read from a request body. Synthetic data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { generateAgentReply, generateAgentReplyWithTools } = await import("@/lib/agent-reply");
const { NO_MATCH_PROMPT_NOTE } = await import("@/lib/agent-tools-core");

const root = path.resolve(import.meta.dirname, "..");
const src = (p) => fs.readFileSync(path.join(root, p), "utf8");

const LEGACY_MARKER = "LEGACY-BLOB-ONLY-FACT osmium crowns";
const CENTRAL_TEXT = "--- Clinic FAQ / faq.pdf · Prices ---\nVeneers cost 1200 dirhams per tooth.";
const injected = {
  text: CENTRAL_TEXT,
  mode: "retrieved",
  chunks: [{ source: "Clinic FAQ / faq.pdf · Prices", id: 0, score: 0.9, chars: CENTRAL_TEXT.length, preview: "Veneers cost" }],
  totalKbChars: CENTRAL_TEXT.length,
  contextChars: CENTRAL_TEXT.length,
};

const baseInput = {
  model: "openai/gpt-4o-mini",
  agentName: "Laura",
  knowledgeBase: LEGACY_MARKER,
  messages: [{ role: "user", content: "How much do veneers cost?" }],
};

/** Stub fetch; `plan` maps call index → "ok" | "fail". Returns captured JSON bodies. */
function stubFetch(plan) {
  const bodies = [];
  const original = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init?.body ?? "{}");
    bodies.push(body);
    const mode = plan[Math.min(call, plan.length - 1)];
    call++;
    if (mode === "fail") return new Response(JSON.stringify({ error: { message: "maximum context length exceeded" } }), { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  };
  return { bodies, restore: () => (globalThis.fetch = original) };
}

const systemOf = (body) => body.messages?.find((m) => m.role === "system")?.content ?? "";

test("injected retrieval replaces the legacy blob in the system prompt", async () => {
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  const { bodies, restore } = stubFetch(["ok"]);
  try {
    const r = await generateAgentReply({ ...baseInput, retrieval: injected });
    assert.equal(r.status, 200);
    const sys = systemOf(bodies[0]);
    assert.match(sys, /CLINIC KNOWLEDGE/);
    assert.match(sys, /Veneers cost 1200 dirhams/);
    assert.match(sys, /Clinic FAQ \/ faq\.pdf · Prices/);
    assert.ok(!sys.includes(LEGACY_MARKER), "legacy blob must not appear in a central turn");
    assert.equal(r.retrieval.chunks[0].source, "Clinic FAQ / faq.pdf · Prices");
  } finally {
    restore();
  }
});

test("without an injected retrieval the legacy knowledgeBase path is byte-compatible", async () => {
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  const { bodies, restore } = stubFetch(["ok"]);
  try {
    const r = await generateAgentReply({ ...baseInput });
    assert.equal(r.status, 200);
    assert.match(systemOf(bodies[0]), /LEGACY-BLOB-ONLY-FACT/);
  } finally {
    restore();
  }
});

test("the grounding note travels like knowledge: a no-match turn still carries grounding, not the blob", async () => {
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  const { bodies, restore } = stubFetch(["ok"]);
  try {
    await generateAgentReply({ ...baseInput, retrieval: { ...injected, text: NO_MATCH_PROMPT_NOTE, chunks: [], mode: "empty" } });
    const sys = systemOf(bodies[0]);
    assert.match(sys, /No stored clinic knowledge matched/);
    assert.match(sys, /GROUNDING/);
    assert.ok(!sys.includes(LEGACY_MARKER));
  } finally {
    restore();
  }
});

test("overflow slim-retry TRIMS the injected central retrieval — it never swaps back to the legacy blob", async () => {
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  const { bodies, restore } = stubFetch(["fail"]); // every call fails → full attempt(s), then the slim retry
  try {
    const big = { ...injected, text: CENTRAL_TEXT + "\nPADDING ".repeat(2000), contextChars: 20000 };
    const r = await generateAgentReply({ ...baseInput, retrieval: big });
    assert.equal(r.status, 502, "both attempts failed in this scenario");
    assert.ok(bodies.length >= 2, "a slim retry was sent");
    const slimSys = systemOf(bodies[bodies.length - 1]);
    assert.match(slimSys, /Veneers cost 1200 dirhams/, "slim retry keeps the central source");
    assert.ok(!slimSys.includes(LEGACY_MARKER), "slim retry must not fall back to the legacy blob");
  } finally {
    restore();
  }
});

test("generateAgentReplyWithTools honors the injected retrieval too", async () => {
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  const { bodies, restore } = stubFetch(["ok"]);
  try {
    const r = await generateAgentReplyWithTools({ ...baseInput, capabilities: { canBook: true }, retrieval: injected }, async () => "unused");
    assert.equal(r.status, 200);
    const sys = systemOf(bodies[0]);
    assert.match(sys, /Veneers cost 1200 dirhams/);
    assert.ok(!sys.includes(LEGACY_MARKER));
  } finally {
    restore();
  }
});

// ── wiring guards (source scans) ─────────────────────────────────────────────

test("both webhooks compute ONE server-side central retrieval per turn and inject it", () => {
  for (const p of ["src/app/api/whatsapp/webhook/route.ts", "src/app/api/sms/webhook/route.ts"]) {
    const text = src(p);
    assert.equal((text.match(/centralRetrievalForReply\(/g) ?? []).length, 1, `${p}: exactly one retrieval per turn`);
    assert.match(text, /\.\.\.\(central \? \{ retrieval: central\.retrieval \} : \{\}\)/, `${p}: retrieval injected only from the server-side helper`);
    assert.ok(text.indexOf("centralRetrievalForReply(") < text.indexOf("const replyInput"), `${p}: retrieval computed before the reply input`);
    assert.match(text, /workspace_id: ws/, `${p}: workspace is the webhook's server-resolved ws`);
  }
});

test("agent-reply treats the retrieval field as server-only and never swaps sources mid-request", () => {
  const text = src("src/lib/agent-reply.ts");
  assert.equal((text.match(/input\.retrieval \?\? runRetrieval\(input\)/g) ?? []).length, 2, "both entry points honor the injection");
  assert.match(text, /const slimR = input\.retrieval\s*\n?\s*\? \{ \.\.\.input\.retrieval/, "slim retry trims the injected retrieval");
  assert.match(text, /SERVER-ONLY/, "the field is documented as server-only");
});

test("no route ever copies a retrieval out of a request body", () => {
  const apiDir = path.join(root, "src", "app", "api");
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const f of walk(apiDir).filter((f) => f.endsWith(".ts"))) {
    const text = fs.readFileSync(f, "utf8");
    assert.ok(!/body\s*\.\s*retrieval|retrieval:\s*body\./.test(text), `${path.relative(root, f)} must not take retrieval from the client`);
  }
});
