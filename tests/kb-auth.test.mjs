// /api/kb/* authorization: signed-in workspace member required, workspace from
// the session only, and no cross-workspace knowledge. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { withKbAuth, kbRetrievalDebug } = await import("@/lib/kb-auth");
const { authorizeWorkspaceRequest } = await import("@/lib/server-auth");

const root = path.resolve(import.meta.dirname, "..");
const src = (p) => fs.readFileSync(path.join(root, p), "utf8");
const WS = "aaaaaaaa-0000-4000-8000-00000000000a";
const OTHER = "bbbbbbbb-0000-4000-8000-00000000000b";

const authDeps = {
  getUserId: async (t) => ({ "tok-member": "u1", "tok-outsider": "u2" })[t] ?? null,
  getActiveWorkspace: async (u) => ({ u1: WS, u2: OTHER })[u] ?? null,
  getMembershipRole: async (u, ws) => (u === "u1" && ws === WS ? "doctor" : null),
};
const authorize = (token) => () => authorizeWorkspaceRequest(authDeps, token);

async function call(token, handler) {
  let ran = null;
  const res = await withKbAuth(authorize(token), async (ctx) => {
    ran = ctx;
    return handler ? handler(ctx) : Response.json({ ok: true, ws: ctx.workspaceId });
  });
  return { res, ran, body: await res.json() };
}

test("unauthenticated requests are rejected with 401 and the handler never runs", async () => {
  for (const token of [null, "", "tok-forged"]) {
    const { res, ran, body } = await call(token);
    assert.equal(res.status, 401);
    assert.equal(ran, null);
    assert.equal(body.ok, false);
  }
  // A throwing authorizer fails closed too.
  const res = await withKbAuth(async () => { throw new Error("db down"); }, async () => Response.json({ ok: true }));
  assert.equal(res.status, 401);
});

test("a non-member is refused (403); a member of any role is accepted with the SESSION workspace", async () => {
  const outsider = await call("tok-outsider");
  assert.equal(outsider.res.status, 403);
  assert.equal(outsider.ran, null);
  const member = await call("tok-member");
  assert.equal(member.res.status, 200);
  assert.equal(member.ran.workspaceId, WS);
});

test("a workspace supplied in the body cannot override the session workspace", async () => {
  // The handler receives the session workspace no matter what the body says.
  const bodyWs = OTHER;
  const { ran } = await call("tok-member", (ctx) => Response.json({ used: ctx.workspaceId, bodyWs }));
  assert.equal(ran.workspaceId, WS);
  assert.notEqual(ran.workspaceId, bodyWs);
});

const agents = [
  { id: "11111111-0000-4000-8000-000000000001", name: "Laura", workspace_id: WS, knowledge_base: "--- prices.pdf ---\nCleaning AED 300.", kb_files: ["prices.pdf"] },
  { id: "22222222-0000-4000-8000-000000000002", name: "Laura", workspace_id: OTHER, knowledge_base: "--- secret.pdf ---\nOther clinic secret.", kb_files: ["secret.pdf"] },
];
const findAgent = async (ws, key) => agents.find((a) => a.workspace_id === ws && (key.id ? a.id === key.id : a.name.toLowerCase() === String(key.name).toLowerCase())) ?? null;

test("retrieval-debug: own workspace works", async () => {
  const out = await kbRetrievalDebug(findAgent, { workspaceId: WS, agentKey: "laura", q: "cleaning price" });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.kbFiles, ["prices.pdf"]);
});

test("retrieval-debug: another workspace's agent or ws is refused and nothing leaks", async () => {
  // By id of the other clinic's agent → not found (lookup is session-scoped).
  const byId = await kbRetrievalDebug(findAgent, { workspaceId: WS, agentKey: agents[1].id, q: "secret" });
  assert.equal(byId.status, 404);
  assert.ok(!JSON.stringify(byId.body).includes("Other clinic secret"));
  // Asking for the other workspace explicitly → 403.
  const explicit = await kbRetrievalDebug(findAgent, { workspaceId: WS, requestedWs: OTHER, agentKey: "laura", q: "secret" });
  assert.equal(explicit.status, 403);
  // Same name in both workspaces → only ours.
  const same = await kbRetrievalDebug(findAgent, { workspaceId: WS, agentKey: "Laura", q: "secret" });
  assert.ok(!JSON.stringify(same.body).includes("secret.pdf"));
  // A store that wrongly returns a foreign row is still refused.
  const leaky = await kbRetrievalDebug(async () => agents[1], { workspaceId: WS, agentKey: "x", q: "secret" });
  assert.equal(leaky.status, 404);
});

test("every /api/kb route is wrapped in withKbAuth and never reads a workspace from the request", () => {
  for (const r of ["extract", "website", "retrieval-debug"]) {
    const s = src(`src/app/api/kb/${r}/route.ts`);
    assert.match(s, /withKbAuth\(\(\) => authorizeRequest\(req\)/, r);
    assert.doesNotMatch(s, /\{\s*url,\s*ws\s*\}|body\.ws\b|searchParams\.get\("ws"\)\s*\?\?/, `${r} does not trust a request workspace`);
  }
  // retrieval-debug only uses ?ws= to REFUSE a mismatch.
  assert.match(src("src/app/api/kb/retrieval-debug/route.ts"), /requestedWs: sp\.get\("ws"\)/);
  // The website importer validates the target before any fetch / hand-off.
  const web = src("src/app/api/kb/website/route.ts");
  const guard = web.indexOf("await assertSafeUrl(target)");
  assert.ok(guard > 0);
  assert.ok(guard < web.indexOf("firecrawlCrawl(target"), "before Firecrawl");
  assert.ok(guard < web.indexOf("fetchText(target)"), "before the direct fetch");
  assert.doesNotMatch(web, /await fetch\(url/, "no unguarded fetch of a user URL");
});

test("every browser caller of /api/kb sends the session token (authFetch), FormData keeps its multipart header", () => {
  for (const f of ["src/components/dashboard/agents-shared.tsx", "src/app/dashboard/agents/campaigns/page.tsx", "src/app/dashboard/social/brand/page.tsx", "src/app/dashboard/team-ai/page.tsx", "src/lib/db.ts"]) {
    const s = src(f);
    assert.doesNotMatch(s, /(?<![A-Za-z])fetch\("\/api\/kb\//, `${f} uses authFetch`);
    assert.match(s, /authFetch\("\/api\/kb\//, f);
  }
  assert.match(src("src/lib/auth-fetch.ts"), /init\.body instanceof FormData/);
});

test("the editor removes a file's knowledge and replaces same-named files via the tested helper", () => {
  const s = src("src/components/dashboard/agents-shared.tsx");
  assert.match(s, /knowledgeBase: removeKbSection\(f\.knowledgeBase \?\? "", name\)/);
  assert.match(s, /knowledgeBase: composeKnowledge\(form\.knowledgeBase \?\? "", fileTexts, form\.kbFiles\)/);
  assert.doesNotMatch(s, /if \(form\.kbFiles\.includes\(file\.name\)\) continue;/, "same-named uploads are no longer skipped");
  assert.match(s, /if \(replacing && isFailedExtraction\(text\)\)/);
});
