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
  // Accept the built-in ids AND custom-voice ids from the account's library.
  const voiceParam = (req.nextUrl.searchParams.get("voice") ?? "eve").trim();
  const voice = XAI_VOICES.some((v) => v.id === voiceParam.toLowerCase())
    ? voiceParam.toLowerCase()
    : /^[A-Za-z0-9_-]{2,64}$/.test(voiceParam)
    ? voiceParam
    : "eve";
  const text = (req.nextUrl.searchParams.get("text") ?? SAMPLE_TEXT).slice(0, 300);

  const call = (body: Record<string, unknown>) =>
    fetch(`${XAI_BASE}/tts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

  try {
    // Send the voice under BOTH accepted names — an API revision that only knows
    // one would otherwise silently fall back to the default voice, making every
    // preview sound identical. Walk a ladder if a strict revision rejects extras.
    const bodies: Record<string, unknown>[] = [
      { text, voice, voice_id: voice, language: "auto", output_format: { codec: "mp3" } },
      { text, voice, voice_id: voice, language: "auto" },
      { text, voice, language: "auto" },
      { text, voice_id: voice, language: "auto" },
    ];
    let res: Response | null = null;
    for (const b of bodies) {
      res = await call(b);
      if (res.ok) break;
      if (res.status !== 400 && res.status !== 422) break; // only schema-style rejections ladder down
    }
    if (!res || !res.ok) {
      const detail = res ? (await res.text().catch(() => "")).slice(0, 200) : "";
      return NextResponse.json({ error: `xAI TTS failed (HTTP ${res?.status ?? "?"})${detail ? `: ${detail}` : ""}` }, { status: 502 });
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
