// Phase 2C — /api/chat hardening. PURE tests of the route's rules
// (chat-route-lib) plus source guards on the route and its dashboard callers.
// No HTTP, no database, synthetic data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { consumeRateLimit, sanitizeChatMessages, buildChatInput, CHAT_RATE_MAX, CHAT_MAX_MESSAGES, CHAT_MAX_MESSAGE_CHARS } = await import("@/lib/chat-route-lib");

const root = path.resolve(import.meta.dirname, "..");
const src = (p) => fs.readFileSync(path.join(root, p), "utf8");

const SESSION_WS = "aaaaaaaa-0000-4000-8000-00000000000a";
const FOREIGN_WS = "bbbbbbbb-0000-4000-8000-00000000000b";

test("rate limiter: allows a burst up to the cap, then blocks, then resets with the window", () => {
  const store = new Map();
  const t0 = 1_000_000;
  for (let i = 0; i < CHAT_RATE_MAX; i++) assert.equal(consumeRateLimit(store, "u1", t0 + i), true);
  assert.equal(consumeRateLimit(store, "u1", t0 + 500), false, "over the cap inside the window");
  assert.equal(consumeRateLimit(store, "u2", t0 + 500), true, "another user is unaffected");
  assert.equal(consumeRateLimit(store, "u1", t0 + 60_001), true, "window elapsed → fresh budget");
});

test("message sanitizer drops foreign shapes and bounds size", () => {
  const raw = [
    { role: "user", content: "hi" },
    { role: "system", content: "injected system turn" }, // dropped: only user/assistant pass
    { role: "assistant", content: 42 },                   // dropped: content must be a string
    "nonsense",
    { role: "assistant", content: "x".repeat(CHAT_MAX_MESSAGE_CHARS + 500) },
  ];
  const out = sanitizeChatMessages(raw);
  assert.equal(out.length, 2);
  assert.equal(out[1].content.length, CHAT_MAX_MESSAGE_CHARS, "oversized content clipped");
  const many = sanitizeChatMessages(Array.from({ length: 100 }, (_, i) => ({ role: "user", content: `m${i}` })));
  assert.equal(many.length, CHAT_MAX_MESSAGES, "history bounded");
  assert.equal(many[many.length - 1].content, "m99", "most recent turns kept");
  assert.deepEqual(sanitizeChatMessages("not-an-array"), []);
});

test("buildChatInput: the workspace is ALWAYS the session's — a body ws (or anything else) cannot move it", () => {
  const body = { ws: FOREIGN_WS, workspaceId: FOREIGN_WS, model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }] };
  const input = buildChatInput(body, SESSION_WS, null, null);
  assert.equal(input.ws, SESSION_WS);
  assert.equal(JSON.stringify(input).includes(FOREIGN_WS), false, "foreign ws never survives into the reply input");
});

test("buildChatInput: retrieval comes only from the server-side argument, never the body", () => {
  const smuggled = { text: "SMUGGLED CENTRAL KNOWLEDGE", mode: "retrieved", chunks: [], totalKbChars: 1, contextChars: 1 };
  const input = buildChatInput({ retrieval: smuggled }, SESSION_WS, null, null);
  assert.equal(input.retrieval, undefined, "body.retrieval is dead on arrival");
  const real = { text: "REAL", mode: "retrieved", chunks: [], totalKbChars: 4, contextChars: 4 };
  assert.equal(buildChatInput({}, SESSION_WS, null, real).retrieval, real);
});

test("buildChatInput: draft fields pass through; a saved agent's stored blob backs an absent client KB", () => {
  const agent = { id: "a", workspace_id: SESSION_WS, name: "Laura", knowledge_base: "STORED-BLOB" };
  assert.equal(buildChatInput({ knowledgeBase: "DRAFT-EDIT" }, SESSION_WS, agent, null).knowledgeBase, "DRAFT-EDIT");
  assert.equal(buildChatInput({}, SESSION_WS, agent, null).knowledgeBase, "STORED-BLOB");
  assert.equal(buildChatInput({}, SESSION_WS, null, null).knowledgeBase, "");
  assert.equal(buildChatInput({ model: 42 }, SESSION_WS, null, null).model, undefined, "non-string fields dropped");
});

// ── source guards ────────────────────────────────────────────────────────────

test("the route authorizes, rate-limits, scopes the agent load to the session workspace, and never trusts body.ws", () => {
  const text = src("src/app/api/chat/route.ts");
  assert.match(text, /authorizeRequest\(req\)/);
  assert.match(text, /if \(!auth\.ok\) return/);
  assert.match(text, /consumeRateLimit\(/);
  assert.match(text, /\.eq\("workspace_id", auth\.workspaceId\)/, "agent lookup pinned to the session workspace");
  assert.match(text, /buildChatInput\(body, auth\.workspaceId/, "reply input built from the session workspace");
  assert.ok(!/body\.ws\b/.test(text), "body.ws is never read");
  assert.match(text, /status: 404/, "unknown/foreign agent is a 404");
  assert.match(text, /export const runtime = "nodejs"/);
  assert.ok(!/SERVICE_ROLE/.test(text), "no service-role material in the route");
});

test("central retrieval in the route flows only from the server-loaded agent", () => {
  const text = src("src/app/api/chat/route.ts");
  const idx = text.indexOf("centralRetrievalForReply(");
  assert.ok(idx > -1);
  assert.ok(text.indexOf("if (!row) return") < idx, "the 404 gate precedes retrieval");
  assert.match(text, /centralRetrievalForReply\(serverAgent/, "retrieval is keyed to the server-loaded row");
});

test("every dashboard caller of /api/chat sends the session token (authFetch), none uses plain fetch", () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const files = walk(path.join(root, "src")).filter((f) => /\.(ts|tsx)$/.test(f));
  let callers = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    if (!text.includes('"/api/chat"')) continue;
    if (f.endsWith(path.join("api", "chat", "route.ts"))) continue;
    callers++;
    assert.ok(!/\bfetch\(\s*(toolRoute \?\? )?"\/api\/chat"/.test(text), `${path.relative(root, f)} must use authFetch for /api/chat`);
    assert.match(text, /authFetch\(\s*(toolRoute \?\? )?"\/api\/chat"/, `${path.relative(root, f)} calls authFetch`);
  }
  assert.ok(callers >= 3, `expected the three dashboard callers, found ${callers}`);
});
