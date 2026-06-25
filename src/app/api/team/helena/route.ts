import { NextRequest, NextResponse } from "next/server";
import { wpPublishPost, wpUploadMedia } from "@/lib/wp-publish";
import { generateImage } from "@/lib/image-gen";
import { runAnalyticsReport, runSearchConsoleReport } from "@/lib/google-api";
import { postToFacebookPage, postToInstagram } from "@/lib/meta-api";

// Helena — AI Dental Marketing Manager with real tools:
//  • generate_featured_image → make an image + upload to WordPress
//  • publish_blog_post       → create a post (draft by default) on the clinic's WP
// The model writes the content; the tools do the actual work via the connection.

export const runtime = "nodejs";
export const maxDuration = 120;

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function call(apiKey: string, body: Record<string, any>) {
  const res = await fetch(OPENROUTER, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/gpt-4o-mini", max_tokens: 3200, ...body }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "generate_featured_image",
      description: "Generate a marketing image and upload it to the clinic's WordPress media library. Returns a media id to use as a post's featured image.",
      parameters: {
        type: "object",
        properties: { prompt: { type: "string", description: "Vivid description of the image — dental, on-brand, photographic, no text overlays." } },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "publish_blog_post",
      description: "Create a blog post on the clinic's WordPress site. Defaults to a draft for the team to review.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          content_html: { type: "string", description: "Full post body as clean HTML (use <h2>, <p>, <ul>). 600-1200 words." },
          excerpt: { type: "string" },
          status: { type: "string", enum: ["draft", "publish"], description: "draft (default) or publish" },
          featured_media_id: { type: "number", description: "Media id returned by generate_featured_image, if a featured image was made." },
        },
        required: ["title", "content_html"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_analytics_report",
      description: "Pull a Google Analytics (GA4) traffic summary for the clinic — sessions, users, pageviews and top pages.",
      parameters: { type: "object", properties: { days: { type: "number", description: "Look-back window in days (default 28)." } } },
    },
  },
  {
    type: "function",
    function: {
      name: "get_search_console_report",
      description: "Pull Google Search Console — the clinic's top search queries with clicks, impressions and average position.",
      parameters: { type: "object", properties: { days: { type: "number", description: "Look-back window in days (default 28)." } } },
    },
  },
  {
    type: "function",
    function: {
      name: "post_to_facebook",
      description: "Publish a text post to the clinic's connected Facebook Page.",
      parameters: { type: "object", properties: { message: { type: "string" }, link: { type: "string", description: "Optional link to include." } }, required: ["message"] },
    },
  },
  {
    type: "function",
    function: {
      name: "post_to_instagram",
      description: "Publish an image post to the clinic's connected Instagram. Generates the image from image_prompt and uses it as the post photo.",
      parameters: { type: "object", properties: { caption: { type: "string" }, image_prompt: { type: "string", description: "Description of the photo to generate for the post." } }, required: ["caption", "image_prompt"] },
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
    "You are Helena, an AI Dental Marketing Manager for a dental clinic. You plan content, write SEO blog posts and social copy, and publish to the clinic's connected channels.",
    website ? `The clinic's website is ${website} — match its brand, services and tone.` : "",
    "When the user asks you to publish/create a blog: write the full article yourself, then call publish_blog_post with clean HTML. Default to status 'draft' unless they clearly say publish/go live.",
    "If they want a featured image (or it would help), call generate_featured_image FIRST, then pass its media id as featured_media_id to publish_blog_post.",
    "You can also: pull Google Analytics (get_analytics_report) and Search Console (get_search_console_report); post to Facebook (post_to_facebook) and Instagram (post_to_instagram, which generates the photo). Only post to a channel when the user clearly asks; for social posts, draft the caption and confirm before posting unless they say go ahead.",
    "Keep dental claims compliant: no guarantees, no medical advice, no diagnosis. After a tool runs, tell the user plainly what happened and share the link/result.",
  ].filter(Boolean).join("\n\n");

  const msgs: any[] = [{ role: "system", content: system }, ...(messages ?? []).slice(-16)];

  async function exec(name: string, args: any): Promise<string> {
    if (name === "generate_featured_image") {
      const img = await generateImage(String(args.prompt || ""));
      if (!img.ok || !img.bytes) return `Image not created: ${img.error}`;
      const up = await wpUploadMedia(workspaceId, img.bytes, "featured.png", img.mime ?? "image/png");
      if (!up.ok) return `Image made but upload failed: ${up.error}`;
      return JSON.stringify({ media_id: up.id, url: up.url });
    }
    if (name === "publish_blog_post") {
      const r = await wpPublishPost(workspaceId, {
        title: String(args.title || "Untitled"),
        contentHtml: String(args.content_html || ""),
        status: args.status === "publish" ? "publish" : "draft",
        featuredMedia: typeof args.featured_media_id === "number" ? args.featured_media_id : undefined,
        excerpt: args.excerpt ? String(args.excerpt) : undefined,
      });
      if (!r.ok) return `Could not publish: ${r.error}`;
      return `Saved as ${args.status === "publish" ? "published" : "draft"} on WordPress. Edit/preview: ${r.editLink}`;
    }
    if (name === "get_analytics_report") return runAnalyticsReport(workspaceId, Number(args.days) || 28);
    if (name === "get_search_console_report") return runSearchConsoleReport(workspaceId, Number(args.days) || 28);
    if (name === "post_to_facebook") return postToFacebookPage(workspaceId, String(args.message || ""), args.link ? String(args.link) : undefined);
    if (name === "post_to_instagram") {
      // Instagram needs a public image URL — generate the image and host it on WordPress media.
      const img = await generateImage(String(args.image_prompt || ""));
      if (!img.ok || !img.bytes) return `Couldn't make the image: ${img.error}`;
      const up = await wpUploadMedia(workspaceId, img.bytes, "ig-post.png", img.mime ?? "image/png");
      if (!up.ok || !up.url) return `Image upload failed (Instagram needs a public image): ${up.error}`;
      return postToInstagram(workspaceId, String(args.caption || ""), up.url);
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
    return NextResponse.json({ error: e instanceof Error ? e.message : "Helena failed." }, { status: 502 });
  }
}
