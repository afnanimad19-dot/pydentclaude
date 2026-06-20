// Curated premade voices — used as a display fallback when no managed-TTS key is
// configured yet. When ELEVENLABS_API_KEY is set, /api/voice/list returns the
// provider's live voices (with real preview audio) instead of this list.
// The ids are real ElevenLabs premade voice ids, so they also work once a key is
// added without re-picking the voice.

export interface CatalogVoice {
  id: string;
  name: string;
  gender: string; // "female" | "male"
  accent: string;
  description: string;
}

export const PREMADE_VOICES: CatalogVoice[] = [
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", gender: "female", accent: "American", description: "Warm, calm — great receptionist" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", gender: "female", accent: "American", description: "Soft, friendly" },
  { id: "AZnzlk1XvdvUeBnXmlld", name: "Domi", gender: "female", accent: "American", description: "Confident, upbeat" },
  { id: "MF3mGyEYCl7XYWbV9V6O", name: "Elli", gender: "female", accent: "American", description: "Youthful, bright" },
  { id: "XB0fDUnXU5powFXDhCwa", name: "Charlotte", gender: "female", accent: "British", description: "Elegant, professional" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam", gender: "male", accent: "American", description: "Deep, reassuring" },
  { id: "ErXwobaYiN019PkySvjV", name: "Antoni", gender: "male", accent: "American", description: "Friendly, well-rounded" },
  { id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh", gender: "male", accent: "American", description: "Young, energetic" },
  { id: "VR6AewLTigWG4xSOukaG", name: "Arnold", gender: "male", accent: "American", description: "Crisp, clear" },
  { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel", gender: "male", accent: "British", description: "Calm, authoritative" },
];
