// LiveKit Inference chat provider: descriptor routing, token shape, and the
// no-cross-provider guarantee. Network is never touched — these tests prove
// the routing decisions and the JWT the gateway would authenticate with.

import { test } from "node:test";
import assert from "node:assert/strict";

const { isLivekitModel, LIVEKIT_MODEL_PREFIX, resilientChat } = await import("@/lib/agent-reply");

test("descriptor convention: only livekit:-prefixed models route to LiveKit", () => {
  assert.equal(isLivekitModel("livekit:xai/grok-4.3"), true);
  assert.equal(isLivekitModel("xai/grok-4.3"), false, "a bare xai/ id is NOT LiveKit — and never direct xAI either");
  assert.equal(isLivekitModel("openai/gpt-4o-mini"), false);
  assert.equal(isLivekitModel(undefined), false);
  assert.equal(LIVEKIT_MODEL_PREFIX, "livekit:");
});

test("livekit model with no credentials fails with a clear LiveKit error — no other provider is tried", async () => {
  delete process.env.LIVEKIT_URL; delete process.env.LIVEKIT_API_KEY; delete process.env.LIVEKIT_API_SECRET;
  await assert.rejects(
    () => resilientChat("some-openrouter-key", "livekit:xai/grok-4.3", { messages: [] }, { agentName: "test" }),
    (e) => {
      assert.match(e.message, /LiveKit/i);
      assert.match(e.message, /no fallback provider was tried/);
      assert.doesNotMatch(e.message, /OpenRouter error|api\.x\.ai/);
      return true;
    }
  );
});

test("the Node inference JWT matches the shape the Python SDK produces", async () => {
  const { AccessToken } = await import("livekit-server-sdk");
  const at = new AccessToken("APIdemo1234", "secretdemo-secretdemo-secretdemo-1234", { identity: "pydent-chat", ttl: 600 });
  at.addInferenceGrant({ perform: true });
  const jwt = await at.toJwt();
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
  // Same claims livekit-agents' create_access_token() sends to the gateway.
  assert.deepEqual(payload.inference, { perform: true });
  assert.equal(payload.iss, "APIdemo1234");
  assert.equal(payload.sub, "pydent-chat");
  assert.ok(payload.exp > Date.now() / 1000);
});
