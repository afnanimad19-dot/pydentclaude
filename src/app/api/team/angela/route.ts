import { NextRequest, NextResponse } from "next/server";
import { getRecallPatients, listTemplates, scheduleBroadcast } from "@/lib/angela-data";
import { logActivity } from "@/lib/activity";

// Angela — AI Patient Email & WhatsApp Marketing. Writes recalls, newsletters,
// win-backs and email/WhatsApp copy (in chat), and has real tools to find recall
// patients and schedule a WhatsApp broadcast through the existing system.

export const runtime = "nodejs";
export const maxDuration = 90;

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function call(apiKey: string, body: Record<string, any>) {
  const res = await fetch(OPENROUTER, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.TEAM_AI_MODEL ?? "openai/gpt-4o-mini", max_tokens: 2200, ...body }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "find_recall_patients",
      description: "List patients due for recall (flagged, or not seen in N months) so we can plan a recall campaign.",
      parameters: { type: "object", properties: { months: { type: "number", description: "Months since last visit to count as due (default 6)." } } },
    },
  },
  {
    type: "function",
    function: {
      name: "list_whatsapp_templates",
      description: "List the clinic's WhatsApp message templates and their approval status (broadcasts need an APPROVED template).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_whatsapp_broadcast",
      description: "Schedule a WhatsApp broadcast using an APPROVED template, to a folder or everyone.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Campaign name" },
          template_name: { type: "string" },
          folder_name: { type: "string", description: "Audience folder name, or leave empty for everyone." },
          scheduled_for: { type: "string", description: "Optional ISO datetime to send; empty = no fixed time." },
        },
        required: ["name", "template_name"],
      },
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
    "You are Angela, an AI Patient Email & WhatsApp Marketing manager for a dental clinic. You write recall reminders, newsletters, seasonal promos, win-back messages, post-treatment follow-ups, and WhatsApp broadcast copy. Always produce ready-to-use copy (subject line + body for email; short, template-friendly text for WhatsApp).",
    website ? `The clinic's website is ${website} — match its brand and tone.` : "",
    "Use find_recall_patients to see who's due before planning a recall. WhatsApp broadcasts can only use an APPROVED template — use list_whatsapp_templates to check, and only call schedule_whatsapp_broadcast when the user clearly approves the campaign + template.",
    "Keep it compliant: no medical advice/guarantees, include an easy opt-out for email, and keep WhatsApp copy within template rules.",
  ].filter(Boolean).join("\n\n");

  const msgs: any[] = [{ role: "system", content: system }, ...(messages ?? []).slice(-16)];

  async function exec(name: string, args: any): Promise<string> {
    if (name === "find_recall_patients") return getRecallPatients(workspaceId, Number(args.months) || 6);
    if (name === "list_whatsapp_templates") return listTemplates(workspaceId);
    if (name === "schedule_whatsapp_broadcast") {
      const res = await scheduleBroadcast(workspaceId, { name: String(args.name || "Campaign"), templateName: String(args.template_name || ""), folderName: args.folder_name ? String(args.folder_name) : undefined, scheduledFor: args.scheduled_for ? String(args.scheduled_for) : undefined });
      if (res.startsWith("Scheduled")) await logActivity(workspaceId, "angela", "Scheduled WhatsApp broadcast", String(args.name || "Campaign"));
      return res;
    }
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
    return NextResponse.json({ error: e instanceof Error ? e.message : "Angela failed." }, { status: 502 });
  }
}
