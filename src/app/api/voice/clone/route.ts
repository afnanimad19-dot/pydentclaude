import { NextRequest, NextResponse } from "next/server";

// Creates a custom voice from a short recording the user makes in the browser
// (managed TTS instant voice cloning). Returns the new provider voice id, which
// the client then stores in our `voices` table against the workspace.

const ELEVEN_BASE = "https://api.elevenlabs.io/v1";

export async function POST(req: NextRequest) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "ELEVENLABS_API_KEY is not configured. Add it in Netlify to create custom voices." },
      { status: 503 }
    );
  }

  const inForm = await req.formData();
  const name = String(inForm.get("name") || "Custom voice");
  const audio = inForm.get("audio");
  if (!(audio instanceof Blob)) {
    return NextResponse.json({ error: "No recording received." }, { status: 400 });
  }

  // Forward to the provider's add-voice endpoint as multipart.
  const out = new FormData();
  out.append("name", name.slice(0, 80));
  out.append("files", audio, "sample.webm");
  const desc = String(inForm.get("description") || "");
  if (desc) out.append("description", desc.slice(0, 400));

  const res = await fetch(`${ELEVEN_BASE}/voices/add`, {
    method: "POST",
    headers: { "xi-api-key": key },
    body: out,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return NextResponse.json(
      { error: data?.detail?.message ?? data?.detail ?? `Voice cloning failed (${res.status}).` },
      { status: res.status }
    );
  }
  return NextResponse.json({ ok: true, voiceId: data.voice_id });
}
