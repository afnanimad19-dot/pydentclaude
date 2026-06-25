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

async function getMetaToken(ws: string): Promise<string | null> {
  const db = admin();
  if (!db) return null;
  for (const provider of ["facebook", "instagram", "meta_ads"]) {
    const { data } = await db.from("oauth_tokens").select("access_token").eq("workspace_id", ws).eq("provider", provider).maybeSingle();
    if (data?.access_token) return data.access_token;
  }
  return null;
}

// Return the first managed Page (id + its page access token), and any linked IG account.
async function getPage(ws: string): Promise<{ pageId: string; pageToken: string; igId?: string } | null> {
  const token = await getMetaToken(ws);
  if (!token) return null;
  const res = await fetch(`${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${token}`);
  const json = await res.json();
  const page = json?.data?.[0];
  if (!page?.id || !page?.access_token) return null;
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
