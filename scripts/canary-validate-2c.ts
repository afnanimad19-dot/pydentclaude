// Pydent Phase 2C CANARY retrieval integration validation CLI.
//
//   NODE_USE_ENV_PROXY=1 node --experimental-strip-types --import ./tests/alias-loader-register.mjs \
//     scripts/canary-validate-2c.ts --confirm-2c=<CANARY_2C_CONFIRMATION_PHRASE>
//
// Order (each refuses before the next): exact 2C confirmation phrase; canary
// environment guard; sentinel authorization; migrated-state gate; residue
// preflight (REFUSES, never cleans); baseline counts; the Step 70 test matrix
// over temporary validation workspaces; finally exact-id-and-name cleanup with
// absence and baseline-restoration verification.
//
// Leg B wiring: the canary's service-role key is fetched at runtime through
// the proxy-authenticated Management API, held in a closure, never read from
// env, never printed; the PostgREST client pins the canary origin and refuses
// redirects. Importing the application functions under test loads
// @/lib/supabase-admin as a module side effect — that client is constructed
// but NEVER used here: the ladder runs exclusively on the injected
// canary-bound matcher and loader below. Reads no .env file, never retries.

import { pathToFileURL } from "node:url";
import { CANARY_PROJECT_REF, CANARY_SERVICE_KEY_ENV, CANARY_SERVICE_KEY_SHAPE, CanaryError, scrubCanaryText } from "./canary-guard";
import { createCanaryReadOnlyTransport } from "./canary-transport";
import { createCanaryWriteProbeTransport, CanaryProbeError } from "./canary-probe-lib";
import {
  createCanaryKbClient,
  createProxyInjectedCanaryKbClient,
  fetchCanaryServiceRoleKey,
  type CanaryKbClient,
  type FetchLike,
} from "./canary-kb-client";
import { Canary2cError, runCanary2cRetrievalValidation } from "./canary-validate-2c-lib";
import {
  parseChunkMatchResponse,
  buildAgentCentralKnowledge,
  type ChunkMatcher,
  type CentralKnowledgeLoader,
  type CentralAssignmentRow,
  type CentralResourceRow,
  type CentralDocumentRow,
} from "@/lib/knowledge-runtime";
import { searchKnowledgeCore, centralRetrievalForReply, ftsQueryFor } from "@/lib/agent-tools-core";

export const CANARY_2C_CONFIRMATION_PHRASE =
  "I-AUTHORIZE-2C-RETRIEVAL-INTEGRATION-TEST-WITH-TEMPORARY-DATA-ON-THE-CANARY-thqjtoxzkujnljsmkwkp";

export function parse2cCliArgs(argv: readonly string[]): void {
  if (argv.length !== 1 || !argv[0].startsWith("--confirm-2c=")) throw new CanaryError("INVALID_ARGS");
  if (argv[0].slice("--confirm-2c=".length) !== CANARY_2C_CONFIRMATION_PHRASE) throw new CanaryError("CONFIRMATION_REQUIRED");
}

/**
 * The Leg B service key (Step 72C). Preference order, FAIL CLOSED at each step:
 *   1. CANARY_SUPABASE_SERVICE_KEY set → it MUST match the sb_secret_ shape
 *      (malformed → refuse outright, never a silent fallback) and MUST NOT
 *      appear in any NEXT_PUBLIC_* value (the sentinel token's exposure rule).
 *      The shape check proves the FORMAT only, never project ownership —
 *      containment stays with the origin-pinned PostgREST client, which can
 *      reach nothing but the canary.
 *   2. Variable absent → the existing Management-API fetch (proxy-side
 *      credential; may be refused by that credential's scope).
 * The returned key is closure-held by the caller and never printed/persisted.
 */
export async function resolveCanaryServiceKey(
  env: Readonly<Record<string, string | undefined>>,
  fetchKey: () => Promise<string>
): Promise<string> {
  const fromEnv = env[CANARY_SERVICE_KEY_ENV];
  if (fromEnv !== undefined && fromEnv !== "") {
    if (!CANARY_SERVICE_KEY_SHAPE.test(fromEnv)) {
      throw new CanaryError("INVALID_ARGS", `${CANARY_SERVICE_KEY_ENV} is not an sb_secret_ key; refusing (no fallback)`);
    }
    for (const [k, v] of Object.entries(env)) {
      if (k.startsWith("NEXT_PUBLIC_") && typeof v === "string" && v.includes(fromEnv)) {
        throw new CanaryError("SENTINEL_TOKEN_EXPOSED", `${CANARY_SERVICE_KEY_ENV} value appears in ${k}`);
      }
    }
    return fromEnv;
  }
  return fetchKey();
}

// ------------------------------------------------------------ Leg B auth mode (Step 72C.8)

export const CANARY_KB_AUTH_ENV = "CANARY_KB_AUTH";
export type CanaryKbAuthMode = "proxy" | "env" | "managed";

/**
 * Explicit Leg B authentication mode:
 *   "proxy"   — application code sends NO credential; the platform's protected
 *               Network secret for the canary host injects the apikey header.
 *               Nothing reads CANARY_SUPABASE_SERVICE_KEY and the Management
 *               API is never asked for a key.
 *   "env"     — CANARY_SUPABASE_SERVICE_KEY is REQUIRED (no silent fallback).
 *   "managed" — the Management-API key fetch, as in Step 71.
 * Unset keeps the Step 72C behaviour: env key when present, else managed.
 * Any other value refuses outright.
 */
export function resolveKbAuthMode(env: Readonly<Record<string, string | undefined>>): CanaryKbAuthMode {
  const v = env[CANARY_KB_AUTH_ENV];
  if (v === undefined || v === "") return env[CANARY_SERVICE_KEY_ENV] ? "env" : "managed";
  if (v === "proxy" || v === "env" || v === "managed") return v;
  throw new CanaryError("INVALID_ARGS", `${CANARY_KB_AUTH_ENV} must be proxy, env or managed`);
}

/** Build the Leg B client for the resolved mode (key paths stay closure-held). */
export async function buildCanaryKb(env: Readonly<Record<string, string | undefined>>, fetchImpl: FetchLike): Promise<{ mode: CanaryKbAuthMode; kb: CanaryKbClient }> {
  const mode = resolveKbAuthMode(env);
  if (mode === "proxy") return { mode, kb: createProxyInjectedCanaryKbClient(fetchImpl) };
  if (mode === "env") {
    const key = await resolveCanaryServiceKey(env, async () => {
      throw new CanaryError("INVALID_ARGS", `${CANARY_KB_AUTH_ENV}=env requires ${CANARY_SERVICE_KEY_ENV}; refusing (no fallback)`);
    });
    return { mode, kb: createCanaryKbClient(key, fetchImpl) };
  }
  return { mode, kb: createCanaryKbClient(await fetchCanaryServiceRoleKey(fetchImpl), fetchImpl) };
}

/** The REAL matcher production shape: PostgREST rpc → the strict Phase 2C parser. */
export function buildCanaryMatcher(client: Pick<CanaryKbClient, "rpcMatchChunks">): ChunkMatcher {
  return async (ws, agentId, query, topK = 8) => {
    if (!ws || !agentId) return { ok: true, searchedChunks: 0, matches: [] };
    const { data, error } = await client.rpcMatchChunks({ ws, agentId, query: String(query ?? ""), topK: Math.max(1, Math.min(Math.trunc(topK) || 8, 20)) });
    if (error) return { ok: false, error: "rpc_failed" };
    return parseChunkMatchResponse(data);
  };
}

/** The runtime loader's exact semantics (Phase 1B), bound to the canary client. */
export function buildCanaryLoader(client: Pick<CanaryKbClient, "selectAssignments" | "selectResources" | "selectReadyDocuments">): CentralKnowledgeLoader {
  return async (ws, agentId) => {
    if (!ws || !agentId) return { assigned: false, knowledge: null };
    let assignments: CentralAssignmentRow[];
    try {
      assignments = (await client.selectAssignments(ws, agentId)).map((r) => ({ resource_id: String(r.resource_id), position: Number(r.position ?? 0) }));
    } catch {
      return { assigned: false, knowledge: null }; // migration state unknowable → legacy keeps the call alive
    }
    if (!assignments.length) return { assigned: false, knowledge: null };
    try {
      const idsList = assignments.map((a) => a.resource_id);
      const [resources, documents] = await Promise.all([client.selectResources(ws, idsList), client.selectReadyDocuments(ws, idsList)]);
      return {
        assigned: true,
        knowledge: buildAgentCentralKnowledge(
          assignments,
          resources as unknown as CentralResourceRow[],
          documents as unknown as CentralDocumentRow[],
        ),
      };
    } catch {
      return { assigned: true, knowledge: null }; // a migrated agent is never handed the stale legacy blob
    }
  };
}

async function main(): Promise<number> {
  try {
    parse2cCliArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof CanaryError ? e.message : "CANARY REFUSED [INVALID_ARGS]");
    console.error("usage: canary-validate-2c --confirm-2c=<exact phrase from scripts/canary-validate-2c.ts>");
    return 1;
  }

  try {
    const readOnlyTransport = createCanaryReadOnlyTransport(process.env);
    const probeTransport = createCanaryWriteProbeTransport(process.env);
    console.log(`CANARY 2C RETRIEVAL VALIDATION — target ${CANARY_PROJECT_REF} (temporary marker-named data; exact-id cleanup; sentinel-gated)`);

    // Leg B: proxy-injected, env-supplied or managed key (never printed), origin-pinned client.
    const fetchImpl = fetch as unknown as FetchLike;
    const { mode, kb } = await buildCanaryKb(process.env, fetchImpl);
    console.log(`leg B auth mode: ${mode}`);

    const report = await runCanary2cRetrievalValidation({
      env: process.env,
      readOnly: readOnlyTransport.executeReadOnlyQuery,
      probe: probeTransport,
      matcher: buildCanaryMatcher(kb),
      loader: buildCanaryLoader(kb),
      app: { searchCore: searchKnowledgeCore, replyRetrieval: centralRetrievalForReply, ftsQuery: ftsQueryFor },
    });
    for (const c of report.checks) console.log(` ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` [${c.detail}]` : ""}`);
    console.log(
      `run ids: w1=${report.runIds.w1} w2=${report.runIds.w2} cleanupOk=${report.cleanupOk}${report.cleanupDetail ? ` cleanupDetail=${report.cleanupDetail}` : ""}`,
    );
    if (report.ok) {
      console.log("CANARY 2C: COMPLETE — all retrieval checks passed and cleanup verified. Run canary-preflight for the independent residue check.");
      return 0;
    }
    console.error("CANARY 2C: FAILED — see the checks above. Any remaining run rows are listed by uuid; recovery needs separate approval.");
    return 1;
  } catch (e) {
    if (e instanceof Canary2cError || e instanceof CanaryProbeError || e instanceof CanaryError) console.error(scrubCanaryText(e.message));
    else console.error(`CANARY 2C: STOPPED [UNEXPECTED_ERROR]: ${e instanceof Error ? e.name : "unknown"}`);
    console.error("CANARY 2C: STOPPED before or during the run. Nothing further was sent.");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
