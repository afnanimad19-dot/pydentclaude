import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { markdownToDocx, markdownToHtml } from "@/lib/report-render";

// Serves a saved report as a downloadable .docx, or as print-ready HTML
// (browser → "Save as PDF"). ?format=docx | html (default html).

export const runtime = "nodejs";

function db() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://mzqynjywncbvqfikbzgm.supabase.co";
  return createClient(url, key ?? "");
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const format = req.nextUrl.searchParams.get("format") ?? "html";
  const { data } = await db().from("reports").select("title, content_md").eq("id", id).maybeSingle();
  if (!data) return new NextResponse("Report not found.", { status: 404 });

  const safe = (data.title || "report").replace(/[^a-z0-9-_ ]/gi, "").slice(0, 60).trim() || "report";
  if (format === "docx") {
    const buf = await markdownToDocx(data.title, data.content_md);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${safe}.docx"`,
      },
    });
  }
  return new NextResponse(markdownToHtml(data.title, data.content_md), { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
