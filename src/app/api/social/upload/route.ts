import { NextRequest, NextResponse } from "next/server";
import { wpUploadMedia } from "@/lib/wp-publish";

// Hosts an uploaded media file (image) publicly so it can be posted to
// Instagram/Facebook, which require a public URL. Uses the clinic's WordPress
// media library (same path the scheduler uses for generated images).
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ ok: false, error: "No form data." }, { status: 400 });
  const ws = String(form.get("ws") ?? "");
  const file = form.get("file");
  if (!ws) return NextResponse.json({ ok: false, error: "Missing workspace." }, { status: 400 });
  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "No file received." }, { status: 400 });
  if (!/^image\//.test(file.type)) return NextResponse.json({ ok: false, error: "Only image files can be hosted for social posts right now." }, { status: 415 });

  const bytes = Buffer.from(await file.arrayBuffer());
  const up = await wpUploadMedia(ws, bytes, file.name || "post.png", file.type || "image/png");
  if (!up.ok || !up.url) {
    return NextResponse.json({ ok: false, error: `Couldn't host the media (connect WordPress in Settings → Connections, or paste a public image URL instead): ${up.error ?? "upload failed"}` }, { status: 502 });
  }
  return NextResponse.json({ ok: true, url: up.url });
}
