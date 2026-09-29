import { SIPDispatchRuleInfo } from "livekit-server-sdk";

// SDK-aware semantics for LiveKit SIP dispatch rules (used by the guarded
// number-routing transaction in lib/number-routing.ts).
//
// Why this exists: Pydent changes the dispatched agent with a FULL replace
// (UpdateSIPDispatchRule, action = replace). A replace can only preserve what
// this server's LiveKit SDK can represent, so before any write we must prove
// the rule round-trips, and after the write we must prove nothing else moved.
//
//  • Representability — the provider's RAW JSON is parsed with the SDK's own
//    SIPDispatchRuleInfo in STRICT mode (ignoreUnknownFields is NOT enabled).
//    Anything the SDK does not model makes the parse throw → fail closed.
//    Default values in any spelling the SDK accepts (enum zero values by name
//    such as JRP_ON_FAILURE / SIP_MEDIA_ENCRYPT_DISABLE, snake_case or
//    camelCase keys, numbers as strings, timestamps) are representable: they
//    parse, and writing them back as omitted defaults means the same thing.
//
//  • Semantic comparison — rules are compared in the SDK's canonical form
//    (strict parse → toJson), so spelling differences never count as changes,
//    and provider-managed fields (createdAt / updatedAt, which LiveKit bumps on
//    every write) are excluded. semanticDiff() returns the exact field paths
//    that differ, so callers can require "only these paths may change".

/* eslint-disable @typescript-eslint/no-explicit-any */

export type RuleJson = Record<string, any>;

/** Set and maintained by LiveKit itself; never compared, never written back. */
export const PROVIDER_MANAGED_FIELDS: readonly string[] = ["createdAt", "updatedAt"];

export type Representability =
  | { ok: true; normalized: RuleJson }
  | { ok: false; unknownKey: string; reason: string };

/** Strictly parse a raw provider rule with the SDK. Unknown fields fail closed. */
export function checkRuleRepresentable(raw: unknown): Representability {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, unknownKey: "", reason: "The provider returned no raw rule to verify." };
  }
  try {
    const msg = SIPDispatchRuleInfo.fromJson(raw as any); // strict: NO ignoreUnknownFields
    return { ok: true, normalized: msg.toJson() as RuleJson };
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    const key = /key "([^"]+)"/.exec(text)?.[1] ?? "";
    return { ok: false, unknownKey: key, reason: text.slice(0, 200) };
  }
}

/** A deep copy without provider-managed fields (safe to write back). */
export function stripProviderManaged(rule: RuleJson): RuleJson {
  const copy = JSON.parse(JSON.stringify(rule ?? {}));
  for (const f of PROVIDER_MANAGED_FIELDS) delete copy[f];
  return copy;
}

/** The SDK-canonical form of a rule, without provider-managed fields. Throws on unknown fields. */
export function normalizeRule(rule: RuleJson): RuleJson {
  return stripProviderManaged(SIPDispatchRuleInfo.fromJson(rule as any).toJson() as RuleJson);
}

function diffInto(a: any, b: any, path: string, out: string[]) {
  if (a === b) return;
  const aObj = a !== null && typeof a === "object";
  const bObj = b !== null && typeof b === "object";
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) diffInto(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  if (aObj && bObj && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) diffInto(a[k], b[k], path ? `${path}.${k}` : k, out);
    return;
  }
  out.push(path || "(root)");
}

/** Field paths (e.g. "roomConfig.agents[0].agentName") that differ semantically. */
export function semanticDiff(a: RuleJson, b: RuleJson): string[] {
  const out: string[] = [];
  diffInto(normalizeRule(a), normalizeRule(b), "", out);
  return out;
}

/** True when both rules are semantically identical (unparseable input → false). */
export function sameRuleSemantics(a: RuleJson | null | undefined, b: RuleJson | null | undefined): boolean {
  if (!a || !b) return false;
  try {
    return semanticDiff(a, b).length === 0;
  } catch {
    return false;
  }
}
