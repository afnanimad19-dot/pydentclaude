// Generates a marketing image from a text prompt and returns raw PNG/JPEG bytes
// (for uploading to WordPress / Instagram). Prefers OpenAI Images (DALL·E 3) when
// OPENAI_API_KEY is set; otherwise falls back to OpenRouter's image-capable models
// (e.g. Gemini "nano-banana"), so image generation works with just OPENROUTER_API_KEY.

async function viaOpenAI(key: string, prompt: string): Promise<{ ok: boolean; bytes?: Buffer; mime?: string; error?: string }> {
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "dall-e-3", prompt: prompt.slice(0, 3500), n: 1, size: "1024x1024", response_format: "b64_json" }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data?.error?.message ?? `Image generation failed (${res.status}).` };
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) return { ok: false, error: "No image returned." };
  return { ok: true, bytes: Buffer.from(b64, "base64"), mime: "image/png" };
}

// OpenRouter returns generated images as data URLs on the assistant message
// (message.images[].image_url.url = "data:image/png;base64,...").
async function viaOpenRouter(key: string, prompt: string): Promise<{ ok: boolean; bytes?: Buffer; mime?: string; error?: string }> {
  const model = process.env.OPENROUTER_IMAGE_MODEL ?? "google/gemini-2.5-flash-image-preview";
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      modalities: ["image", "text"],
      messages: [{ role: "user", content: `Generate a high-quality, on-brand dental marketing image (photographic, no text overlays): ${prompt.slice(0, 1500)}` }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data?.error?.message ?? `Image generation failed (${res.status}).` };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const images = data?.choices?.[0]?.message?.images as any[] | undefined;
  const url: string | undefined = images?.[0]?.image_url?.url ?? images?.[0]?.url;
  const m = url?.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!m) return { ok: false, error: "No image returned by the model (try a different OPENROUTER_IMAGE_MODEL)." };
  return { ok: true, bytes: Buffer.from(m[2], "base64"), mime: m[1] };
}

export async function generateImage(prompt: string): Promise<{ ok: boolean; bytes?: Buffer; mime?: string; error?: string }> {
  const openai = process.env.OPENAI_API_KEY;
  const openrouter = process.env.OPENROUTER_API_KEY;
  try {
    // Try OpenAI first when its key exists, but NEVER dead-end on it: an invalid/
    // expired OPENAI_API_KEY (401) must fall through to OpenRouter, which is the
    // key the app actually runs on.
    if (openai) {
      const r = await viaOpenAI(openai, prompt);
      if (r.ok || !openrouter) return r;
    }
    if (openrouter) return await viaOpenRouter(openrouter, prompt);
    return { ok: false, error: "Image generation needs OPENAI_API_KEY or OPENROUTER_API_KEY." };
  } catch (e) {
    if (openrouter) {
      try { return await viaOpenRouter(openrouter, prompt); } catch { /* fall through */ }
    }
    return { ok: false, error: e instanceof Error ? e.message : "Image generation failed." };
  }
}
