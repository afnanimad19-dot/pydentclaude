import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { generateImage } from "@/lib/image-gen";
import { wpUploadMedia } from "@/lib/wp-publish";
import { postToInstagram, postToFacebookPage, postFacebookPhoto } from "@/lib/meta-api";
import { logActivity } from "@/lib/activity";

// Publishes scheduled content posts whose time has arrived — now MULTI-PLATFORM
// (Later.com-style). Each ig_posts row carries its own workspace_id (the cron
// has no auth session) and a `platforms` list. Instagram/Facebook photo posts
// need a PUBLIC image URL: prefer the media_url the user attached, else a
// previously hosted image_url, else generate one and host it on WordPress media.

/* eslint-disable @typescript-eslint/no-explicit-any */
function admin(): SupabaseClient | null {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://mzqynjywncbvqfikbzgm.supabase.co";
  return key ? createClient(url, key) : null;
}

// scheduled_for is a DATE and time is a separate 'HH:MM' text — combine to a UTC instant.
function dueAt(row: any): number {
  const date = String(row.scheduled_for ?? "").slice(0, 10);
  const time = String(row.time ?? "10:00").slice(0, 5);
  const t = Date.parse(`${date}T${time || "10:00"}:00Z`);
  return Number.isFinite(t) ? t : Date.parse(`${date}T10:00:00Z`);
}

const platformsOf = (row: any): string[] =>
  Array.isArray(row.platforms)
    ? row.platforms.map(String)
    : String(row.platforms ?? "instagram").split(",").map((s: string) => s.trim().toLowerCase()).filter(Boolean);

// Resolve a public image URL for a post: user media → prior hosted image →
// generate + host on WordPress. Returns "" if none could be produced.
async function resolveImageUrl(db: SupabaseClient, row: any): Promise<{ url: string; error?: string }> {
  if (row.media_url && /^https?:\/\//.test(row.media_url)) return { url: String(row.media_url) };
  if (row.image_url && /^https?:\/\//.test(row.image_url)) return { url: String(row.image_url) };
  const prompt = String(row.caption || row.media_name || "A clean, professional dental clinic social media image");
  const img = await generateImage(prompt, row.workspace_id);
  if (!img.ok || !img.bytes) return { url: "", error: `Couldn't generate the image: ${img.error ?? "image error"}` };
  const up = await wpUploadMedia(row.workspace_id, img.bytes, row.media_name || "post.png", img.mime ?? "image/png");
  if (!up.ok || !up.url) return { url: "", error: `Image hosting failed (needs a public image — attach media or connect WordPress): ${up.error ?? "upload error"}` };
  await db.from("ig_posts").update({ image_url: up.url }).eq("id", row.id);
  return { url: up.url };
}

// Publish one row to all its selected platforms. Marks Published if at least one
// platform succeeds; records per-platform outcomes in `error`.
export async function publishRow(db: SupabaseClient, row: any): Promise<{ ok: boolean; detail: string }> {
  const platforms = platformsOf(row);
  const ws = row.workspace_id;
  const caption = String(row.caption ?? "");
  const needsImage = platforms.includes("instagram") || (platforms.includes("facebook") && (row.media_url || row.image_url));
  let imageUrl = "";
  if (needsImage) {
    const r = await resolveImageUrl(db, row);
    if (!r.url && platforms.includes("instagram")) {
      // Instagram cannot post without an image — fail the whole row.
      return { ok: false, detail: r.error ?? "no image for Instagram" };
    }
    imageUrl = r.url;
  }

  const results: string[] = [];
  let anyOk = false;
  for (const p of platforms) {
    try {
      if (p === "instagram") {
        const res = await postToInstagram(ws, caption, imageUrl);
        const ok = res.startsWith("Posted to Instagram");
        anyOk ||= ok;
        results.push(`Instagram: ${ok ? "posted" : res}`);
      } else if (p === "facebook") {
        const res = imageUrl ? await postFacebookPhoto(ws, caption, imageUrl) : await postToFacebookPage(ws, caption);
        const ok = res.startsWith("Posted to your Facebook Page");
        anyOk ||= ok;
        results.push(`Facebook: ${ok ? "posted" : res}`);
      } else {
        results.push(`${p}: not supported for auto-publish yet`);
      }
    } catch (e) {
      results.push(`${p}: ${e instanceof Error ? e.message : "failed"}`);
    }
  }

  const detail = results.join(" · ");
  if (anyOk) {
    await db.from("ig_posts").update({ status: "Published", published_at: new Date().toISOString(), error: detail }).eq("id", row.id);
    try { await logActivity(ws, "helena", "Published scheduled post", `${platforms.join(", ")} — ${caption.slice(0, 100)}`); } catch { /* ignore */ }
  } else {
    await db.from("ig_posts").update({ status: "Failed", error: detail.slice(0, 500) }).eq("id", row.id);
    try { await logActivity(ws, "helena", "Scheduled post failed", detail.slice(0, 120)); } catch { /* ignore */ }
  }
  return { ok: anyOk, detail };
}

export async function runDueIgPosts(limit = 10): Promise<{ ok: boolean; published: number; failed: number; checked: number; error?: string }> {
  const db = admin();
  if (!db) return { ok: false, published: 0, failed: 0, checked: 0, error: "Server not configured (SUPABASE_SERVICE_ROLE_KEY)." };

  const now = Date.now();
  const todayStr = new Date(now).toISOString().slice(0, 10);

  // Re-queue posts stuck in 'Publishing' (a previous run died) so they retry.
  try {
    const staleIso = new Date(now - 30 * 60 * 1000).toISOString();
    await db.from("ig_posts").update({ status: "Scheduled" }).eq("status", "Publishing").lt("created_at", staleIso);
  } catch { /* best-effort */ }

  const { data: rows } = await db.from("ig_posts").select("*").eq("status", "Scheduled").lte("scheduled_for", todayStr).order("scheduled_for").limit(limit);
  const due = (rows ?? []).filter((r) => dueAt(r) <= now);

  let published = 0, failed = 0;
  for (const row of due) {
    // Claim it so overlapping cron ticks don't double-publish.
    const { data: claimed } = await db.from("ig_posts").update({ status: "Publishing" }).eq("id", row.id).eq("status", "Scheduled").select("id");
    if (!claimed?.length) continue;
    const r = await publishRow(db, row);
    if (r.ok) published++; else failed++;
  }

  return { ok: true, published, failed, checked: due.length };
}

// Publish a single row on demand ("Publish now"), scoped to a workspace.
export async function publishOneNow(postId: string, workspaceId: string): Promise<{ ok: boolean; detail: string }> {
  const db = admin();
  if (!db) return { ok: false, detail: "Server not configured (SUPABASE_SERVICE_ROLE_KEY)." };
  const { data: row } = await db.from("ig_posts").select("*").eq("id", postId).eq("workspace_id", workspaceId).maybeSingle();
  if (!row) return { ok: false, detail: "Post not found." };
  const { data: claimed } = await db.from("ig_posts").update({ status: "Publishing" }).eq("id", postId).neq("status", "Publishing").select("id");
  if (!claimed?.length) return { ok: false, detail: "Already publishing." };
  return publishRow(db, row);
}
