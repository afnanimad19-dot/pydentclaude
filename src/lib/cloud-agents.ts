// LiveKit Cloud agent listing — host derivation + STRICT response parsing.
//
// Verified against the official Go SDK (server-sdk-go/agent_client.go and
// pkg/cloudagents/*): the CloudAgent Twirp service is NOT served on the
// project host. NewAgentClient rewrites the project URL with the regex
// ^https?://[^.]+\.  →  https://agents.   so
//   wss://<project>.livekit.cloud  →  https://agents.livekit.cloud
// (global GeoDNS host; the project is identified by the API key inside the
// JWT, whose claims are a standard access token with agent: {admin: true} —
// exactly what livekit.ts mints). Requests to the PROJECT host's
// /twirp/livekit.CloudAgent/* path are answered by a catch-all "200 OK" that
// is not JSON — which is why parsing must be strict: a non-JSON or malformed
// body must surface as an ERROR, never dissolve into "no agents deployed".
//
// Pure module (no network, no imports) so every branch is unit-testable.

export interface CloudAgentInfo {
  agentId: string;
  agentName: string;
  version: string;
  status: string;
  deployedAt: string | null;
}

// wss://x.livekit.cloud → https://agents.livekit.cloud (same rewrite the Go
// SDK performs; localhost-style URLs pass through untouched for dev setups).
export function cloudAgentsHost(projectUrl: string): string {
  const u = String(projectUrl ?? "").trim().replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://").replace(/\/+$/, "");
  try {
    const host = new URL(u).hostname;
    if (host === "localhost" || host === "127.0.0.1") return u;
  } catch {
    return u;
  }
  return u.replace(/^https?:\/\/[^.]+\./i, "https://agents.");
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapAgent(a: any): CloudAgentInfo {
  const deps: any[] = a.agentDeployments ?? a.agent_deployments ?? [];
  const status = deps.map((d) => d.status ?? "").filter(Boolean).join(", ");
  const dep = a.deployedAt ?? a.deployed_at;
  return {
    agentId: String(a.agentId ?? a.agent_id ?? ""),
    agentName: String(a.agentName ?? a.agent_name ?? ""),
    version: String(a.version ?? ""),
    status: status || "unknown",
    deployedAt: dep ? (typeof dep === "string" ? dep : new Date(Number(dep.seconds ?? 0) * 1000).toISOString()) : null,
  };
}

// Strict ListAgents response handling:
//  - non-2xx            → throw (Twirp error text included)
//  - body not JSON      → throw ("answered non-JSON") — the catch-all case
//  - body not an object → throw
//  - agents present but not an array → throw
//  - agents absent OR [] → genuinely empty list (proto3 JSON omits empty
//    repeated fields, so {} is a legitimate "no agents" answer from the REAL
//    service — only reachable after status/JSON checks passed)
export function parseListAgents(status: number, bodyText: string): CloudAgentInfo[] {
  if (status < 200 || status >= 300) {
    throw new Error(`ListAgents ${status}: ${String(bodyText ?? "").slice(0, 200)}`);
  }
  let data: any;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error(`ListAgents answered non-JSON (are these credentials for a LiveKit Cloud project?): ${String(bodyText ?? "").slice(0, 80)}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("ListAgents answered JSON that is not an object.");
  }
  const agents = data.agents ?? data.Agents;
  if (agents === undefined || agents === null) return [];
  if (!Array.isArray(agents)) throw new Error("ListAgents 'agents' field is not an array.");
  return agents.map(mapAgent);
}
/* eslint-enable @typescript-eslint/no-explicit-any */
