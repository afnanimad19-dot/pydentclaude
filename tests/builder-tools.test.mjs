// LiveKit Builder TOOL import: parsing shapes, End Call, secret stripping,
// the instructions-are-not-tools rule, and non-destructive merge.

import { test } from "node:test";
import assert from "node:assert/strict";

const { parseBuilderTools, mergeImportedTools, scrubSecrets, normalizeToolName } =
  await import("@/lib/livekit-builder-import");

const EXPORT = JSON.stringify({
  agent: {
    instructions: "Use lookup_patient and transfer_call when needed. Call book_appointment after confirmation.",
    tools: [
      { name: "End Call", type: "end_call", enabled: true },
      { name: "get_available_slots", description: "Check open slots" },
      {
        name: "Book Now",
        type: "http",
        method: "post",
        url: "https://api.example.com/book",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-SECRET-123", "X-Api-Key": "abcd1234abcd1234abcd1234" },
        parameters: { type: "object", properties: { date: { type: "string" }, api_key: { type: "string" } } },
        timeout: 15,
      },
      { name: "mystery_widget", description: "unknown thing" },
    ],
  },
  end_call_enabled: true,
  final_response: "Before ending, restate what will happen next.",
  delete_room_for_all_participants: false,
});

test("nested agent.tools parses; each category classified honestly", () => {
  const r = parseBuilderTools(EXPORT);
  const byName = Object.fromEntries(r.tools.map((t) => [t.name, t]));
  assert.equal(byName.end_call.type, "end_call");
  assert.equal(byName.end_call.executable, true);
  assert.equal(byName.get_available_slots.type, "pydent_native");
  assert.equal(byName.get_available_slots.mappedTo, "get_available_slots");
  assert.equal(byName.book_now.type, "http");
  assert.equal(byName.book_now.executable, false, "HTTP tools are configuration-only — Pydent has no HTTP executor");
  assert.equal(byName.book_now.method, "POST");
  assert.equal(byName.book_now.url, "https://api.example.com/book");
  assert.equal(byName.book_now.timeoutMs, 15000);
  assert.equal(byName.mystery_widget.type, "imported");
  assert.equal(byName.mystery_widget.executable, false);
});

test("top-level tools and actions aliases both parse", () => {
  for (const key of ["tools", "actions", "functions"]) {
    const r = parseBuilderTools(JSON.stringify({ [key]: [{ name: "get_available_slots" }] }));
    assert.equal(r.tools.length, 1, key);
  }
});

test("End Call block parses: enabled, empty conditions, final response, deleteRoom, empty summary", () => {
  const r = parseBuilderTools(EXPORT);
  assert.ok(r.endCall);
  assert.equal(r.endCall.enabled, true);
  assert.equal(r.endCall.conditions, "");
  assert.match(r.endCall.finalResponse, /restate what will happen next/);
  assert.equal(r.endCall.deleteRoom, false);
  assert.equal(r.endCall.summaryUrl, "");
});

test("summary endpoint + headers parse with secrets stripped", () => {
  const r = parseBuilderTools(JSON.stringify({
    end_call_enabled: true,
    summary_endpoint_url: "https://hooks.example.com/summary",
    summary_headers: { "X-Trace": "on", Authorization: "Bearer topsecret" },
  }));
  assert.equal(r.endCall.summaryUrl, "https://hooks.example.com/summary");
  assert.equal(r.endCall.summaryHeaders["X-Trace"], "on");
  assert.equal(r.endCall.summaryHeaders.Authorization, "", "auth value blanked, name kept");
  assert.equal(r.endCall.authRequired, true);
});

test("secrets never survive: headers, schema keys, api-key-shaped values", () => {
  const r = parseBuilderTools(EXPORT);
  const json = JSON.stringify(r);
  assert.ok(!json.includes("sk-SECRET-123"));
  assert.ok(!json.includes("abcd1234abcd1234abcd1234"));
  const book = r.tools.find((t) => t.name === "book_now");
  assert.equal(book.headers.Authorization, "");
  assert.equal(book.authRequired, true);
  // schema had an api_key property — stripped recursively
  assert.ok(!JSON.stringify(book.inputSchema).includes("api_key"));
  assert.ok(JSON.stringify(book.inputSchema).includes("date"), "non-secret schema fields survive");
});

test("scrubSecrets removes secret keys at any depth incl. arrays", () => {
  const s = scrubSecrets({ a: [{ client_secret: "x", ok: 1 }], b: { private_key: "y", keep: { cookie: "z", fine: true } } });
  const j = JSON.stringify(s);
  assert.ok(!/client_secret|private_key|cookie/.test(j));
  assert.ok(j.includes('"ok":1') && j.includes('"fine":true'));
});

test("ABSOLUTE RULE: tool names in instructions do NOT become tools", () => {
  const r = parseBuilderTools(JSON.stringify({
    instructions: "You can lookup_patient, create_patient, get_available_slots, book_appointment, manage_appointment, transfer_call and end_call.",
  }));
  assert.equal(r.tools.length, 0);
  assert.ok(r.referencedOnly.includes("lookup_patient"));
  assert.ok(r.referencedOnly.includes("transfer_call"));
});

test("plain-text paste never creates tools either", () => {
  const r = parseBuilderTools("Use book_appointment and end_call politely.");
  assert.equal(r.tools.length, 0);
  assert.ok(r.referencedOnly.includes("book_appointment"));
});

test("http tool without a URL never invents an endpoint", () => {
  const r = parseBuilderTools(JSON.stringify({ tools: [{ name: "webhooky", type: "http" }] }));
  assert.equal(r.tools[0].type, "imported");
  assert.equal(r.tools[0].url, undefined);
  assert.equal(r.tools[0].executable, false);
});

test("duplicate tool names: first kept, warning raised", () => {
  const r = parseBuilderTools(JSON.stringify({ tools: [
    { name: "book_now", url: "https://a.example/x", type: "http" },
    { name: "Book Now", url: "https://b.example/y", type: "http" },
  ]}));
  assert.equal(r.tools.length, 1);
  assert.equal(r.tools[0].url, "https://a.example/x");
  assert.equal(r.warnings.length, 1);
});

test("malformed JSON yields no tools and no corruption", () => {
  const r = parseBuilderTools("{ this is : not json");
  assert.deepEqual(r.tools, []);
  assert.equal(r.endCall, undefined);
});

test("merge: existing configured tool survives a name-only re-import", () => {
  const existing = [{ name: "book_now", displayName: "Book Now", type: "http", enabled: true, source: "livekit-builder", executable: false, method: "POST", url: "https://api.example.com/book", inputSchema: { a: 1 } }];
  const merged = mergeImportedTools(existing, [{ name: "book_now", displayName: "Book Now", type: "imported", enabled: true, source: "livekit-builder", executable: false }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].url, "https://api.example.com/book", "URL survives");
  assert.equal(merged[0].method, "POST");
  assert.deepEqual(merged[0].inputSchema, { a: 1 });
});

test("merge: absent tools are never deleted; new complete tools update in place", () => {
  const existing = [
    { name: "old_tool", displayName: "Old", type: "http", enabled: true, source: "livekit-builder", executable: false, url: "https://old.example/x" },
    { name: "book_now", displayName: "Book Now", type: "http", enabled: true, source: "livekit-builder", executable: false, url: "https://api.example.com/v1" },
  ];
  const merged = mergeImportedTools(existing, [
    { name: "book_now", displayName: "Book Now v2", type: "http", enabled: true, source: "livekit-builder", executable: false, url: "https://api.example.com/v2", method: "POST" },
  ]);
  assert.equal(merged.length, 2, "old_tool not deleted");
  const book = merged.find((t) => t.name === "book_now");
  assert.equal(book.url, "https://api.example.com/v2", "complete import may update");
  assert.equal(book.displayName, "Book Now v2");
});

test("merge: empty strings never overwrite populated values", () => {
  const existing = [{ name: "t", displayName: "T", type: "http", enabled: true, source: "livekit-builder", executable: false, url: "https://x.example/a", description: "does things" }];
  const merged = mergeImportedTools(existing, [{ name: "t", displayName: "", type: "http", enabled: true, source: "livekit-builder", executable: false, url: "", description: "" }]);
  assert.equal(merged[0].url, "https://x.example/a");
  assert.equal(merged[0].description, "does things");
  assert.equal(merged[0].displayName, "T");
});

test("normalizeVoiceSettings carries importedTools + endCall; old blobs without them are untouched", async () => {
  const { normalizeVoiceSettings } = await import("@/lib/agent-config");
  const tools = [{ name: "book_now", displayName: "Book Now", type: "http", enabled: true, source: "livekit-builder", executable: false, url: "https://api.example.com/book" }];
  const endCall = { enabled: true, conditions: "", finalResponse: "restate next steps", deleteRoom: false, summaryUrl: "", summaryHeaders: {} };
  const v = normalizeVoiceSettings({ importedTools: tools, endCall });
  assert.deepEqual(v.importedTools, tools);
  assert.deepEqual(v.endCall, endCall);
  const again = normalizeVoiceSettings(v);
  assert.deepEqual(again.importedTools, tools);
  // backward compatibility: an old blob stays free of the new keys
  const old = normalizeVoiceSettings({ minSpeechDuration: 0.2 });
  assert.equal(old.importedTools, undefined);
  assert.equal(old.endCall, undefined);
});

test("native capabilities and KB fields are outside the tool import surface", async () => {
  const { mergeImportedAgent } = await import("@/lib/livekit-builder-import");
  const existing = { canBook: true, canReschedule: true, canCancel: false, kbFiles: ["a.pdf"], knowledgeBase: "--- a.pdf ---\nfacts" };
  // The importer never places these keys in its update object; even a hostile
  // empty value would be ignored by the merge rules.
  const merged = mergeImportedAgent(existing, { knowledgeBase: "", kbFiles: undefined });
  assert.deepEqual(merged.kbFiles, ["a.pdf"]);
  assert.equal(merged.knowledgeBase, "--- a.pdf ---\nfacts");
  assert.equal(merged.canBook, true);
});

test("normalizeToolName is stable for merge matching", () => {
  assert.equal(normalizeToolName("Book Now"), "book_now");
  assert.equal(normalizeToolName("  End-Call "), "end_call");
});
