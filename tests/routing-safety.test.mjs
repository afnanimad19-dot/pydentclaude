// Static guarantees for the reassignment code path and migration 0064:
// the ONLY LiveKit write is an in-place dispatch-rule replace; trunks are never
// written; rules are never created/deleted during reassignment; the migration
// is additive; and nothing here introduces recording or transcript storage.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const src = (p) => fs.readFileSync(path.join(root, p), "utf8");
const REASSIGN_FILES = ["src/lib/number-routing.ts", "src/lib/number-routing-server.ts", "src/lib/number-routing-route.ts", "src/app/api/voice-numbers/[id]/assign/route.ts", "src/app/api/voice-numbers/[id]/routing/route.ts", "src/app/api/voice-numbers/[id]/rollback/route.ts"];

test("reassignment code never creates, deletes or updates a trunk, and never creates/deletes a rule", () => {
  for (const f of REASSIGN_FILES) {
    const s = src(f);
    for (const forbidden of ["createSipInboundTrunk", "createSipOutboundTrunk", "createSipTrunk", "updateSipInboundTrunk", "updateSipInboundTrunkFields", "deleteSipTrunk", "createSipDispatchRule", "deleteSipDispatchRule", "updateSipDispatchRuleFields", "createDispatch", "deleteRoom", "removeParticipant"]) {
      assert.equal(s.includes(forbidden), false, `${f} must not call ${forbidden}`);
    }
  }
  const server = src("src/lib/number-routing-server.ts");
  assert.equal((server.match(/sip\.updateSipDispatchRule\(/g) ?? []).length, 1, "exactly one LiveKit write: the in-place rule replace");
  assert.match(server, /updateSipDispatchRule\(ruleId, SIPDispatchRuleInfo\.fromJson/);
  assert.match(server, /import \{ SIPDispatchRuleInfo \} from "livekit-server-sdk"/, "the SDK's own protocol class, not a different @livekit/protocol copy");
});

test("the LiveKit adapter interface has no trunk-mutation method", () => {
  const s = src("src/lib/number-routing.ts");
  const iface = s.slice(s.indexOf("export interface LivekitRoutingAdapter"), s.indexOf("export interface VapiRoutingAdapter"));
  const methods = [...iface.matchAll(/^\s+(\w+)\(/gm)].map((m) => m[1]).sort();
  assert.deepEqual(methods, ["getInboundTrunk", "getRule", "getRuleRaw", "listDeployedAgents", "listRulesForTrunk", "replaceRule"]);
});

test("no recording / egress / transcript persistence introduced by this change", () => {
  for (const f of [...REASSIGN_FILES, "src/lib/server-auth.ts", "src/lib/server-auth-deps.ts", "src/lib/worker-agent-lookup.ts", "supabase/migrations/0064_voice_number_routing.sql"]) {
    const s = src(f);
    assert.doesNotMatch(s, /startRoomCompositeEgress|EgressClient|MixMonitor|recordCalls\s*[:=]\s*true|transcript/i, f);
  }
});

test("migration 0064 is additive and idempotent", () => {
  const sql = src("supabase/migrations/0064_voice_number_routing.sql");
  const active = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(active, /drop\s+table|drop\s+column|truncate|delete\s+from|alter\s+column[^;]*type/i);
  assert.match(active, /add column if not exists routing_provider/);
  assert.match(active, /create table if not exists public\.voice_number_assignments/);
  assert.match(active, /voice_number_assignments_idem[\s\S]*\(workspace_id, idempotency_key\)/);
  assert.match(active, /voice_numbers_livekit_rule_uniq/);
  assert.match(active, /create trigger voice_numbers_guard_routing/);
  // The only data statement: explicit stored Vapi ids become Vapi-routed; LiveKit is never inferred.
  const updates = active.match(/^update\s[\s\S]*?;/gim) ?? [];
  assert.equal(updates.length, 1);
  assert.match(updates[0], /set routing_provider = 'vapi'[\s\S]*vapi_phone_number_id is not null/);
});
