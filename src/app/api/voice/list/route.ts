import { NextResponse } from "next/server";
import { PREMADE_VOICES } from "@/lib/voices-catalog";

// Returns the premade voice library. When ELEVENLABS_API_KEY is configured the
// list comes live from ElevenLabs (with real preview audio + gender/accent
// labels); otherwise a curated fallback is returned so the screen still works.

const ELEVEN_BASE = "https://api.elevenlabs.io/v1";

interface OutVoice {
  id: string;
  name: string;
  gender: string;
  accent: string;
  description: string;
  previewUrl: string | null;
}

export async function GET() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    return NextResponse.json({
      configured: false,
      voices: PREMADE_VOICES.map((v) => ({ ...v, previewUrl: null })) as OutVoice[],
    });
  }

  try {
    const res = await fetch(`${ELEVEN_BASE}/voices`, { headers: { "xi-api-key": key } });
    if (!res.ok) throw new Error(`provider ${res.status}`);
    const data = await res.json();
    // Only premade voices — cloned voices in the account belong to specific
    // clinics and are returned separately from our own `voices` table.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const voices: OutVoice[] = (data.voices ?? [])
      .filter((v: any) => v.category === "premade")
      .map((v: any) => ({
        id: v.voice_id,
        name: v.name,
        gender: v.labels?.gender ?? "",
        accent: v.labels?.accent ?? "",
        description: v.labels?.description ?? v.labels?.["use case"] ?? "",
        previewUrl: v.preview_url ?? null,
      }));
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return NextResponse.json({ configured: true, voices });
  } catch {
    // Provider unreachable — fall back to the curated list so the UI still loads.
    return NextResponse.json({
      configured: true,
      voices: PREMADE_VOICES.map((v) => ({ ...v, previewUrl: null })) as OutVoice[],
    });
  }
}
