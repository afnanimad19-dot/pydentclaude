import { NextRequest, NextResponse } from "next/server";

// Extracts plain text from an uploaded knowledge-base document so the agent can
// actually read it. Supports PDF (pdf-parse), Word .docx (mammoth) and a
// best-effort scrape of legacy .doc. Plain-text formats are read client-side and
// don't hit this route.
//
// Robustness: browsers/OSes sometimes send a document with the wrong (or no)
// file extension, or a generic MIME type â which used to make this route reject
// a perfectly readable PDF/Word file. So we sniff the actual bytes (magic
// numbers) and fall back to the extension/MIME only when the bytes are
// inconclusive. Each parser is wrapped on its own so a failure names the format.

export const runtime = "nodejs";
export const maxDuration = 60;

type Kind = "pdf" | "docx" | "doc" | "unknown";

// Identify the format from the file's leading bytes â the most reliable signal.
function sniff(buf: Buffer): Kind {
  if (buf.length >= 5 && buf.toString("latin1", 0, 5) === "%PDF-") return "pdf";
  // ZIP container (PK\x03\x04). .docx is a zip; check for word/ inside to be sure.
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) {
    const head = buf.toString("latin1", 0, Math.min(buf.length, 4000));
    if (head.includes("word/") || head.includes("[Content_Types].xml")) return "docx";
    return "docx"; // most .docx zips still are; mammoth will error clearly if not
  }
  // OLE2 compound file (legacy .doc / .xls): D0 CF 11 E0 A1 B1 1A E1.
  if (buf.length >= 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return "doc";
  return "unknown";
}

function kindFromName(name: string): Kind {
  if (/\.pdf$/i.test(name)) return "pdf";
  if (/\.docx$/i.test(name)) return "docx";
  if (/\.doc$/i.test(name)) return "doc";
  return "unknown";
}

// Best-effort text recovery from a legacy binary .doc (OLE2). Not a real Word
// parser â it pulls runs of printable characters out of the WordDocument stream
// so at least the readable copy survives. Good enough for a knowledge base.
function scrapeLegacyDoc(buf: Buffer): string {
  const raw = buf.toString("latin1");
  const runs = raw.match(/[\x20-\x7E\r\n\t]{6,}/g) ?? [];
  const text = runs
    .map((r) => r.replace(/[^\x20-\x7E\r\n\t]/g, " ").trim())
    // Drop OLE/XML plumbing and short noise lines.
    .filter((r) => r.length >= 6 && !/^(bjbj|HYPERLINK|Microsoft|Root Entry|WordDocument|CompObj|SummaryInformation|Times New Roman|Calibri|Normal\.dotm)$/i.test(r))
    .join("\n");
  return text;
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "No file received." }, { status: 400 });
  }
  const name = (form.get("name") as string) || "document";
  const mime = (file as Blob).type || "";
  const buf = Buffer.from(await file.arrayBuffer());

  if (buf.length === 0) {
    return NextResponse.json({ error: "That file is empty (0 bytes) â re-save or re-upload it." }, { status: 400 });
  }

  // Prefer the magic bytes; fall back to extension, then MIME.
  let kind = sniff(buf);
  if (kind === "unknown") kind = kindFromName(name);
  if (kind === "unknown") {
    if (/pdf/i.test(mime)) kind = "pdf";
    else if (/officedocument\.wordprocessing/i.test(mime)) kind = "docx";
    else if (/msword/i.test(mime)) kind = "doc";
  }

  try {
    let text = "";

    if (kind === "pdf") {
      try {
        const { PDFParse } = await import("pdf-parse");
        const parser = new PDFParse({ data: buf });
        const result = await parser.getText();
        text = result?.text ?? "";
        await parser.destroy();
      } catch (e) {
        return NextResponse.json(
          { error: `Couldn't read that PDF: ${e instanceof Error ? e.message : "parse error"}. If it's password-protected, remove the password and try again.` },
          { status: 422 }
        );
      }
    } else if (kind === "docx") {
      try {
        const mammoth = await import("mammoth");
        const result = await mammoth.extractRawText({ buffer: buf });
        text = result?.value ?? "";
      } catch (e) {
        return NextResponse.json(
          { error: `Couldn't read that Word file: ${e instanceof Error ? e.message : "parse error"}. Try re-saving it as .docx or PDF.` },
          { status: 422 }
        );
      }
    } else if (kind === "doc") {
      // Legacy binary .doc â best-effort scrape.
      text = scrapeLegacyDoc(buf);
      if (!cleanup(text)) {
        return NextResponse.json(
          { error: "This is an old Word .doc format that can't be read reliably â please open it in Word and 'Save As' .docx or PDF, then upload again." },
          { status: 415 }
        );
      }
    } else {
      return NextResponse.json(
        { error: `Unsupported file type${mime ? ` (${mime})` : ""}. Upload a PDF, Word .docx, or a plain-text file (.txt, .md, .csv).` },
        { status: 415 }
      );
    }

    text = cleanup(text);
    if (!text) {
      const scanned = kind === "pdf";
      return NextResponse.json(
        {
          error: scanned
            ? "This PDF has no selectable text â it looks like scanned images or photos. Re-export it as a text PDF, or paste the text into the knowledge base directly."
            : "Couldn't find any readable text in that document.",
        },
        { status: 422 }
      );
    }
    return NextResponse.json({ ok: true, text: text.slice(0, 200_000), kind });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to read the document." },
      { status: 500 }
    );
  }
}

// Normalize whitespace and strip stray control chars so what reaches the KB is clean.
function cleanup(text: string): string {
  return (text || "")
    .replace(/\r\n/g, "\n")
    // Strip control chars except tab and newline.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
