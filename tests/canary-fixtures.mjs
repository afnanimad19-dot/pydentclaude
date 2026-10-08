// Shared OFFLINE fixtures for the canary tests. No HTTP: every fetch is a fake
// that records the request and answers from an in-memory canary catalog.
// (Not a *.test.mjs file, so the runner does not execute it directly.)

/** Minimal environment that passes the canary environment guard. */
export const okEnv = (extra = {}) => ({ HTTPS_PROXY: "http://127.0.0.1:9", NODE_USE_ENV_PROXY: "1", ...extra });

export const FAKE_SENTINEL_TOKEN = "11111111-2222-4333-8444-555555555555";

/** A fetch fake: `respond(body, call)` returns { status, json } or throws. Records every call. */
export function makeFakeFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = { url, init, body: JSON.parse(init.body) };
    calls.push(call);
    const r = await respond(call.body, call);
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof r.text === "string" ? r.text : JSON.stringify(r.json ?? "")),
      json: async () => {
        if (r.unparseable) throw new SyntaxError("bad json");
        return r.json;
      },
    };
  };
  return { fetchImpl, calls };
}

/**
 * In-memory canary catalog answering the preflight's fixed SQL constants.
 * `state` controls what the catalog looks like.
 */
export function makeCanaryCatalog(lib, overrides = {}) {
  const s = {
    role: "supabase_read_only_user",
    txReadOnly: "on",
    defaultReadOnly: "on",
    a7GuardAbsent: true,
    relations: 0,
    functions: 0,
    types: 0,
    historyPresent: true,
    historyRows: 0,
    completedSteps: [],
    pgcrypto: { available: true, installed: true },
    residue: 0,
    sentinel: { schema_present: false, table_present: false },
    // Supabase's permissive defaults, as observed on the canary.
    defaultAcl: [
      { objtype: "S", owner: "postgres", api_role_grantees: "anon,authenticated,service_role" },
      { objtype: "f", owner: "postgres", api_role_grantees: "anon,authenticated,service_role" },
      { objtype: "r", owner: "postgres", api_role_grantees: "anon,authenticated,service_role" },
      { objtype: "r", owner: "supabase_admin", api_role_grantees: "anon,authenticated,service_role" },
    ],
    contract: null,
    ...overrides,
  };
  const { pre, plan, sentinel, manifest } = lib;
  const markerRow = (stepId) => {
    const done = s.completedSteps.includes(stepId);
    const sql = plan.STEP_MARKER_SQL[stepId];
    const cols = [...sql.matchAll(/ as ([a-z0-9_]+)/g)].map((m) => m[1]);
    return Object.fromEntries(cols.map((c) => [c, done]));
  };
  return (body) => {
    const q = body.query;
    if (q === pre.SQL_SESSION)
      return { json: [{ role_name: s.role, session_role: s.role, transaction_read_only: s.txReadOnly, default_transaction_read_only: s.defaultReadOnly, server_version_num: "170011" }] };
    if (q === pre.SQL_IDENTITY) return { json: [{ a7_guard_absent: s.a7GuardAbsent }] };
    if (q === pre.SQL_PUBLIC_INVENTORY) return { json: [{ relations: s.relations, functions: s.functions, types: s.types }] };
    if (q === pre.SQL_HISTORY_TABLE) return { json: [{ present: s.historyPresent }] };
    if (q === pre.SQL_HISTORY_COUNT) return { json: [{ rows: s.historyRows }] };
    for (const stepId of manifest.CANARY_STEP_ORDER) if (q === plan.STEP_MARKER_SQL[stepId]) return { json: [markerRow(stepId)] };
    if (q === pre.SQL_PGCRYPTO) return { json: [s.pgcrypto] };
    if (q === pre.SQL_RESIDUE) return { json: [{ residue: s.residue }] };
    if (q === pre.SQL_POST_MIGRATION_CONTRACT) return { json: s.contract ?? [] };
    if (q === sentinel.SQL_SENTINEL_PRESENCE) return { json: [s.sentinel] };
    if (q === plan.SQL_DEFAULT_ACL_API_ROLE_GRANTS) return { json: s.defaultAcl };
    return { status: 400, text: `unexpected query in fake: ${q.slice(0, 60)}` };
  };
}

export const HARDENED_ACL = [
  { objtype: "f", owner: "postgres", api_role_grantees: "anon,authenticated,service_role" },
  { objtype: "r", owner: "supabase_admin", api_role_grantees: "anon,authenticated,service_role" },
];

export const GOOD_CONTRACT = ["agent_knowledge_resources", "knowledge_chunks", "knowledge_documents", "knowledge_resources"].map((t) => ({
  table_name: t,
  rls: true,
  policies: 0,
  anon_any: false,
  authenticated_any: false,
  service_role_crud: true,
}));
