import { NextRequest, NextResponse } from "next/server";

// Extracts plain text from an uploaded knowledge-base document so the agent can
// actually read it. Supports PDF (pdf-parse) and Word .docx (mammoth); plain
// text formats are read client-side and don't hit this route.

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "No file received." }, { status: 400 });
  }
  const name = (form.get("name") as string) || "document";
  const buf = Buffer.from(await file.arrayBuffer());

  try {
    let text = "";
    if (/\.pdf$/i.test(name)) {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: buf });
      const result = await parser.getText();
      text = result.text ?? "";
      await parser.destroy();
    } else if (/\.docx$/i.test(name)) {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer: buf });
      text = result.value ?? "";
    } else if (/\.doc$/i.test(name)) {
      return NextResponse.json(
        { error: "Legacy .doc isn't supported — please save it as .docx or PDF." },
        { status: 415 }
      );
    } else {
      return NextResponse.json({ error: "Unsupported file type." }, { status: 415 });
    }

    text = text.replace(/\n{3,}/g, "\n\n").trim();
    if (!text) {
      return NextResponse.json(
        { error: "Couldn't extract text (the file may be scanned images, not real text)." },
        { status: 422 }
      );
    }
    return NextResponse.json({ ok: true, text: text.slice(0, 200_000) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to read the document." },
      { status: 500 }
    );
  }
}
