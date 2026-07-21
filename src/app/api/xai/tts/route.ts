import { NextRequest, NextResponse } from "next/server";
import { xaiApiKey, XAI_BASE, XAI_VOICES } from "@/lib/xai-voice";

// Voice preview: synthesizes a short sample line in the requested xAI voice
// (POST /v1/tts) so the builder can play how each voice sounds before picking
// one. Audio is returned as-is and cached — the sample text never changes.
export const runtime = "nodejs";

const SAMPLE_TEXT =
  "Hi, this is your clinic's assistant. I'd love to help you book your next visit — what day works best for you?";

export async function GET(req: NextRequest) {
  const key = xaiApiKey();
  if (!key) {
    return NextResponse.json({ error: "xAI voice isn't configured — add X_AI_VOICE_KEY in Netlify." }, { status: 503 });
  }
  const voiceParam = (req.nextUrl.searchParams.get("voice") ?? "eve").toLowerCase();
  const voice = XAI_VOICES.some((v) => v.id === voiceParam) ? voiceParam : "eve";
  const text = (req.nextUrl.searchParams.get("text") ?? SAMPLE_TEXT).slice(0, 300);

  const call = (body: Record<string, unknown>) =>
    fetch(`${XAI_BASE}/tts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

  try {
    let res = await call({ text, voice_id: voice, language: "auto", output_format: { codec: "mp3" } });
    // Older/newer API revisions can reject the output_format shape — retry bare.
    if (!res.ok && res.status === 400) res = await call({ text, voice_id: voice, language: "auto" });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      return NextResponse.json({ error: `xAI TTS failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}` }, { status: 502 });
    }
    const audio = await res.arrayBuffer();
    return new NextResponse(audio, {
      status: 200,
      headers: {
        "Content-Type": res.headers.get("content-type") ?? "audio/mpeg",
        "Cache-Control": "public, max-age=86400", // same sample text → cache a day
      },
    });
  } catch (e) {
    return NextResponse.json({ error: `Could not reach xAI: ${e instanceof Error ? e.message : "network error"}` }, { status: 502 });
  }
}
