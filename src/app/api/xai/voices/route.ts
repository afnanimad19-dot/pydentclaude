import { NextResponse } from "next/server";
import { xaiApiKey, XAI_BASE, XAI_VOICES } from "@/lib/xai-voice";

// Lists ALL voices available on the clinic's xAI account — the built-in roster
// plus any custom/cloned voices from their Voice Library — via GET /v1/tts/voices
// (the same roster the Voice Agent API uses). Falls back to the built-in five if
// the API can't be reached. Labels for custom voices embed the raw id in
// parentheses so resolveXaiVoice() can map the saved label back to the id.
export const runtime = "nodejs";

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function GET() {
  const fallback = XAI_VOICES.map((v) => ({ id: v.id, label: v.label }));
  const key = xaiApiKey();
  if (!key) return NextResponse.json({ voices: fallback, live: false });

  try {
    const res = await fetch(`${XAI_BASE}/tts/voices`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    if (!res.ok) return NextResponse.json({ voices: fallback, live: false });
    const data: any = await res.json().catch(() => ({}));
    const raw: any[] = Array.isArray(data) ? data : Array.isArray(data?.voices) ? data.voices : Array.isArray(data?.data) ? data.data : [];

    const builtinIds = new Set(XAI_VOICES.map((v) => v.id));
    const seen = new Set<string>();
    const voices: { id: string; label: string }[] = [];
    for (const v of raw) {
      const id = String(v?.voice_id ?? v?.id ?? v?.name ?? "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const name = String(v?.name ?? v?.display_name ?? id);
      const desc = String(v?.description ?? v?.tone ?? "").slice(0, 60);
      if (builtinIds.has(id.toLowerCase())) {
        // Use our friendly label for the built-ins.
        voices.push(XAI_VOICES.find((b) => b.id === id.toLowerCase())!);
      } else {
        // Custom/cloned voice — keep the raw id recoverable from the label.
        voices.push({ id, label: `${name}${desc ? ` · ${desc}` : ""} · custom (${id})` });
      }
    }
    // Make sure the built-in five are always present even if the API omits them.
    for (const b of XAI_VOICES) if (!voices.some((v) => v.id === b.id)) voices.push(b);
    return NextResponse.json({ voices: voices.length ? voices : fallback, live: raw.length > 0 });
  } catch {
    return NextResponse.json({ voices: fallback, live: false });
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
