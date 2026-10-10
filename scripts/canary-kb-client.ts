// Pydent Phase 2C CANARY PostgREST client (Leg B) — the only canary file,
// beside the two Management-API transports, that performs network I/O, and
// the ONLY canary file permitted to set an Authorization header.
//
// Why it exists: Leg B of the 2C validation exercises the exact seam
// production uses — PostgREST `rpc/knowledge_match_chunks` and the runtime
// loader's three reads — which the session proxy does NOT authenticate. The
// canary's own service-role key is therefore fetched AT RUNTIME through the
// proxy-authenticated Management API (`/api-keys`), held in a closure, and:
//   * never read from env or any .env file,
//   * never logged, persisted, exported or included in error text,
//   * usable only against the pinned canary origin below.
// Every request pins the canary origin, refuses redirects outright
// (`redirect: "error"`), re-checks the response URL's origin, and runs the
// forbidden-ref assertion on every path. HTTP error bodies are never attached
// to thrown errors (they could echo SQL or knowledge content) — only status
// codes travel.

import { CANARY_PROJECT_REF, CanaryError, assertNoForbiddenRef } from "./canary-guard";

export const CANARY_POSTGREST_ORIGIN = `https://${CANARY_PROJECT_REF}.supabase.co`;
/** reveal=true: new-style secret keys are returned redacted without it. */
export const CANARY_API_KEYS_ENDPOINT = `https://api.supabase.com/v1/projects/${CANARY_PROJECT_REF}/api-keys?reveal=true`;

export type FetchResponseLike = {
  ok: boolean;
  status: number;
  url?: string;
  json: () => Promise<unknown>;
};
export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<FetchResponseLike>;

type Row = Record<string, unknown>;
const rowsOf = (v: unknown): Row[] => (Array.isArray(v) ? v.filter((r): r is Row => typeof r === "object" && r !== null) : []);

/**
 * Fetch the canary's service-role API key through the Management API (the
 * proxy injects the credential; this module sends none for this call). The
 * returned key lives only in the caller's closure — callers MUST NOT log it.
 */
export async function fetchCanaryServiceRoleKey(fetchImpl: FetchLike): Promise<string> {
  assertNoForbiddenRef(CANARY_API_KEYS_ENDPOINT, "api-keys endpoint");
  const res = await fetchImpl(CANARY_API_KEYS_ENDPOINT, { method: "GET", redirect: "error", headers: { Accept: "application/json" } });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new CanaryError("AUTH_REJECTED", `api-keys HTTP ${res.status}`);
    throw new CanaryError("TRANSPORT_HTTP_ERROR", `api-keys HTTP ${res.status}`);
  }
  const rows = rowsOf(await res.json());
  const svc = rows.find((r) => String(r.name ?? r.id ?? "") === "service_role");
  const key = typeof svc?.api_key === "string" ? svc.api_key.trim() : "";
  if (!key) throw new CanaryError("RESULT_MALFORMED", "api-keys response carries no service_role api_key");
  return key;
}

/** The three loader reads plus the rpc — everything Leg B is allowed to do. */
export interface CanaryKbClient {
  rpcMatchChunks: (args: { ws: string; agentId: string; query: string; topK: number }) => Promise<{ data: unknown; error: { message: string } | null }>;
  selectAssignments: (ws: string, agentId: string) => Promise<Row[]>;
  selectResources: (ws: string, ids: readonly string[]) => Promise<Row[]>;
  selectReadyDocuments: (ws: string, ids: readonly string[]) => Promise<Row[]>;
}

const enc = encodeURIComponent;

export function createCanaryKbClient(serviceRoleKey: string, fetchImpl: FetchLike): CanaryKbClient {
  if (!serviceRoleKey || typeof serviceRoleKey !== "string") throw new CanaryError("INVALID_ARGS", "missing service key");
  // Closure-held only; no property exposes it.
  const baseHeaders = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  const request = async (path: string, init: { method: string; body?: string }): Promise<FetchResponseLike> => {
    assertNoForbiddenRef(path, "postgrest path");
    if (!path.startsWith("/rest/v1/")) throw new CanaryError("ENDPOINT_MISMATCH", "postgrest path outside /rest/v1/");
    const url = `${CANARY_POSTGREST_ORIGIN}${path}`;
    const res = await fetchImpl(url, { ...init, headers: baseHeaders, redirect: "error" });
    // Belt: even a same-status rewrite to another origin is refused.
    if (typeof res.url === "string" && res.url !== "" && !res.url.startsWith(`${CANARY_POSTGREST_ORIGIN}/`)) {
      throw new CanaryError("ENDPOINT_MISMATCH", "response origin is not the canary origin");
    }
    return res;
  };

  const selectRows = async (path: string, context: string): Promise<Row[]> => {
    const res = await request(path, { method: "GET" });
    if (!res.ok) throw new CanaryError("TRANSPORT_HTTP_ERROR", `${context} HTTP ${res.status}`);
    return rowsOf(await res.json());
  };

  const idList = (ids: readonly string[]): string => `in.(${ids.map((i) => enc(String(i))).join(",")})`;

  const client: CanaryKbClient = {
    async rpcMatchChunks({ ws, agentId, query, topK }) {
      try {
        const res = await request("/rest/v1/rpc/knowledge_match_chunks", {
          method: "POST",
          body: JSON.stringify({ p_workspace_id: ws, p_agent_id: agentId, p_query: query, p_top_k: topK }),
        });
        if (!res.ok) return { data: null, error: { message: `rpc HTTP ${res.status}` } };
        return { data: await res.json(), error: null };
      } catch (e) {
        // Status/code only — never a response body, never the key.
        return { data: null, error: { message: e instanceof CanaryError ? e.message : "rpc request failed" } };
      }
    },
    selectAssignments: (ws, agentId) =>
      selectRows(`/rest/v1/agent_knowledge_resources?select=resource_id,position&workspace_id=eq.${enc(ws)}&agent_id=eq.${enc(agentId)}`, "assignments"),
    selectResources: (ws, ids) =>
      selectRows(`/rest/v1/knowledge_resources?select=id,name&workspace_id=eq.${enc(ws)}&id=${idList(ids)}`, "resources"),
    selectReadyDocuments: (ws, ids) =>
      selectRows(
        `/rest/v1/knowledge_documents?select=id,resource_id,filename,source_url,content,position&workspace_id=eq.${enc(ws)}&resource_id=${idList(ids)}&status=eq.ready`,
        "documents",
      ),
  };
  return Object.freeze(client);
}
