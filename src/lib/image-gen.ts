// Generates a marketing image from a text prompt. Uses OpenAI Images (DALL·E 3)
// when OPENAI_API_KEY is set. Returns raw PNG bytes (for uploading to WordPress).

export async function generateImage(prompt: string): Promise<{ ok: boolean; bytes?: Buffer; mime?: string; error?: string }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ok: false, error: "Image generation needs OPENAI_API_KEY in Netlify." };
  try {
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "dall-e-3",
        prompt: prompt.slice(0, 3500),
        n: 1,
        size: "1024x1024",
        response_format: "b64_json",
      }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.error?.message ?? `Image generation failed (${res.status}).` };
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) return { ok: false, error: "No image returned." };
    return { ok: true, bytes: Buffer.from(b64, "base64"), mime: "image/png" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Image generation failed." };
  }
}
