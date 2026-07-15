import { NextRequest, NextResponse } from "next/server";
import { getHfxCreds, hfxCall, hfxConfigured, type HfxCreds } from "@/lib/hyperfx";
import { META_STRATEGIES, objectiveFor, conversionById, MESSAGING_APPS } from "@/lib/meta-strategies";

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

// Best-effort: the account's first owned Page id (needed for messaging/leadgen
// destinations and for ad creatives).
async function resolvePageId(creds: HfxCreds): Promise<string> {
  for (const tool of ["meta_business_list_owned_pages", "meta_business_get_meta_accounts"]) {
    const r = await hfxCall(tool, {}, creds);
    if (!r.ok) continue;
    const rows: any[] = Array.isArray(r.data) ? r.data : ((r.data as any)?.pages ?? (r.data as any)?.data ?? (r.data as any)?.accounts ?? []);
    const id = rows[0]?.id ?? rows[0]?.page_id;
    if (id) return String(id);
  }
  return "";
}

// Build Meta geo targeting from the wizard's include/exclude area lists.
function buildGeo(areas: any[], countryCode: string): Record<string, unknown> {
  const geo: Record<string, unknown> = {};
  const add = (bucket: string, val: unknown) => {
    if (!Array.isArray(geo[bucket])) geo[bucket] = [];
    (geo[bucket] as any[]).push(val);
  };
  for (const a of Array.isArray(areas) ? areas : []) {
    const type = String(a.type ?? "").toLowerCase();
    const key = String(a.key ?? "");
    if (!key) continue;
    if (type === "country") add("countries", key.length === 2 ? key.toUpperCase() : key);
    else if (type === "region") add("regions", { key });
    else if (type === "city") add("cities", { key, radius: Number(a.radius) || 15, distance_unit: "kilometer" });
    else if (type === "zip") add("zips", { key });
    else add("places", { key, radius: Number(a.radius) || 10, distance_unit: "kilometer" }); // neighborhood/subcity/place
  }
  if (!Object.keys(geo).length) geo.countries = [countryCode];
  return geo;
}

// The full campaign builder used by the wizard: campaign (CBO budget) → ad sets
// (ABO budget, geo, placements, conversion-based optimization + messaging
// destination) → ads (creative from headline/primary text/description/image).
// Everything is created PAUSED; the response reports each step so partial
// success is visible and finishable in the Ads tab.
async function createCampaignAdvanced(creds: HfxCreds, body: any): Promise<{ status: number; data: unknown }> {
  const accountId = String(body.account_id ?? "");
  const objective = objectiveFor(String(body.objective ?? ""));
  if (!accountId || !objective) return { status: 400, data: { error: "account_id and a valid objective are required." } };

  const name = String(body.name ?? "New campaign").slice(0, 120);
  const status = body.status === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const budgetMode = body.budgetMode === "CBO" ? "CBO" : "ABO";
  const budgetType = body.budgetType === "lifetime" ? "lifetime" : "daily";
  const countryCode = String(body.countryCode ?? "AE").toUpperCase().slice(0, 2);
  const endTime = body.endDate ? `${String(body.endDate).slice(0, 10)}T23:59:00+0000` : undefined;
  const conv = conversionById(objective.key, String(body.conversionLocation ?? "")) ?? undefined;
  const messagingApp = MESSAGING_APPS.find((m) => m.id === body.messagingApp);
  const websiteUrl = String(body.websiteUrl ?? "").trim();
  const placements: string[] = Array.isArray(body.placements) ? body.placements.map(String) : [];
  const geoIncluded = buildGeo(body.geoIncluded, countryCode);
  const geoExcluded = Array.isArray(body.geoExcluded) && body.geoExcluded.length ? buildGeo(body.geoExcluded, countryCode) : null;
  const adSetsIn: any[] = Array.isArray(body.adSets) && body.adSets.length ? body.adSets : [{ name: "Ad set 1", ageMin: 22, ageMax: 55, interests: [], ads: [] }];

  const needsPage = conv?.needsPage || conv?.needsMessagingApp;
  const pageId = needsPage ? await resolvePageId(creds) : "";

  // 1 — campaign (CBO budget lives here).
  const campArgs: Record<string, unknown> = { account_id: accountId, name, objective: objective.key, status, special_ad_categories: [] };
  if (budgetMode === "CBO") {
    const cents = toCents(body.budget);
    if (budgetType === "lifetime") { if (cents) campArgs.lifetime_budget = cents; campArgs.bid_strategy = "LOWEST_COST_WITHOUT_CAP"; }
    else if (cents) campArgs.daily_budget = cents;
  }
  const camp = await hfxCall("meta_business_create_campaign", campArgs, creds);
  if (!camp.ok) return { status: 502, data: { error: `Campaign creation failed: ${camp.error}` } };
  const campaignId = String((camp.data as any)?.id ?? (camp.data as any)?.campaign_id ?? "");
  if (!campaignId) return { status: 502, data: { error: "Campaign created but Meta returned no id.", raw: camp.data } };

  const optimization = conv?.optimization ?? objective.optimization;
  const fallbackOpt = conv?.fallbackOptimization ?? objective.fallbackOptimization;
  const destinationType = messagingApp?.destinationType ?? conv?.destinationType;
  const cache = new Map<string, { id: string; name: string } | null>();

  // 2 — ad sets, each with its own ads.
  const results: any[] = [];
  for (const as of adSetsIn) {
    const asName = `${name} — ${String(as.name ?? "Ad set").slice(0, 60)}`;
    const targeting: Record<string, unknown> = { geo_locations: geoIncluded, age_min: Number(as.ageMin) || 20, age_max: Number(as.ageMax) || 60 };
    if (geoExcluded) targeting.excluded_geo_locations = geoExcluded;
    if (placements.length) targeting.publisher_platforms = placements.filter((p) => p !== "threads").concat(placements.includes("threads") ? ["threads"] : []);
    const interests = await resolveInterests(creds, Array.isArray(as.interests) ? as.interests : [], cache);

    const base: Record<string, unknown> = {
      mode: "manual",
      account_id: accountId,
      campaign_id: campaignId,
      name: asName,
      billing_event: objective.billing,
      status: "PAUSED",
      age_min: targeting.age_min,
      age_max: targeting.age_max,
      geo_locations: geoIncluded,
      ...(geoExcluded ? { excluded_geo_locations: geoExcluded } : {}),
      ...(placements.length ? { publisher_platforms: targeting.publisher_platforms } : {}),
      ...(interests.length ? { interests } : {}),
      ...(destinationType ? { destination_type: destinationType } : {}),
      ...(pageId && (conv?.needsPage || conv?.needsMessagingApp) ? { promoted_object: { page_id: pageId } } : {}),
    };
    // ABO budget on the ad set; lifetime carries an end time.
    if (budgetMode === "ABO") {
      const cents = toCents(as.budget ?? body.budget);
      if (budgetType === "lifetime") { if (cents) base.lifetime_budget = cents; if (endTime) base.end_time = endTime; }
      else if (cents) base.daily_budget = cents;
    } else if (budgetType === "lifetime" && endTime) {
      base.end_time = endTime; // CBO lifetime still needs an ad-set end time
    }

    let r = await hfxCall("meta_business_create_ad_set", { ...base, optimization_goal: optimization }, creds);
    if (!r.ok && fallbackOpt !== optimization) r = await hfxCall("meta_business_create_ad_set", { ...base, optimization_goal: fallbackOpt }, creds);
    const adSetId = r.ok ? String((r.data as any)?.id ?? (r.data as any)?.ad_set_id ?? "") : "";
    const adResults: any[] = [];

    // 3 — ads/creatives for this ad set (best-effort — needs a Page).
    if (adSetId) {
      const creativePage = pageId || (await resolvePageId(creds));
      for (const ad of (Array.isArray(as.ads) ? as.ads : [])) {
        const adName = String(ad.name ?? "Ad").slice(0, 60);
        if (!creativePage) { adResults.push({ name: adName, ok: false, error: "no Facebook Page found for the creative" }); continue; }
        try {
          let imageHash = "";
          if (ad.imageUrl) {
            const up = await hfxCall("meta_business_upload_ad_image", { account_id: accountId, url: String(ad.imageUrl) }, creds);
            if (up.ok) {
              const d: any = up.data;
              imageHash = String(d?.hash ?? d?.image_hash ?? (d?.images && Object.values(d.images)[0] && (Object.values(d.images)[0] as any).hash) ?? "");
            }
          }
          const creative = await hfxCall("meta_business_create_ad_creative", {
            account_id: accountId,
            name: `${adName} creative`,
            page_id: creativePage,
            message: String(ad.primaryText ?? ""),
            headline: String(ad.headline ?? ""),
            description: String(ad.description ?? ""),
            ...(websiteUrl ? { link_url: websiteUrl } : {}),
            ...(imageHash ? { image_hash: imageHash } : {}),
          }, creds);
          const creativeId = creative.ok ? String((creative.data as any)?.id ?? (creative.data as any)?.creative_id ?? "") : "";
          if (!creativeId) { adResults.push({ name: adName, ok: false, error: `creative failed: ${creative.error ?? "no id"}` }); continue; }
          const adRes = await hfxCall("meta_business_create_ad", { account_id: accountId, ad_set_id: adSetId, name: adName, creative_id: creativeId, status: "PAUSED" }, creds);
          adResults.push({ name: adName, ok: adRes.ok, error: adRes.ok ? undefined : String(adRes.error ?? "").slice(0, 200) });
        } catch (e) {
          adResults.push({ name: adName, ok: false, error: e instanceof Error ? e.message : "ad failed" });
        }
      }
    }
    results.push({ name: as.name, ok: !!adSetId, adSetId, error: adSetId ? undefined : String(r.error ?? "").slice(0, 300), ads: adResults });
  }

  const okSets = results.filter((r) => r.ok).length;
  const okAds = results.reduce((n, r) => n + (r.ads ?? []).filter((a: any) => a.ok).length, 0);
  const totalAds = results.reduce((n, r) => n + (r.ads ?? []).length, 0);
  return {
    status: 200,
    data: {
      ok: true,
      campaignId,
      campaignStatus: status,
      adsets: results,
      summary: `Campaign "${name}" created (${status.toLowerCase()}, ${budgetMode}/${budgetType}). Ad sets: ${okSets}/${results.length}${totalAds ? ` · ads: ${okAds}/${totalAds}` : ""} (all paused). Review in the Ads tab, then activate.`,
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
  // The full wizard builder (conversion location, CBO/ABO, geo areas,
  // placements, budget type, ad sets + ads with creatives).
  if (action === "create_campaign_advanced") {
    const r = await createCampaignAdvanced(creds, body);
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
