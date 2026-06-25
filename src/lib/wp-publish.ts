import { createClient } from "@supabase/supabase-js";

// Publishes content to a clinic's self-hosted WordPress using the credentials
// stored when they connected it (oauth_tokens for provider "wordpress_self":
// access_token = base64(user:appPassword), refresh_token = the site base URL).
// Server-only (reads the service-role-protected oauth_tokens table).

function admin() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://mzqynjywncbvqfikbzgm.supabase.co";
  if (!serviceKey) return null;
  return createClient(supabaseUrl, serviceKey);
}

export async function getWpCreds(ws: string): Promise<{ base: string; cred: string } | null> {
  const db = admin();
  if (!db) return null;
  const { data } = await db.from("oauth_tokens").select("access_token, refresh_token").eq("workspace_id", ws).eq("provider", "wordpress_self").maybeSingle();
  if (!data?.access_token || !data?.refresh_token) return null;
  return { base: String(data.refresh_token).replace(/\/+$/, ""), cred: data.access_token };
}

export async function wpPublishPost(
  ws: string,
  input: { title: string; contentHtml: string; status?: "draft" | "publish"; featuredMedia?: number; excerpt?: string }
): Promise<{ ok: boolean; link?: string; editLink?: string; id?: number; error?: string }> {
  const creds = await getWpCreds(ws);
  if (!creds) return { ok: false, error: "WordPress isn't connected. Connect it in Settings → Connections first." };
  try {
    const res = await fetch(`${creds.base}/wp-json/wp/v2/posts`, {
      method: "POST",
      headers: { Authorization: `Basic ${creds.cred}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: input.title,
        content: input.contentHtml,
        status: input.status ?? "draft",
        excerpt: input.excerpt ?? "",
        ...(input.featuredMedia ? { featured_media: input.featuredMedia } : {}),
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.message ?? `WordPress rejected the post (${res.status}).` };
    return { ok: true, id: data.id, link: data.link, editLink: `${creds.base}/wp-admin/post.php?post=${data.id}&action=edit` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not reach WordPress." };
  }
}

export async function wpUploadMedia(
  ws: string,
  bytes: Buffer,
  filename: string,
  mime: string
): Promise<{ ok: boolean; id?: number; url?: string; error?: string }> {
  const creds = await getWpCreds(ws);
  if (!creds) return { ok: false, error: "WordPress not connected." };
  try {
    const res = await fetch(`${creds.base}/wp-json/wp/v2/media`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${creds.cred}`,
        "Content-Type": mime,
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: bytes as any,
      signal: AbortSignal.timeout(45000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.message ?? `Media upload failed (${res.status}).` };
    return { ok: true, id: data.id, url: data.source_url };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Media upload failed." };
  }
}
