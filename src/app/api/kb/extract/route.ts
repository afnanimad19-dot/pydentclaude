import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/server-auth-deps";
import { withKbAuth } from "@/lib/kb-auth";
import { extractDocument, extractResponse } from "@/lib/kb-extract";

// Extracts plain text from an uploaded knowledge-base document so the agent can
// actually read it (PDF, Word .docx, legacy .doc, OCR for scans and page
// photos). The extraction itself lives in lib/kb-extract.ts (shared with the
// Central Knowledge Base); this route only handles HTTP: authorization, the
// multipart upload, and the response.

export const runtime = "nodejs";
export const maxDuration = 60;

// Requires a signed-in workspace member (no workspace data is read, but the
// parser/OCR must not be free public compute).
export async function POST(req: NextRequest) {
  return withKbAuth(() => authorizeRequest(req), () => extract(req));
}

async function extract(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "No file received." }, { status: 400 });
  }
  const name = (form.get("name") as string) || "document";
  const mime = (file as Blob).type || "";
  const buf = Buffer.from(await file.arrayBuffer());
  const out = extractResponse(await extractDocument({ buf, name, mime }));
  return NextResponse.json(out.body, { status: out.status });
}
