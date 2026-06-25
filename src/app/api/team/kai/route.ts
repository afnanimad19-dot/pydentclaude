import { NextRequest, NextResponse } from "next/server";
import { getGoogleReviews, replyToGoogleReview } from "@/lib/google-api";
import { getFacebookReviews } from "@/lib/meta-api";

// Kai — AI Reputation & Social Listening. Real tools: pull Google & Facebook
// reviews, and post a reply to a Google review. Sentiment, flagging unhappy
// patients, and reply drafting are done by the model on the pulled data.

export const runtime = "nodejs";
export const maxDuration = 90;

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function call(apiKey: string, body: Record<string, any>) {
  const res = await fetch(OPENROUTER, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.TEAM_AI_MODEL ?? "openai/gpt-4o-mini", max_tokens: 2000, ...body }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_google_reviews",
      description: "Pull recent Google reviews (star rating + text + review id) for the clinic.",
      parameters: { type: "object", properties: { max: { type: "number", description: "How many to fetch (default 10)." } } },
    },
  },
  {
    type: "function",
    function: {
      name: "get_facebook_reviews",
      description: "Pull recent Facebook Page recommendations / reviews for the clinic.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "reply_to_google_review",
      description: "Post a public reply to a specific Google review (use the review id from get_google_reviews).",
      parameters: { type: "object", properties: { review_id: { type: "string" }, comment: { type: "string" } }, required: ["review_id", "comment"] },
    },
  },
];

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "OPENROUTER_API_KEY is not configured." }, { status: 503 });
  const { workspaceId, website, brand, messages } = await req.json().catch(() => ({}));
  if (!workspaceId) return NextResponse.json({ error: "Missing workspace." }, { status: 400 });

  const system = [
    brand ? `CLINIC BRAND KNOWLEDGE (use this so you sound like the clinic and use its real facts):\n${brand}` : "",
    "You are Kai, an AI Reputation & Social Listening manager for a dental clinic. You monitor reviews and mentions, read patient sentiment, flag unhappy patients so the team can fix it fast, and draft warm, on-brand replies.",
    website ? `The clinic's website is ${website}.` : "",
    "When asked about reviews/reputation, call get_google_reviews and/or get_facebook_reviews first, then summarise sentiment, highlight any negative or urgent ones at the top, and offer draft replies.",
    "Only call reply_to_google_review when the user clearly approves a specific reply; show them the draft first. Replies must be empathetic, never argue, never share private health details, and invite the patient to contact the clinic to make it right.",
  ].filter(Boolean).join("\n\n");

  const msgs: any[] = [{ role: "system", content: system }, ...(messages ?? []).slice(-16)];

  async function exec(name: string, args: any): Promise<string> {
    if (name === "get_google_reviews") return getGoogleReviews(workspaceId, Number(args.max) || 10);
    if (name === "get_facebook_reviews") return getFacebookReviews(workspaceId);
    if (name === "reply_to_google_review") return replyToGoogleReview(workspaceId, String(args.review_id || ""), String(args.comment || ""));
    return "Unknown tool.";
  }

  try {
    for (let round = 0; round < 5; round++) {
      const data = await call(apiKey, { messages: msgs, tools: TOOLS, tool_choice: "auto" });
      const msg = data.choices?.[0]?.message;
      if (!msg?.tool_calls?.length) return NextResponse.json({ reply: msg?.content ?? "" });
      msgs.push(msg);
      for (const tc of msg.tool_calls) {
        let result: string;
        try {
          result = await exec(tc.function?.name, JSON.parse(tc.function?.arguments || "{}"));
        } catch (e) {
          result = `Error: ${e instanceof Error ? e.message : "failed"}`;
        }
        msgs.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
    }
    const final = await call(apiKey, { messages: msgs });
    return NextResponse.json({ reply: final.choices?.[0]?.message?.content ?? "" });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Kai failed." }, { status: 502 });
  }
}
