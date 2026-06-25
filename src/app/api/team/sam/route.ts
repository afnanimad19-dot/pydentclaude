import { NextRequest, NextResponse } from "next/server";
import { runSearchConsoleReport, runSearchConsolePages, postToGoogleBusiness } from "@/lib/google-api";
import { auditPageSeo } from "@/lib/seo-audit";

// Sam — AI Dental SEO / Local Search Manager. Real tools: Search Console rankings
// (queries + pages), a live on-page SEO audit, and Google Business Profile posts.

export const runtime = "nodejs";
export const maxDuration = 90;

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function call(apiKey: string, body: Record<string, any>) {
  const res = await fetch(OPENROUTER, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/gpt-4o-mini", max_tokens: 2000, ...body }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_top_queries",
      description: "Pull the clinic's top Google search queries from Search Console (clicks, impressions, position).",
      parameters: { type: "object", properties: { days: { type: "number", description: "Look-back in days (default 28)." } } },
    },
  },
  {
    type: "function",
    function: {
      name: "get_top_pages",
      description: "Pull the clinic's top-performing pages from Search Console.",
      parameters: { type: "object", properties: { days: { type: "number", description: "Look-back in days (default 28)." } } },
    },
  },
  {
    type: "function",
    function: {
      name: "audit_page_seo",
      description: "Audit a specific page's on-page SEO (title, meta, headings, word count, schema) and return fixes.",
      parameters: { type: "object", properties: { url: { type: "string", description: "Full URL of the page to audit." } }, required: ["url"] },
    },
  },
  {
    type: "function",
    function: {
      name: "post_to_google_business",
      description: "Publish an update post to the clinic's Google Business Profile.",
      parameters: { type: "object", properties: { summary: { type: "string" }, cta_url: { type: "string", description: "Optional 'Learn more' link." } }, required: ["summary"] },
    },
  },
];

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "OPENROUTER_API_KEY is not configured." }, { status: 503 });
  const { workspaceId, website, brand, messages } = await req.json().catch(() => ({}));
  if (!workspaceId) return NextResponse.json({ error: "Missing workspace." }, { status: 400 });

  const system = [
    brand ? `CLINIC BRAND KNOWLEDGE (use this so you sound like the clinic and use its real facts):
` : "",
    "You are Sam, an AI Dental SEO / Local Search Manager for a dental clinic. You improve local search ('dentist near me', city + treatment keywords), the Google Business Profile, rankings and on-page SEO.",
    website ? `The clinic's website is ${website}.` : "",
    "Use get_top_queries / get_top_pages to ground advice in real Search Console data. Use audit_page_seo to check a page and give concrete fixes (titles, meta, schema). Only call post_to_google_business when the user clearly asks to post; confirm the wording first.",
    "Give specific, dental-relevant recommendations. Keep claims compliant (no guarantees, no medical advice).",
  ].filter(Boolean).join("\n\n");

  const msgs: any[] = [{ role: "system", content: system }, ...(messages ?? []).slice(-16)];

  async function exec(name: string, args: any): Promise<string> {
    if (name === "get_top_queries") return runSearchConsoleReport(workspaceId, Number(args.days) || 28);
    if (name === "get_top_pages") return runSearchConsolePages(workspaceId, Number(args.days) || 28);
    if (name === "audit_page_seo") return auditPageSeo(String(args.url || website || ""));
    if (name === "post_to_google_business") return postToGoogleBusiness(workspaceId, String(args.summary || ""), args.cta_url ? String(args.cta_url) : undefined);
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
    return NextResponse.json({ error: e instanceof Error ? e.message : "Sam failed." }, { status: 502 });
  }
}
