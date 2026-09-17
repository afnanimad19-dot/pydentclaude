import { NextRequest, NextResponse } from "next/server";
import { resilientChat, LIVEKIT_MODEL_PREFIX } from "@/lib/agent-reply";

// Stage-1 diagnostic for the LiveKit Inference chat provider (Settings →
// LiveKit / deploy checks). Sends one tiny fixed prompt through the SAME
// gateway path the chat agents use and reports whether the reply came back.
//
//   GET /api/livekit/chat-test?ws=<workspace id>[&model=xai/grok-4.3]
//
// Auth: the LiveKit JWT is minted server-side from the clinic's saved
// credentials (or LIVEKIT_* env). No OpenRouter key and NO xAI key is read on
// this path — usage bills to the LiveKit Cloud project. The response never
// contains credentials.
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const ws = req.nextUrl.searchParams.get("ws") ?? undefined;
  const model = (req.nextUrl.searchParams.get("model") || "xai/grok-4.3").replace(/^livekit:/, "");
  const started = Date.now();
  try {
    const data = await resilientChat("", `${LIVEKIT_MODEL_PREFIX}${model}`, {
      messages: [{ role: "user", content: "Reply with exactly: LIVEKIT_GROK_OK" }],
      max_tokens: 200,
    }, { ws, agentName: "chat-test" });
    const reply = String(data.choices?.[0]?.message?.content ?? "").trim();
    return NextResponse.json({
      ok: reply.includes("LIVEKIT_GROK_OK"),
      provider: "livekit-inference",
      model,
      reply,
      latencyMs: Date.now() - started,
      xaiKeyUsed: false, // this path never reads XAI_API_KEY / X_AI_VOICE_KEY
      note: reply.includes("LIVEKIT_GROK_OK")
        ? "LiveKit Inference is working — chat agents can use the LiveKit Grok models."
        : "The gateway answered but not with the expected marker — see `reply`.",
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        provider: "livekit-inference",
        model,
        latencyMs: Date.now() - started,
        xaiKeyUsed: false,
        error: e instanceof Error ? e.message : "request failed",
      },
      { status: 502 }
    );
  }
}
