import { createClient } from "@supabase/supabase-js";
import { generateImage } from "@/lib/image-gen";
import { wpUploadMedia } from "@/lib/wp-publish";
import { postToInstagram } from "@/lib/meta-api";
import { logActivity } from "@/lib/activity";

// Publishes scheduled Instagram posts whose time has arrived. Each ig_posts row
// carries its own workspace_id (the cron has no auth session), so everything is
// resolved per-workspace. Instagram needs a PUBLIC image URL, so we generate an
// image and host it on the clinic's WordPress media (same path Helena uses),
// unless the row already has an image_url from a prior attempt.

/* eslint-disable @typescript-eslint/no-explicit-any */
function admin() {
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

    async function fail(msg: string) {
      failed++;
      await db!.from("ig_posts").update({ status: "Failed", error: msg.slice(0, 500) }).eq("id", row.id);
      try { await logActivity(row.workspace_id, "helena", "Instagram post failed", String(row.caption ?? "").slice(0, 120)); } catch { /* ignore */ }
    }

    try {
      // Resolve a public image URL (reuse one from a prior partial attempt).
      let imageUrl: string = row.image_url ?? "";
      if (!imageUrl) {
        const prompt = String(row.caption || row.media_name || "A clean, professional dental clinic social media image");
        const img = await generateImage(prompt, row.workspace_id);
        if (!img.ok || !img.bytes) { await fail(`Couldn't generate the image: ${img.error ?? "image error"}`); continue; }
        const up = await wpUploadMedia(row.workspace_id, img.bytes, row.media_name || "ig-post.png", img.mime ?? "image/png");
        if (!up.ok || !up.url) { await fail(`Image hosting failed (Instagram needs a public image — connect WordPress): ${up.error ?? "upload error"}`); continue; }
        imageUrl = up.url;
        await db.from("ig_posts").update({ image_url: imageUrl }).eq("id", row.id);
      }

      const res = await postToInstagram(row.workspace_id, String(row.caption ?? ""), imageUrl);
      if (res.startsWith("Posted to Instagram. Media id: ")) {
        const mediaId = res.split("Media id: ")[1]?.trim() ?? "";
        await db.from("ig_posts").update({ status: "Published", ig_media_id: mediaId, published_at: new Date().toISOString(), error: "" }).eq("id", row.id);
        published++;
        try { await logActivity(row.workspace_id, "helena", "Published scheduled Instagram post", String(row.caption ?? "").slice(0, 120)); } catch { /* ignore */ }
      } else {
        await fail(res);
      }
    } catch (e) {
      await fail(e instanceof Error ? e.message : "publish failed");
    }
  }

  return { ok: true, published, failed, checked: due.length };
}
