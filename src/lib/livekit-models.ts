// LiveKit Inference model catalog — the STT / LLM / TTS / voice choices offered
// in the agent builder when the workspace runs on LiveKit. Client-safe (no
// server imports). Identifiers are the exact strings LiveKit Inference expects
// (see docs.livekit.io/agents/models). The worker passes them straight through,
// so adding a model here is enough to make it selectable.

export interface LivekitAgentSettings {
  stt: string;          // e.g. "deepgram/nova-3"
  sttLanguage: string;  // "" = auto-detect, or a code like "en" / "ar"
  llm: string;          // e.g. "openai/gpt-4.1-mini"
  tts: string;          // e.g. "inworld/inworld-tts-2"
  voice: string;        // provider voice id / name, e.g. "Ashley"
  interruptions: "adaptive" | "eager" | "off";
}

export const LIVEKIT_DEFAULTS: LivekitAgentSettings = {
  stt: "deepgram/nova-3",
  sttLanguage: "",
  llm: "openai/gpt-4.1-mini",
  tts: "inworld/inworld-tts-2",
  voice: "Ashley",
  interruptions: "adaptive",
};

export const LIVEKIT_STT: { id: string; label: string; arabic: boolean }[] = [
  { id: "deepgram/nova-3", label: "Deepgram Nova-3 · 48 languages incl. Arabic (recommended)", arabic: true },
  { id: "deepgram/nova-2", label: "Deepgram Nova-2 · 33 languages incl. Arabic", arabic: true },
  { id: "deepgram/flux-multilingual", label: "Deepgram Flux Multilingual · fastest, 10 languages", arabic: false },
  { id: "deepgram/flux", label: "Deepgram Flux · English only, lowest latency", arabic: false },
  { id: "assemblyai/universal-3.5-pro", label: "AssemblyAI Universal 3.5 Pro · 19 languages incl. Arabic", arabic: true },
  { id: "cartesia/ink-whisper", label: "Cartesia Ink-Whisper · 100 languages incl. Arabic", arabic: true },
  { id: "gemini/gemini-3.5-transcribe-live", label: "Gemini 3.5 Transcribe Live · 26 languages incl. Arabic", arabic: true },
  { id: "speechmatics/enhanced", label: "Speechmatics Enhanced · 61 languages incl. Arabic", arabic: true },
];

export const LIVEKIT_LLM: { id: string; label: string }[] = [
  { id: "openai/gpt-4.1-mini", label: "OpenAI GPT-4.1 mini (recommended · fast, accurate)" },
  { id: "openai/gpt-4.1", label: "OpenAI GPT-4.1" },
  { id: "openai/gpt-4o-mini", label: "OpenAI GPT-4o mini" },
  { id: "openai/gpt-4o", label: "OpenAI GPT-4o" },
  { id: "google/gemma-4-31b-it", label: "Google Gemma 4 31B (LiveKit default · lowest latency)" },
  { id: "google/gemini-3.5-flash", label: "Google Gemini 3.5 Flash" },
  { id: "google/gemini-3.5-flash-lite", label: "Google Gemini 3.5 Flash Lite" },
  { id: "xai/grok-4.6", label: "xAI Grok 4.6" },
  { id: "moonshotai/kimi-k2.6", label: "Moonshot Kimi K2.6" },
];

// TTS models + the voices we know by name. Any provider voice id can also be
// typed in as a custom voice (the builder has a free-text field).
export const LIVEKIT_TTS: { id: string; label: string; arabic: boolean; voices: { id: string; label: string }[] }[] = [
  {
    id: "inworld/inworld-tts-2",
    label: "Inworld TTS-2 · natural, Arabic + many languages",
    arabic: true,
    voices: [
      { id: "Ashley", label: "Ashley · warm female" },
      { id: "Olivia", label: "Olivia · clear female" },
      { id: "Diego", label: "Diego · friendly male" },
      { id: "Edward", label: "Edward · calm male" },
    ],
  },
  {
    id: "inworld/inworld-tts-2-flash",
    label: "Inworld TTS-2 Flash · fastest, Arabic supported",
    arabic: true,
    voices: [
      { id: "Ashley", label: "Ashley · warm female" },
      { id: "Olivia", label: "Olivia · clear female" },
      { id: "Diego", label: "Diego · friendly male" },
      { id: "Edward", label: "Edward · calm male" },
    ],
  },
  {
    id: "cartesia/sonic-3.6",
    label: "Cartesia Sonic 3.6 · expressive, Arabic supported",
    arabic: true,
    voices: [{ id: "a167e0f3-df7e-4d52-a9c3-f949145efdab", label: "Blake · male" }],
  },
  {
    id: "xai/tts-1",
    label: "xAI TTS-1 · Ara / Eve / Rex voices, Arabic (ar-AE)",
    arabic: true,
    voices: [
      { id: "Ara", label: "Ara · warm friendly female" },
      { id: "Eve", label: "Eve · natural female" },
      { id: "Rex", label: "Rex · confident male" },
      { id: "Sal", label: "Sal · calm male" },
      { id: "Leo", label: "Leo · energetic male" },
      { id: "Carina", label: "Carina" },
      { id: "Luna", label: "Luna" },
    ],
  },
  {
    id: "rime/mistv3",
    label: "Rime Mist v3 · English",
    arabic: false,
    voices: [
      { id: "astra", label: "Astra · female" },
      { id: "celeste", label: "Celeste · female" },
      { id: "luna", label: "Luna · female" },
    ],
  },
  {
    id: "deepgram/aura-2",
    label: "Deepgram Aura-2 · English",
    arabic: false,
    voices: [
      { id: "thalia", label: "Thalia · female" },
      { id: "asteria", label: "Asteria · female" },
      { id: "orion", label: "Orion · male" },
    ],
  },
];

// STT language hint from the agent's configured language label.
export function livekitSttLanguage(language?: string | null): string {
  const l = (language ?? "").toLowerCase();
  if (!l || /\+/.test(l)) return ""; // multilingual / unspecified → auto-detect
  if (/arabic/.test(l)) return "ar";
  if (/english/.test(l)) return "en";
  if (/spanish/.test(l)) return "es";
  if (/french/.test(l)) return "fr";
  if (/hindi/.test(l)) return "hi";
  if (/urdu/.test(l)) return "ur";
  if (/russian/.test(l)) return "ru";
  if (/german/.test(l)) return "de";
  if (/portuguese/.test(l)) return "pt";
  if (/tagalog|filipino/.test(l)) return "tl";
  return "";
}

// Human label shown for an agent's voice under LiveKit ("Ashley · Inworld TTS-2").
export function livekitVoiceLabel(s: Partial<LivekitAgentSettings> | undefined): string {
  const tts = s?.tts || LIVEKIT_DEFAULTS.tts;
  const voice = s?.voice || LIVEKIT_DEFAULTS.voice;
  const model = LIVEKIT_TTS.find((m) => m.id === tts);
  const v = model?.voices.find((x) => x.id === voice);
  const short = model ? model.label.split(" · ")[0] : tts;
  return `${v ? v.label.split(" · ")[0] : voice} · ${short}`;
}
