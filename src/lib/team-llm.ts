// Shared OpenRouter caller for the AI marketing team (Helena / Sam / Kai /
// Angela). OpenRouter is the part that WRITES the words; Hyperfx is the tool
// engine that fetches data and performs actions — so an empty OpenRouter
// balance stops replies no matter how healthy Hyperfx is. Handle that case
// gracefully: a 402 ("requires more credits") retries with progressively
// smaller max_tokens — a nearly-empty balance can usually still afford a short
// reply — and if it still can't run, we surface a plain-language message with
// the fix instead of raw error JSON.

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function teamLlmCall(apiKey: string, body: Record<string, any>, maxTokens = 2200): Promise<any> {
  const attempt = (mt: number) =>
    fetch(OPENROUTER, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.TEAM_AI_MODEL ?? "openai/gpt-4o-mini", max_tokens: mt, ...body }),
    });
  let res = await attempt(maxTokens);
  for (const mt of [1200, 500]) {
    if (res.status !== 402) break;
    res = await attempt(mt);
  }
  if (res.status === 402) {
    throw new Error(
      "I'm out of AI credits right now — OpenRouter (which writes my replies; Hyperfx only fetches the data) needs a top-up at openrouter.ai → Credits. Add credits and ask me again."
    );
  }
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
/* eslint-enable @typescript-eslint/no-explicit-any */
