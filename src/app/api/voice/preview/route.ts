import { NextRequest, NextResponse } from "next/server";

// Speaks a short line of text in the chosen voice (managed TTS) so the user can
// hear it before selecting. Returns audio/mpeg. Used for both premade and the
// clinic's own cloned voices.

const ELEVEN_BASE = "https://api.elevenlabs.io/v1";
const SAMPLE = "Hi, thank you for calling Bright Smile Dental. How can I help you today?";

export async function POST(req: NextRequest) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "ELEVENLABS_API_KEY is not configured. Add it in Netlify to hear real voices." },
      { status: 503 }
    );
  }

  const { voiceId, text } = await req.json().catch(() => ({}));
  if (!voiceId) return NextResponse.json({ error: "Missing voiceId." }, { status: 400 });

  const res = await fetch(`${ELEVEN_BASE}/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text: (text || SAMPLE).slice(0, 500),
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json({ error: `Voice preview failed (${res.status}). ${detail.slice(0, 200)}` }, { status: res.status });
  }

  const audio = await res.arrayBuffer();
  return new NextResponse(audio, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
}
