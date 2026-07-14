import { NextRequest, NextResponse } from "next/server";
import { getHfxCreds, hfxCall, hfxConfigured } from "@/lib/hyperfx";

// Campaign/ad-set management — the ONLY write path to Meta ads from the UI.
// Every action is explicitly whitelisted and triggered by a user click behind a
// confirm step in the Ads tab (the generic /api/hyperfx/call stays read-only).
// Budgets arrive in DOLLARS from the UI and are converted to Meta's cents here.
export const runtime = "nodejs";

/* eslint-disable @typescript-eslint/no-explicit-any */

const toCents = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : undefined;
};

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
    default:
      return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
  }

  const r = await hfxCall(tool, args, creds);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
  return NextResponse.json({ ok: true, data: r.data });
}
