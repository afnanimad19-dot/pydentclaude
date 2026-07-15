import { createClient } from "@supabase/supabase-js";

// Posts to a clinic's Facebook Page / Instagram using the Meta token stored when
// they connected (any of facebook / instagram / meta_ads). Server-only.

const GRAPH = "https://graph.facebook.com/v19.0";

function admin() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://mzqynjywncbvqfikbzgm.supabase.co";
  if (!serviceKey) return null;
  return createClient(supabaseUrl, serviceKey);
}

const META_PROVIDERS = ["facebook", "instagram", "meta_ads"];

// User-level token (needed for /me/accounts and /me/adaccounts). Reads the stored
// long-lived token captured at connect time.
async function getMetaToken(ws: string): Promise<string | null> {
  const db = admin();
  if (!db) return null;
  for (const provider of META_PROVIDERS) {
    const { data } = await db.from("oauth_tokens").select("access_token").eq("workspace_id", ws).eq("provider", provider).maybeSingle();
    if (data?.access_token) return data.access_token;
  }
  return null;
}

// Read the stored meta extra (page token + ig id) captured at connect time, if any.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getStoredMeta(ws: string): Promise<{ provider: string; meta: any } | null> {
  const db = admin();
  if (!db) return null;
  for (const provider of META_PROVIDERS) {
    try {
      const { data } = await db.from("oauth_tokens").select("meta").eq("workspace_id", ws).eq("provider", provider).maybeSingle();
      if (data?.meta?.page_access_token) return { provider, meta: data.meta };
    } catch { /* `meta` column may not be migrated yet */ }
  }
  return null;
}

// Return the managed Page (id + page token + linked IG). Prefers the durable
// stored Page token; falls back to deriving it live, then self-heals storage.
async function getPage(ws: string): Promise<{ pageId: string; pageToken: string; igId?: string } | null> {
  const stored = await getStoredMeta(ws);
  if (stored?.meta?.page_id && stored.meta.page_access_token) {
    return { pageId: stored.meta.page_id, pageToken: stored.meta.page_access_token, igId: stored.meta.ig_id ?? undefined };
  }
  const token = await getMetaToken(ws);
  if (!token) return null;
  const res = await fetch(`${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${token}`);
  const json = await res.json();
  const page = json?.data?.[0];
  if (!page?.id || !page?.access_token) return null;
  // Self-heal: persist the derived Page token so future calls are durable (only
  // when nothing is stored yet, to avoid clobbering a fresh long-lived token).
  const db = admin();
  if (db) {
    for (const provider of META_PROVIDERS) {
      try {
        const { data } = await db.from("oauth_tokens").select("provider").eq("workspace_id", ws).eq("provider", provider).maybeSingle();
        if (data) {
          await db.from("oauth_tokens").update({ meta: { page_id: page.id, page_access_token: page.access_token, ig_id: page.instagram_business_account?.id ?? null, captured_at: new Date().toISOString() } }).eq("workspace_id", ws).eq("provider", provider);
          break;
        }
      } catch { /* meta column not migrated — ignore */ }
    }
  }
  return { pageId: page.id, pageToken: page.access_token, igId: page.instagram_business_account?.id };
}

export async function postToFacebookPage(ws: string, message: string, link?: string): Promise<string> {
  const page = await getPage(ws);
  if (!page) return "Facebook isn't connected, or no Page is available on this account.";
  const body = new URLSearchParams({ message, access_token: page.pageToken });
  if (link) body.set("link", link);
  const res = await fetch(`${GRAPH}/${page.pageId}/feed`, { method: "POST", body });
  const json = await res.json();
  if (!res.ok) return `Facebook post failed: ${json?.error?.message ?? res.status}`;
  return `Posted to your Facebook Page. Post id: ${json.id}`;
}

// A photo post to the Facebook Page (image + caption) using a public image URL.
export async function postFacebookPhoto(ws: string, caption: string, imageUrl: string): Promise<string> {
  const page = await getPage(ws);
  if (!page) return "Facebook isn't connected, or no Page is available on this account.";
  const res = await fetch(`${GRAPH}/${page.pageId}/photos`, {
    method: "POST",
    body: new URLSearchParams({ url: imageUrl, caption, access_token: page.pageToken }),
  });
  const json = await res.json();
  if (!res.ok) return `Facebook photo post failed: ${json?.error?.message ?? res.status}`;
  return `Posted to your Facebook Page. Post id: ${json.post_id ?? json.id}`;
}

// Meta (Facebook/Instagram) ad performance for the connected ad account.
export async function getMetaAdsPerformance(ws: string): Promise<string> {
  const token = await getMetaToken(ws);
  if (!token) return "Meta isn't connected. Connect Meta Ads in Settings → Connections.";
  try {
    const acctRes = await fetch(`${GRAPH}/me/adaccounts?fields=name,account_id&access_token=${token}`);
    const acctJson = await acctRes.json();
    if (!acctRes.ok) return `Meta Ads error: ${acctJson?.error?.message ?? acctRes.status} (needs ads_read permission).`;
    const acct = acctJson?.data?.[0];
    if (!acct) return "No ad account found on this Meta connection.";
    const insRes = await fetch(`${GRAPH}/${acct.id}/insights?fields=spend,impressions,clicks,ctr,cpc,reach&date_preset=last_30d&access_token=${token}`);
    const insJson = await insRes.json();
    if (!insRes.ok) return `Meta Ads insights error: ${insJson?.error?.message ?? insRes.status}`;
    const d = insJson?.data?.[0];
    if (!d) return `No ad activity in the last 30 days for ${acct.name}.`;
    return `Meta Ads (${acct.name}, last 30 days): spend $${d.spend ?? 0}, ${d.impressions ?? 0} impressions, ${d.clicks ?? 0} clicks, CTR ${d.ctr ?? 0}%, CPC $${d.cpc ?? 0}, reach ${d.reach ?? 0}.`;
  } catch (e) {
    return `Meta Ads failed: ${e instanceof Error ? e.message : "error"}`;
  }
}

// Recent Facebook Page recommendations / reviews for sentiment + reply drafting.
export async function getFacebookReviews(ws: string): Promise<string> {
  const page = await getPage(ws);
  if (!page) return "Facebook isn't connected, or no Page is available on this account.";
  const res = await fetch(`${GRAPH}/${page.pageId}/ratings?fields=reviewer{name},rating,review_text,recommendation_type,created_time&limit=15&access_token=${page.pageToken}`);
  const j = await res.json();
  if (!res.ok) return `Facebook reviews error: ${j?.error?.message ?? res.status}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const list = (j.data ?? []).map((r: any) => `  • ${r.recommendation_type ?? (r.rating ? `${r.rating}★` : "")} ${r.reviewer?.name ?? "Someone"}: ${(r.review_text ?? "(no text)").replace(/\s+/g, " ").slice(0, 240)}`).join("\n");
  return list ? `Facebook recommendations:\n${list}` : "No Facebook recommendations found.";
}

// Instagram requires a PUBLIC image URL (e.g. one uploaded to WordPress media).
export async function postToInstagram(ws: string, caption: string, imageUrl: string): Promise<string> {
  const page = await getPage(ws);
  if (!page?.igId) return "Instagram isn't connected, or no Instagram Business account is linked to your Facebook Page.";
  // 1) create media container
  const create = await fetch(`${GRAPH}/${page.igId}/media`, {
    method: "POST",
    body: new URLSearchParams({ image_url: imageUrl, caption, access_token: page.pageToken }),
  });
  const cj = await create.json();
  if (!create.ok || !cj.id) return `Instagram media failed: ${cj?.error?.message ?? create.status}`;
  // 2) publish
  const pub = await fetch(`${GRAPH}/${page.igId}/media_publish`, {
    method: "POST",
    body: new URLSearchParams({ creation_id: cj.id, access_token: page.pageToken }),
  });
  const pj = await pub.json();
  if (!pub.ok) return `Instagram publish failed: ${pj?.error?.message ?? pub.status}`;
  return `Posted to Instagram. Media id: ${pj.id}`;
}
