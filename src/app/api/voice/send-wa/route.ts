import { NextRequest, NextResponse } from "next/server";
import { getWaCredentials, getWaCredsByPhoneId, uploadWhatsAppMedia, sendWhatsAppAudio } from "@/lib/wa-send";

// Generate a voice note (ElevenLabs TTS, premade or the clinic's cloned voice)
// and DELIVER it to the patient on WhatsApp as a real audio message.
// Body: { to, voiceId, text, phoneNumberId? }.
export const runtime = "nodejs";

const ELEVEN_BASE = "https://api.elevenlabs.io/v1";

export async function POST(req: NextRequest) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return NextResponse.json({ ok: false, error: "ELEVENLABS_API_KEY is not configured." }, { status: 503 });

  const { to, voiceId, text, phoneNumberId } = await req.json().catch(() => ({}));
  if (!to || !voiceId || !text) return NextResponse.json({ ok: false, error: "Missing to / voiceId / text." }, { status: 400 });

  // Resolve the clinic's WhatsApp credentials (per-number when known).
  const creds = phoneNumberId ? await getWaCredsByPhoneId(phoneNumberId) : await getWaCredentials();
  if (!creds) return NextResponse.json({ ok: false, error: "WhatsApp is not connected for this clinic." }, { status: 400 });

  // 1) Generate the speech.
  const tts = await fetch(`${ELEVEN_BASE}/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text: String(text).slice(0, 800), model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
  });
  if (!tts.ok) return NextResponse.json({ ok: false, error: `Voice generation failed (${tts.status}).` }, { status: 502 });
  const bytes = Buffer.from(await tts.arrayBuffer());

  // 2) Upload to WhatsApp + 3) send as an audio message.
  const up = await uploadWhatsAppMedia(creds, bytes, "audio/mpeg", "voice.mp3");
  if (!up.ok || !up.id) return NextResponse.json({ ok: false, error: `WhatsApp media upload failed: ${up.error}` }, { status: 502 });
  const sent = await sendWhatsAppAudio(to, up.id, creds);
  if (!sent.ok) return NextResponse.json({ ok: false, error: `WhatsApp send failed: ${sent.error}` }, { status: 502 });

  return NextResponse.json({ ok: true, id: sent.id, message: "Voice note delivered to WhatsApp." });
}
