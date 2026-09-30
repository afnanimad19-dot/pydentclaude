// Agent management — authorization (owner / manager only, server-side) and
// static guarantees: the server binding can only READ LiveKit, never writes a
// number or provider resource, and no unchecked browser delete remains.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { authorizeWorkspaceRequest } = await import("@/lib/server-auth");
const { AGENT_MANAGER_ROLES } = await import("@/lib/agent-management");

const root = path.resolve(import.meta.dirname, "..");
const src = (p) => fs.readFileSync(path.join(root, p), "utf8");
const WS = "aaaaaaaa-0000-4000-8000-00000000000a";
const OTHER = "bbbbbbbb-0000-4000-8000-00000000000b";

function deps(roleByUser, wsByUser = {}) {
  return {
    getUserId: async (t) => (t.startsWith("tok-") ? t.slice(4) : null),
    getActiveWorkspace: async (u) => wsByUser[u] ?? WS,
    getMembershipRole: async (u, ws) => (ws === WS ? roleByUser[u] ?? null : null),
  };
}
const opts = { allowedRoles: AGENT_MANAGER_ROLES, roleError: "Only a workspace owner or manager can rename, duplicate or delete agents." };

test("owner and manager may manage agents; doctor, agent, editor, viewer and admin-invitees may not", async () => {
  const roles = { o: "owner", m: "Manager", d: "doctor", a: "agent", e: "editor", v: "viewer", ad: "admin" };
  const d = deps(roles);
  for (const u of ["o", "m"]) {
    const r = await authorizeWorkspaceRequest(d, `tok-${u}`, opts);
    assert.equal(r.ok, true, u);
    assert.equal(r.workspaceId, WS);
  }
  for (const u of ["d", "a", "e", "v", "ad"]) {
    const r = await authorizeWorkspaceRequest(d, `tok-${u}`, opts);
    assert.equal(r.ok, false, u);
    assert.equal(r.status, 403);
    assert.match(r.error, /owner or manager/);
  }
});

test("unauthenticated or non-member callers are refused; the workspace comes from the session only", async () => {
  assert.equal((await authorizeWorkspaceRequest(deps({}), null, opts)).status, 401);
  assert.equal((await authorizeWorkspaceRequest(deps({ o: "owner" }), "bad", opts)).status, 401);
  // An owner whose ACTIVE workspace is another clinic has no role there → 403.
  const r = await authorizeWorkspaceRequest(deps({ o: "owner" }, { o: OTHER }), "tok-o", opts);
  assert.equal(r.status, 403);
});

test("the existing routing gate is unchanged (owner/admin, not manager)", async () => {
  const d = deps({ o: "owner", m: "manager" });
  assert.equal((await authorizeWorkspaceRequest(d, "tok-o", { requireAdmin: true })).ok, true);
  assert.equal((await authorizeWorkspaceRequest(d, "tok-m", { requireAdmin: true })).ok, false);
});

test("routes use the owner/manager gate and never read a workspace from the request", () => {
  const wrap = src("src/lib/agent-management-route.ts");
  assert.match(wrap, /allowedRoles:\s*AGENT_MANAGER_ROLES/);
  assert.match(wrap, /auth\.workspaceId/);
  for (const r of ["rename", "duplicate", "delete"]) {
    const f = src(`src/app/api/agents/[id]/${r}/route.ts`);
    assert.match(f, /withAgentManagement\(/, r);
    assert.doesNotMatch(f, /body\.(ws|workspace|workspaceId|workspace_id)\b/, `${r} ignores a browser-supplied workspace`);
  }
});

test("agent management never writes to LiveKit, Vapi, numbers, trunks or dispatch rules", () => {
  for (const f of ["src/lib/agent-management.ts", "src/lib/agent-management-server.ts", "src/lib/agent-management-route.ts", "src/components/dashboard/agent-actions.tsx"]) {
    const s = src(f);
    assert.doesNotMatch(
      s,
      /(create|update|delete)Sip(Inbound|Outbound)?(Trunk|DispatchRule)|updateSipDispatchRuleFields|CreateSIP|UpdateSIP|DeleteSIP|createDispatch|deleteRoom\(|api\.vapi\.ai|method:\s*"(PATCH|PUT)"/,
      `${f} has no provider write`
    );
    assert.doesNotMatch(s, /from\("voice_numbers"\)\s*\.(update|insert|delete|upsert)/, `${f} never writes a phone number`);
    assert.doesNotMatch(s, /from\("voice_number_assignments"\)\s*\.(update|insert|delete|upsert)/, `${f} never writes routing audit rows`);
  }
  // The only LiveKit RPC used is the read-only listing.
  const server = src("src/lib/agent-management-server.ts");
  const rpcs = [...server.matchAll(/rpc\.request\(\s*"SIP",\s*"(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(rpcs)], ["ListSIPDispatchRule"]);
  // Agent writes are workspace-scoped.
  for (const op of ["update", "delete"]) {
    const re = new RegExp(`from\\("agents"\\)\\s*\\.${op}\\([^)]*\\)\\s*\\.eq\\("workspace_id", ws\\)`);
    assert.match(server, re, `agents.${op} is scoped by workspace_id`);
  }
});

test("rename writes agents.name only", () => {
  const server = src("src/lib/agent-management-server.ts");
  assert.match(server, /\.update\(\{ name \}\)/);
  assert.equal([...server.matchAll(/from\("agents"\)\s*\.update\(/g)].length, 1, "one agents update, the rename");
});

test("the unchecked browser delete is gone: the card uses the protected menu", () => {
  const db = src("src/lib/db.ts");
  assert.doesNotMatch(db, /from\("agents"\)\.delete\(\)/, "no browser-side agents delete helper");
  const shared = src("src/components/dashboard/agents-shared.tsx");
  assert.doesNotMatch(shared, /deleteAgent/);
  assert.match(shared, /<AgentActionsMenu agent=\{a\}/);
  const menu = src("src/components/dashboard/agent-actions.tsx");
  for (const r of ["rename", "duplicate", "delete"]) assert.match(menu, new RegExp(`/api/agents/\\$\\{agent\\.id\\}/${r}`));
  assert.doesNotMatch(menu, /supabase\.from\(/, "the menu never writes Supabase directly");
});

test("the Nova seeding it guards against is unchanged and still name-based", () => {
  const db = src("src/lib/db.ts");
  assert.match(db, /\/phoenix\|nova\/i\.test\(a\.name\)/, "if this changes, revisit RESERVED_AGENT_NAME");
});

// ---------------------------------------------------------------- Edit form rename bypass
// db.ts binds the production Supabase client at import time, so these checks
// are static rather than executing the browser save functions.

function fnBody(source, header) {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `missing: ${header}`);
  // The body's opening brace is the first "{" that ends a line (return types like
  // Promise<{ ok: boolean }> keep their braces mid-line).
  const open = source.indexOf("{\n", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unterminated: ${header}`);
}

test("saving an EXISTING agent never writes agents.name (updateAgentConfig drops it)", () => {
  const db = src("src/lib/db.ts");
  const cfg = fnBody(db, "export async function updateAgentConfig(");
  assert.match(cfg, /delete row\.name;/);
  assert.match(cfg, /writeAgentRow\(id, row\)/);
  // The legacy updateAgent is unchanged (ensureNovaAgents relies on it) and still includes the name.
  assert.match(fnBody(db, "export async function updateAgent("), /writeAgentRow\(id, agentToRow\(input\)\)/);
  assert.match(fnBody(db, "function agentToRow("), /name: input\.name,/);
});

test("Edit Agent: existing agents save via updateAgentConfig and show the name read-only", () => {
  const shared = src("src/components/dashboard/agents-shared.tsx");
  const save = shared.slice(shared.indexOf("const existingId = initial?.id ?? savedAgentId;"), shared.indexOf("let message = res.message;"));
  assert.match(save, /if \(initial\?\.id\) \{[\s\S]*?updateAgentConfig\(initial\.id, payload\)/, "existing agent → name-free save");
  // updateAgent (with name) is only reachable for a create-retry in the same session, never for `initial`.
  assert.match(save, /\} else if \(existingId\) \{[\s\S]*?updateAgent\(existingId, payload\)/);
  assert.match(save, /\} else \{[\s\S]*?createAgent\(payload\)/, "New Agent still creates with the typed name");
  // The name field: read-only for an existing agent, editable for a new one.
  const field = shared.slice(shared.indexOf('<Field label="Agent name">'), shared.indexOf('<Field label="Agent type">'));
  assert.match(field, /\{initial \? \([\s\S]*?value=\{initial\.name\} readOnly[\s\S]*?Use Rename from the agent actions menu to change the agent name\.[\s\S]*?\) : \([\s\S]*?value=\{form\.name\} onChange=\{\(e\) => set\("name", e\.target\.value\)\}/);
  // LiveKit re-import of an existing agent does not rename it either.
  assert.match(shared, /res = await updateAgentConfig\(alreadyImported\.id, \{/);
  // Exactly one call site of the name-writing updateAgent remains in the UI: the create-retry.
  assert.equal([...shared.matchAll(/await updateAgent\(/g)].length, 1);
});

test("no browser code writes agents.name except New Agent creation and the Nova seeding", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(e.name) && !rel.startsWith(path.join("src", "app", "api")) && !/-server\.ts$/.test(e.name)) {
        const s = src(rel);
        if (/from\("agents"\)\s*\.update\(\s*\{[^}]*\bname\b/.test(s)) offenders.push(rel);
      }
    }
  };
  walk("src");
  assert.deepEqual(offenders, []);
  // updateAgent (which includes the name) is only called by the create-retry and ensureNovaAgents.
  const callers = [];
  const walk2 = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk2(rel);
      else if (/\.(ts|tsx)$/.test(e.name)) for (const m of src(rel).matchAll(/\bupdateAgent\(/g)) callers.push(rel + ":" + m.index);
    }
  };
  walk2("src");
  const files = [...new Set(callers.map((c) => c.split(":")[0]))].sort();
  assert.deepEqual(files, [path.join("src", "components", "dashboard", "agents-shared.tsx"), path.join("src", "lib", "db.ts")]);
});

test("the Rename dialog blocks the seeded Nova up front", () => {
  const menu = src("src/components/dashboard/agent-actions.tsx");
  assert.match(menu, /const systemManaged = isSystemManagedNova\(agent\);/);
  assert.match(menu, /label="Rename" busy=\{busy\} disabled=\{systemManaged\}/);
  assert.match(src("src/lib/agent-management.ts"), /Nova is a system-managed agent and cannot be renamed\./);
});
