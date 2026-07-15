import { NextRequest, NextResponse } from "next/server";
import { getHfxCreds, hfxCall, hfxConfigured, type HfxCreds } from "@/lib/hyperfx";
import { META_STRATEGIES, objectiveFor } from "@/lib/meta-strategies";

// Campaign/ad-set management — the ONLY write path to Meta ads from the UI.
// Every action is explicitly whitelisted and triggered by a user click behind a
// confirm step in the Ads tab (the generic /api/hyperfx/call stays read-only).
// Budgets arrive in DOLLARS from the UI and are converted to Meta's cents here.
export const runtime = "nodejs";
export const maxDuration = 120;

/* eslint-disable @typescript-eslint/no-explicit-any */

const toCents = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : undefined;
};

// Resolve interest keywords to Meta interest ids (best-effort; misses are skipped).
async function resolveInterests(creds: HfxCreds, keywords: string[], cache: Map<string, { id: string; name: string } | null>): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  for (const kw of keywords.slice(0, 3)) {
    if (!cache.has(kw)) {
      const r = await hfxCall("meta_business_targeting_search", { search_type: "adinterest", q: kw, limit: 1, detail: "core" }, creds);
      const rows: any[] = r.ok ? (Array.isArray(r.data) ? r.data : (r.data as any)?.data ?? (r.data as any)?.results ?? []) : [];
      const hit = rows[0];
      cache.set(kw, hit?.id ? { id: String(hit.id), name: String(hit.name ?? kw) } : null);
    }
    const v = cache.get(kw);
    if (v) out.push(v);
  }
  return out;
}

// Execute a named strategy: create the campaign, then its ad sets with resolved
// targeting (city radius or country, age band, interests). Ad sets are created
// PAUSED; only the campaign status follows the user's live/paused choice.
async function createCampaignStrategy(creds: HfxCreds, body: any): Promise<{ status: number; data: unknown }> {
  const accountId = String(body.account_id ?? "");
  const objective = objectiveFor(String(body.objective ?? ""));
  if (!accountId || !objective) return { status: 400, data: { error: "account_id and a valid objective are required." } };

  const strategy = META_STRATEGIES.find((s) => s.key === body.strategy_key) ?? null;
  const name = String(body.name ?? strategy?.name ?? "New campaign").slice(0, 120);
  const budgetCents = toCents(body.daily_budget) ?? 1000;
  const numAdSets = Math.max(1, Math.min(Number(body.num_ad_sets) || (strategy?.adSets.length ?? 1), strategy?.adSets.length ?? 3));
  const status = body.status === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const countryCode = String(body.country_code ?? "AE").toUpperCase().slice(0, 2);
  const city = String(body.city ?? "").trim();

  // 1 — the campaign (budget lives on the ad sets).
  const camp = await hfxCall("meta_business_create_campaign", { account_id: accountId, name, objective: objective.key, status, special_ad_categories: [] }, creds);
  if (!camp.ok) return { status: 502, data: { error: `Campaign creation failed: ${camp.error}` } };
  const campaignId = String((camp.data as any)?.id ?? (camp.data as any)?.campaign_id ?? "");
  if (!campaignId) return { status: 502, data: { error: "Campaign created but Meta returned no id.", raw: camp.data } };

  // 2 — geo: city radius when given, else the whole country.
  let geo: Record<string, unknown> = { countries: [countryCode] };
  if (city) {
    const g = await hfxCall("meta_business_targeting_search", { search_type: "adgeolocation", q: city, location_types: ["city"], country_code: countryCode, limit: 1, detail: "core" }, creds);
    const rows: any[] = g.ok ? (Array.isArray(g.data) ? g.data : (g.data as any)?.data ?? []) : [];
    if (rows[0]?.key) geo = { cities: [{ key: String(rows[0].key), radius: 15, distance_unit: "kilometer" }] };
  }

  // 3 — ad sets from the strategy plan (or one generic set).
  const plan = (strategy?.adSets ?? [{ name: "Ad set 1", angle: "", interests: [], ageMin: 20, ageMax: 60 }]).slice(0, numAdSets);
  const cache = new Map<string, { id: string; name: string } | null>();
  const created: { name: string; ok: boolean; error?: string }[] = [];
  for (const as of plan) {
    const interests = await resolveInterests(creds, as.interests, cache);
    const base: Record<string, unknown> = {
      mode: "manual",
      account_id: accountId,
      campaign_id: campaignId,
      name: `${name} — ${as.name}`,
      billing_event: objective.billing,
      daily_budget: budgetCents,
      status: "PAUSED",
      age_min: as.ageMin,
      age_max: as.ageMax,
      geo_locations: geo,
      ...(interests.length ? { interests } : {}),
    };
    let r = await hfxCall("meta_business_create_ad_set", { ...base, optimization_goal: objective.optimization }, creds);
    if (!r.ok && objective.fallbackOptimization !== objective.optimization) {
      // e.g. LEAD_GENERATION needs a page/pixel — fall back to high-intent clicks.
      r = await hfxCall("meta_business_create_ad_set", { ...base, optimization_goal: objective.fallbackOptimization }, creds);
    }
    created.push({ name: as.name, ok: r.ok, error: r.ok ? undefined : String(r.error ?? "").slice(0, 300) });
  }

  const okCount = created.filter((c) => c.ok).length;
  return {
    status: 200,
    data: {
      ok: true,
      campaignId,
      campaignStatus: status,
      adsets: created,
      summary: `Campaign "${name}" created (${status.toLowerCase()}). Ad sets: ${okCount}/${created.length} created (paused). Add creatives via Helena or the Ads tab, then activate.`,
    },
  };
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const creds = await getHfxCreds(body.ws ?? null);
  if (!hfxConfigured(creds)) return NextResponse.json({ error: "Marketing engine not configured." }, { status: 400 });

  const action = String(body.action ?? "");

  // Per-clinic autopilot toggle (stored on hyperfx_config; empty mcp_url rows
  // still fall back to env credentials, so this never breaks the connection).
  if (action === "set_auto_recommendations") {
    const ws = String(body.ws ?? "");
    if (!ws) return NextResponse.json({ error: "ws required." }, { status: 400 });
    const { supabaseAdmin } = await import("@/lib/supabase-admin");
    const { data: existing } = await supabaseAdmin.from("hyperfx_config").select("workspace_id").eq("workspace_id", ws).maybeSingle();
    const { error } = existing
      ? await supabaseAdmin.from("hyperfx_config").update({ auto_recommendations: !!body.enabled }).eq("workspace_id", ws)
      : await supabaseAdmin.from("hyperfx_config").insert({ workspace_id: ws, mcp_url: "", api_key: "", auto_recommendations: !!body.enabled });
    if (error) return NextResponse.json({ error: /auto_recommendations/.test(error.message) ? "Run migration 0053_ads_autopilot.sql in Supabase first." : error.message }, { status: 500 });
    return NextResponse.json({ ok: true, enabled: !!body.enabled });
  }

  // The strategy executor is a multi-step flow, handled separately.
  if (action === "create_campaign_strategy") {
    const r = await createCampaignStrategy(creds, body);
    return NextResponse.json(r.data as any, { status: r.status });
  }

  let tool = "";
  let args: Record<string, unknown> = {};

  switch (action) {
    case "create_campaign": {
      if (!body.account_id || !body.name || !body.objective) return NextResponse.json({ error: "account_id, name and objective are required." }, { status: 400 });
      tool = "meta_business_create_campaign";
      args = {
        account_id: String(body.account_id),
        name: String(body.name),
        objective: String(body.objective),
        status: body.status === "ACTIVE" ? "ACTIVE" : "PAUSED", // default PAUSED — nothing spends without an explicit choice
        special_ad_categories: Array.isArray(body.special_ad_categories) ? body.special_ad_categories : [],
      };
      const db = toCents(body.daily_budget);
      if (db) args.daily_budget = db;
      break;
    }
    case "update_campaign": {
      if (!body.campaign_id) return NextResponse.json({ error: "campaign_id required." }, { status: 400 });
      tool = "meta_business_update_campaign";
      args = { campaign_id: String(body.campaign_id) };
      if (body.name) args.name = String(body.name);
      if (body.status) args.status = String(body.status);
      const db = toCents(body.daily_budget);
      if (db) args.daily_budget = db;
      break;
    }
    case "delete_campaign": {
      if (!body.campaign_id) return NextResponse.json({ error: "campaign_id required." }, { status: 400 });
      tool = "meta_business_delete_campaign";
      args = { campaign_id: String(body.campaign_id) };
      break;
    }
    case "update_ad_set": {
      if (!body.ad_set_id) return NextResponse.json({ error: "ad_set_id required." }, { status: 400 });
      tool = "meta_business_update_ad_set";
      args = { ad_set_id: String(body.ad_set_id) };
      if (body.name) args.name = String(body.name);
      if (body.status) args.status = String(body.status);
      const db = toCents(body.daily_budget);
      if (db) args.daily_budget = db;
      break;
    }
    case "delete_ad_set": {
      if (!body.ad_set_id) return NextResponse.json({ error: "ad_set_id required." }, { status: 400 });
      tool = "meta_business_delete_ad_set";
      args = { ad_set_id: String(body.ad_set_id) };
      break;
    }
    case "update_ad": {
      if (!body.ad_id) return NextResponse.json({ error: "ad_id required." }, { status: 400 });
      tool = "meta_business_update_ad";
      args = { ad_id: String(body.ad_id) };
      if (body.name) args.name = String(body.name);
      if (body.status) args.status = String(body.status);
      break;
    }
    default:
      return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
  }

  const r = await hfxCall(tool, args, creds);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
  return NextResponse.json({ ok: true, data: r.data });
}
