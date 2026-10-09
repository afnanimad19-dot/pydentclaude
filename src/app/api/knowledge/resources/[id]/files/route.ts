import type { NextRequest } from "next/server";
import { knowledgeDeps } from "@/lib/knowledge-server";
import { withKnowledge } from "@/lib/knowledge-route";
import { uploadFile } from "@/lib/knowledge-service";

// Upload a file into a File resource (owner/manager). Multipart: `file`
// (+ optional `name`). Text is extracted on the server by the shared A3
// library; a same-named file replaces its document in place.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withKnowledge(knowledgeDeps(req), "write", "upload", async ({ ws, userId, store, extract, now }) => {
    let file: { buf: Buffer; name: string; mime: string } | null = null;
    try {
      const form = await req.formData();
      const f = form.get("file");
      if (f instanceof Blob) {
        const name = (typeof form.get("name") === "string" && String(form.get("name")).trim()) || (f instanceof File ? f.name : "") || "document";
        file = { buf: Buffer.from(await f.arrayBuffer()), name, mime: f.type || "" };
      }
    } catch {
      file = null;
    }
    return uploadFile(store, ws, userId, id, file, extract, now);
  });
}
