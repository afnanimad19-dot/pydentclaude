// Generates a marketing image from a text prompt and returns raw PNG/JPEG bytes
// (for uploading to WordPress / Instagram). Order of engines:
//   1. The marketing engine's image toolkit (nano-banana class models) — the
//      clinic's Hyperfx account does the generation, no extra keys needed.
//   2. OpenRouter's image-capable models (OPENROUTER_API_KEY).
//   3. OpenAI Images (OPENAI_API_KEY) — last resort only.

import { getHfxCreds, hfxCall, hfxConfigured, hfxListTools } from "@/lib/hyperfx";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Generate through the marketing engine's image_gen toolkit. Tool names/schemas
// are discovered at runtime (their catalog lists each toolkit's tools), so this
// keeps working when the engine renames or adds models.
async function viaEngine(ws: string | null, prompt: string): Promise<{ ok: boolean; bytes?: Buffer; mime?: string; error?: string }> {
  const creds = await getHfxCreds(ws);
  if (!hfxConfigured(creds)) return { ok: false, error: "Marketing engine not configured." };

  // Find the generation tool on the image toolkit.
  const cat = await hfxCall("discover_toolkits", { query: "image generation" }, creds);
  let toolName = "";
  if (cat.ok && Array.isArray(cat.data)) {
    const tk = (cat.data as any[]).find((t) => t?.id === "image_gen") ?? (cat.data as any[]).find((t) => /image/i.test(String(t?.id)));
    const names: string[] = (tk?.tools ?? []).map(String);
    toolName = names.find((n) => /generat|create|text_to/i.test(n) && /image/i.test(n)) ?? names.find((n) => /image/i.test(n)) ?? "";
  }
  if (!toolName) return { ok: false, error: "No image tool available on the engine." };

  let r = await hfxCall(toolName, { prompt }, creds);
  // If the tool wants a differently-named argument, learn its schema and retry once.
  if (!r.ok && /required|invalid|argument|param|validation|unexpected/i.test(r.error ?? "")) {
    const tools = await hfxListTools(creds);
    const schema: any = tools.tools?.find((t) => t.name === toolName)?.inputSchema;
    const props: Record<string, any> = schema?.properties ?? {};
    const key =
      (Array.isArray(schema?.required) ? schema.required : []).find((k: string) => props[k]?.type === "string") ??
      Object.keys(props).find((k) => props[k]?.type === "string");
    if (key && key !== "prompt") r = await hfxCall(toolName, { [key]: prompt }, creds);
  }
  if (!r.ok) return { ok: false, error: r.error };

  // 1) MCP image content block (base64).
  const imgBlock = (r.content ?? []).find((c: any) => c?.type === "image" && c?.data) as any;
  if (imgBlock) return { ok: true, bytes: Buffer.from(String(imgBlock.data), "base64"), mime: imgBlock.mimeType ?? "image/png" };
  // 2) A data: URL anywhere in the result.
  const txt = typeof r.data === "string" ? r.data : JSON.stringify(r.data ?? "");
  const dataUrl = txt.match(/data:(image\/\w+);base64,([A-Za-z0-9+/=]+)/);
  if (dataUrl) return { ok: true, bytes: Buffer.from(dataUrl[2], "base64"), mime: dataUrl[1] };
  // 3) A hosted image URL — download it.
  const urlMatch = txt.match(/https?:\/\/[^\s"'\\)}\]]+/g)?.find((u) => /\.(png|jpe?g|webp)(\?|$)/i.test(u)) ?? txt.match(/https?:\/\/[^\s"'\\)}\]]+/)?.[0];
  if (urlMatch) {
    try {
      const res = await fetch(urlMatch, { signal: AbortSignal.timeout(45000) });
      const mime = (res.headers.get("content-type") ?? "").split(";")[0];
      if (res.ok && mime.startsWith("image/")) return { ok: true, bytes: Buffer.from(await res.arrayBuffer()), mime };
    } catch { /* fall through */ }
  }
  return { ok: false, error: "The engine's image tool returned no readable image." };
}

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
  const images = data?.choices?.[0]?.message?.images as any[] | undefined;
  const url: string | undefined = images?.[0]?.image_url?.url ?? images?.[0]?.url;
  const m = url?.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!m) return { ok: false, error: "No image returned by the model (try a different OPENROUTER_IMAGE_MODEL)." };
  return { ok: true, bytes: Buffer.from(m[2], "base64"), mime: m[1] };
}

export async function generateImage(prompt: string, ws: string | null = null): Promise<{ ok: boolean; bytes?: Buffer; mime?: string; error?: string }> {
  const openai = process.env.OPENAI_API_KEY;
  const openrouter = process.env.OPENROUTER_API_KEY;
  const errors: string[] = [];
  // 1) The marketing engine (clinic's Hyperfx account) does the generation.
  try {
    const r = await viaEngine(ws, prompt);
    if (r.ok) return r;
    if (r.error) errors.push(`engine: ${r.error}`);
  } catch (e) {
    errors.push(`engine: ${e instanceof Error ? e.message : "failed"}`);
  }
  // 2) OpenRouter image models.
  if (openrouter) {
    try {
      const r = await viaOpenRouter(openrouter, prompt);
      if (r.ok) return r;
      if (r.error) errors.push(`openrouter: ${r.error}`);
    } catch (e) {
      errors.push(`openrouter: ${e instanceof Error ? e.message : "failed"}`);
    }
  }
  // 3) OpenAI — last resort only.
  if (openai) {
    try {
      const r = await viaOpenAI(openai, prompt);
      if (r.ok) return r;
      if (r.error) errors.push(`openai: ${r.error}`);
    } catch (e) {
      errors.push(`openai: ${e instanceof Error ? e.message : "failed"}`);
    }
  }
  return { ok: false, error: errors.length ? errors.join(" · ") : "No image engine is configured." };
}
