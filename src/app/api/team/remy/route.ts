import { NextRequest, NextResponse } from "next/server";
import { remember, recall, listMemories } from "@/lib/memory";

// Remy — AI Knowledge & Memory Manager. The clinic's long-term memory: tell it
// facts and it remembers them; ask and it recalls. Keeps the whole AI team current.

export const runtime = "nodejs";
export const maxDuration = 60;

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function call(apiKey: string, body: Record<string, any>) {
  const res = await fetch(OPENROUTER, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.TEAM_AI_MODEL ?? "openai/gpt-4o-mini", max_tokens: 1500, ...body }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "remember",
      description: "Save a fact about the clinic to long-term memory (promos, staff, policies, preferences, decisions).",
      parameters: { type: "object", properties: { note: { type: "string" }, tag: { type: "string", description: "Optional category, e.g. promo, staff, policy, hours." } }, required: ["note"] },
    },
  },
  {
    type: "function",
    function: {
      name: "recall",
      description: "Look up remembered facts matching a query.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_memories",
      description: "List everything currently remembered about the clinic.",
      parameters: { type: "object", properties: {} },
    },
  },
];

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "OPENROUTER_API_KEY is not configured." }, { status: 503 });
  const { workspaceId, website, brand, messages } = await req.json().catch(() => ({}));
  if (!workspaceId) return NextResponse.json({ error: "Missing workspace." }, { status: 400 });

  const system = [
    brand ? `CLINIC BRAND KNOWLEDGE:\n${brand}` : "",
    "You are Remy, the clinic's AI Knowledge & Memory Manager. You keep a reliable long-term memory of facts about the clinic — promotions, staff, policies, services, preferences and decisions — so the whole AI team stays accurate.",
    website ? `The clinic's website is ${website}.` : "",
    "When the user states a fact ('we run a July whitening promo', 'Dr. Khan joined as a hygienist', 'we never quote prices on WhatsApp'), call remember to save it. When they ask something, call recall (or list_memories) and answer from saved memory. Confirm clearly what you saved. Don't invent facts — only store what the user tells you.",
  ].filter(Boolean).join("\n\n");

  const msgs: any[] = [{ role: "system", content: system }, ...(messages ?? []).slice(-16)];

  async function exec(name: string, args: any): Promise<string> {
    if (name === "remember") return remember(workspaceId, String(args.note || ""), String(args.tag || ""));
    if (name === "recall") return recall(workspaceId, String(args.query || ""));
    if (name === "list_memories") return listMemories(workspaceId);
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
    return NextResponse.json({ error: e instanceof Error ? e.message : "Remy failed." }, { status: 502 });
  }
}
