import { NextRequest, NextResponse } from "next/server";
import { getHfxCreds, hfxCall, hfxConfigured } from "@/lib/hyperfx";

// The visual preview of one ad, exactly as Meta renders it: ad → its creative →
// Meta's preview iframe (plus the creative's text/title when available).
export const runtime = "nodejs";
export const maxDuration = 60;

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function GET(req: NextRequest) {
  const adId = req.nextUrl.searchParams.get("ad") ?? "";
  if (!adId) return NextResponse.json({ error: "ad id required." }, { status: 400 });
  const creds = await getHfxCreds(req.nextUrl.searchParams.get("ws"));
  if (!hfxConfigured(creds)) return NextResponse.json({ error: "Marketing engine not configured." }, { status: 400 });

  // 1 — the ad's creative id (+ any creative text we can surface).
  const details = await hfxCall("meta_business_get_ad_details", { ad_id: adId }, creds);
  if (!details.ok) return NextResponse.json({ error: details.error }, { status: 502 });
  const d = details.data as any;
  const creativeId = String(d?.creative?.id ?? d?.creative_id ?? d?.creative ?? "");
  if (!creativeId) return NextResponse.json({ error: "This ad has no creative attached yet." }, { status: 404 });

  let title = "", bodyText = "";
  const cr = await hfxCall("meta_business_get_ad_creative", { creative_id: creativeId }, creds);
  if (cr.ok) {
    const c = cr.data as any;
    title = String(c?.title ?? c?.object_story_spec?.link_data?.name ?? "");
    bodyText = String(c?.body ?? c?.object_story_spec?.link_data?.message ?? "");
  }

  // 2 — Meta's rendered preview (iframe snippet) for the standard feed format.
  const prev = await hfxCall("meta_business_get_ad_previews", { creative_ids: [creativeId], ad_formats: ["DESKTOP_FEED_STANDARD"] }, creds);
  if (!prev.ok) return NextResponse.json({ creativeId, title, body: bodyText, error: prev.error }, { status: 200 });
  const raw = prev.data as any;
  // Find the first preview body (shapes vary: {results:[{previews:[{body}]}]} etc).
  const txt = JSON.stringify(raw ?? "");
  const m = txt.match(/<iframe[^>]*src=\\?"([^"\\]+)\\?"/i);
  const iframeSrc = m ? m[1].replaceAll("\\/", "/").replaceAll("&amp;", "&") : null;

  return NextResponse.json({ creativeId, title, body: bodyText, iframeSrc });
}
