// Central Knowledge Base — route wrapper (Phase A4). Pure: the real
// dependencies are bound in knowledge-server.ts; tests inject fakes.
//
//   • authentication + workspace: the existing authorizeRequest (bearer token →
//     user → ACTIVE workspace → membership). The workspace is ALWAYS the
//     session's; nothing in a request body, query or header can change it.
//   • roles: reads — any workspace member (owner, manager, doctor, agent);
//     mutations — owner or manager only (KNOWLEDGE_MANAGER_ROLES).
//   • fail closed: no service role → 503; migration 0065 missing → 503
//     knowledge_migration_missing; anything unexpected → 500 with a generic
//     message (no SQL, credentials or knowledge content).
//   • logging: operation, workspace id, status and error code only — never
//     document text, page bodies or request content.

import { KNOWLEDGE_MANAGER_ROLES } from "@/lib/knowledge";
import { KnowledgeMigrationMissing, type KnowledgeStore, type Outcome, type ExtractFn, type ImportSiteFn } from "@/lib/knowledge-service";
import type { WorkspaceAuthResult } from "@/lib/server-auth";

export type AccessMode = "read" | "write";

export interface KnowledgeRouteDeps {
  /** The existing session authorization (authorizeRequest bound to the request). */
  authorize: () => Promise<WorkspaceAuthResult>;
  serviceRoleConfigured: () => boolean;
  store: KnowledgeStore;
  /** Ingestion bound to the SESSION workspace (A3 libraries). */
  ingest: (workspaceId: string) => { extract: ExtractFn; importSite: ImportSiteFn };
  now: () => Date;
  log?: (line: string) => void;
}

export interface KnowledgeCtx {
  ws: string;
  userId: string;
  role: string;
  store: KnowledgeStore;
  extract: ExtractFn;
  importSite: ImportSiteFn;
  now: () => Date;
  /** Metadata-only log line (never knowledge content). */
  log: (line: string) => void;
}

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status });

export function canManageKnowledge(role: string | null | undefined): boolean {
  return !!role && KNOWLEDGE_MANAGER_ROLES.includes(String(role).toLowerCase());
}

export async function withKnowledge(deps: KnowledgeRouteDeps, mode: AccessMode, op: string, run: (ctx: KnowledgeCtx) => Promise<Outcome>): Promise<Response> {
  const log = deps.log ?? ((line: string) => console.log(line));
  let auth: WorkspaceAuthResult;
  try {
    auth = await deps.authorize();
  } catch {
    auth = { ok: false, status: 401, error: "Sign in first." };
  }
  if (!auth.ok) {
    return json(auth.status, { ok: false, code: auth.status === 401 ? "unauthenticated" : "forbidden", error: auth.error });
  }
  if (mode === "write" && !canManageKnowledge(auth.role)) {
    return json(403, { ok: false, code: "forbidden_role", error: "Only a workspace owner or manager can change the Knowledge Base." });
  }
  if (!deps.serviceRoleConfigured()) {
    return json(503, { ok: false, code: "service_unavailable", error: "The Knowledge Base is unavailable: the server is missing its service configuration." });
  }
  const ws = auth.workspaceId;
  try {
    const { extract, importSite } = deps.ingest(ws);
    const out = await run({ ws, userId: auth.userId, role: auth.role, store: deps.store, extract, importSite, now: deps.now, log });
    if (mode === "write" || out.status >= 500) log(`[knowledge] op=${op} ws=${ws} status=${out.status}${out.body.ok === false ? ` code=${String(out.body.code ?? "")}` : ""}`);
    return json(out.status, out.body);
  } catch (e) {
    if (e instanceof KnowledgeMigrationMissing) {
      log(`[knowledge] op=${op} ws=${ws} status=503 code=knowledge_migration_missing`);
      return json(503, { ok: false, code: "knowledge_migration_missing", error: "The Central Knowledge Base isn't installed yet (migration 0065)." });
    }
    log(`[knowledge] op=${op} ws=${ws} status=500 code=internal_error kind=${e instanceof Error ? e.name : "unknown"}`);
    return json(500, { ok: false, code: "internal_error", error: "Something went wrong with the Knowledge Base request. Reload to check the current state." });
  }
}
