// Knowledge document text extraction — shared by the legacy /api/kb/extract
// route and (later) Central Knowledge Base file ingestion. Moved verbatim from
// src/app/api/kb/extract/route.ts: same format detection, same parsers, same
// OCR fallbacks, same messages and statuses, same 200,000-character clip.
//
// No authentication and no workspace here — authorization stays in the routes.
// The parsers and OCR are injectable for tests; by default they are the real
// pdf-parse / mammoth / Hyperfx-engine OCR, loaded lazily exactly as before.
//
// Supports PDF (pdf-parse), Word .docx (mammoth), a best-effort scrape of
// legacy .doc, and OCR (via the Hyperfx engine) for scanned/image-only PDFs and
// page photos. Plain-text formats are read client-side and never reach this.
//
// Robustness: browsers/OSes sometimes send a document with the wrong (or no)
// file extension, or a generic MIME type — so we sniff the actual bytes (magic
// numbers) and fall back to the extension/MIME only when the bytes are
// inconclusive. Each parser is wrapped on its own so a failure names the format.

export type ExtractKind = "pdf" | "docx" | "doc" | "image" | "unknown";

/** Text kept per extracted document (unchanged from the legacy route). */
export const EXTRACT_MAX_CHARS = 200_000;

export type ExtractResult =
  | { ok: true; text: string; kind: ExtractKind; ocr?: true }
  | { ok: false; status: 400 | 415 | 422 | 500; error: string };

/**
 * Healthcare data protection (Phase 2C): OCR hands the WHOLE document to an
 * EXTERNAL service (the Hyperfx engine). Clinic documents can carry patient-
 * identifiable data, so that flow is OFF unless the operator consciously sets
 * KNOWLEDGE_EXTERNAL_OCR=on. Local parsers (pdf-parse, mammoth) are unaffected.
 */
export function externalOcrEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.KNOWLEDGE_EXTERNAL_OCR === "on";
}

export const OCR_DISABLED_PDF_ERROR =
  "This PDF has no selectable text, and OCR for scanned documents is disabled on this server (it would send the file to an external service; an administrator can enable it with KNOWLEDGE_EXTERNAL_OCR=on). Re-export it as a text PDF, or paste the text into the knowledge base directly.";
export const OCR_DISABLED_IMAGE_ERROR =
  "Reading photos and scans uses OCR, which is disabled on this server (it would send the image to an external service; an administrator can enable it with KNOWLEDGE_EXTERNAL_OCR=on). Re-export the content as a text PDF or .docx, or paste the text into the knowledge base directly.";

export interface ExtractDeps {
  /** Embedded text of a PDF; throws on a parse error. */
  parsePdf: (buf: Buffer) => Promise<string>;
  /** Raw text of a .docx; throws on a parse error. */
  parseDocx: (buf: Buffer) => Promise<string>;
  /** OCR through the engine; may throw or return "". */
  ocr: (buf: Buffer, kind: "pdf" | "image") => Promise<string>;
  /** Whether the external-OCR fallback may run at all (default: the env gate). */
  ocrEnabled?: () => boolean;
}

export const defaultExtractDeps: ExtractDeps = {
  parsePdf: async (buf) => {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buf });
    const result = await parser.getText();
    const text = result?.text ?? "";
    await parser.destroy();
    return text;
  },
  parseDocx: async (buf) => {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer: buf });
    return result?.value ?? "";
  },
  ocr: async (buf, kind) => {
    const { ocrViaEngine } = await import("@/lib/kb-ocr");
    return ocrViaEngine(buf, kind);
  },
  ocrEnabled: () => externalOcrEnabled(),
};

// Identify the format from the file's leading bytes -- the most reliable signal.
export function sniff(buf: Buffer): ExtractKind {
  if (buf.length >= 5 && buf.toString("latin1", 0, 5) === "%PDF-") return "pdf";
  // Image signatures (photos/scans of pages) -> OCR path.
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image"; // PNG
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image"; // JPEG
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image"; // WEBP
  if (buf.length >= 3 && ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a) || (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00))) return "image"; // TIFF
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

export function kindFromName(name: string): ExtractKind {
  if (/\.pdf$/i.test(name)) return "pdf";
  if (/\.docx$/i.test(name)) return "docx";
  if (/\.doc$/i.test(name)) return "doc";
  if (/\.(png|jpe?g|webp|tiff?|gif|bmp)$/i.test(name)) return "image";
  return "unknown";
}

// Best-effort text recovery from a legacy binary .doc (OLE2). Not a real Word
// parser -- it pulls runs of printable characters out of the WordDocument stream
// so at least the readable copy survives. Good enough for a knowledge base.
export function scrapeLegacyDoc(buf: Buffer): string {
  const raw = buf.toString("latin1");
  const runs = raw.match(/[\x20-\x7E\r\n\t]{6,}/g) ?? [];
  const text = runs
    .map((r) => r.replace(/[^\x20-\x7E\r\n\t]/g, " ").trim())
    // Drop OLE/XML plumbing and short noise lines.
    .filter((r) => r.length >= 6 && !/^(bjbj|HYPERLINK|Microsoft|Root Entry|WordDocument|CompObj|SummaryInformation|Times New Roman|Calibri|Normal\.dotm)$/i.test(r))
    .join("\n");
  return text;
}

// Normalize whitespace and strip stray control chars so what reaches the KB is clean.
export function cleanup(text: string): string {
  return (text || "")
    .replace(/\r\n/g, "\n")
    // Strip control chars except tab and newline.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Prefer the magic bytes; fall back to extension, then MIME. */
export function detectKind(buf: Buffer, name: string, mime: string): ExtractKind {
  let kind = sniff(buf);
  if (kind === "unknown") kind = kindFromName(name);
  if (kind === "unknown") {
    if (/pdf/i.test(mime)) kind = "pdf";
    else if (/officedocument\.wordprocessing/i.test(mime)) kind = "docx";
    else if (/msword/i.test(mime)) kind = "doc";
    else if (/^image\//i.test(mime)) kind = "image";
  }
  return kind;
}

/**
 * Extract the text of one uploaded document. `name` and `mime` are as the
 * client sent them (name defaults to "document", as the route always did).
 */
export async function extractDocument(
  input: { buf: Buffer; name: string; mime: string },
  deps: ExtractDeps = defaultExtractDeps
): Promise<ExtractResult> {
  const { buf, name, mime } = input;
  if (buf.length === 0) {
    return { ok: false, status: 400, error: "That file is empty (0 bytes) -- re-save or re-upload it." };
  }

  const kind = detectKind(buf, name, mime);
  // Injected test deps without the gate keep their historical behaviour (OCR
  // allowed); the REAL default deps carry the KNOWLEDGE_EXTERNAL_OCR env gate.
  const ocrAllowed = deps.ocrEnabled ? deps.ocrEnabled() : true;

  try {
    let text = "";

    if (kind === "pdf") {
      try {
        text = await deps.parsePdf(buf);
      } catch (e) {
        // A parse error (not just empty) -- try OCR (when permitted) before giving up.
        const ocr = ocrAllowed ? await deps.ocr(buf, "pdf").catch(() => "") : "";
        if (cleanup(ocr)) return { ok: true, text: cleanup(ocr).slice(0, EXTRACT_MAX_CHARS), kind, ocr: true };
        return {
          ok: false,
          status: 422,
          error: `Couldn't read that PDF: ${e instanceof Error ? e.message : "parse error"}. If it's password-protected, remove the password and try again.`,
        };
      }
      // Scanned PDF (no embedded text) -- OCR it through the engine, if permitted.
      if (!cleanup(text)) {
        if (!ocrAllowed) return { ok: false, status: 422, error: OCR_DISABLED_PDF_ERROR };
        const ocr = await deps.ocr(buf, "pdf").catch(() => "");
        if (cleanup(ocr)) text = ocr;
      }
    } else if (kind === "image") {
      // A photo/scan of a page -- OCR is the ONLY way to read it.
      if (!ocrAllowed) return { ok: false, status: 422, error: OCR_DISABLED_IMAGE_ERROR };
      text = await deps.ocr(buf, "image").catch(() => "");
      if (!cleanup(text)) {
        return {
          ok: false,
          status: 422,
          error: "Couldn't read text from that image. Make sure the text in the photo is sharp and upright, or type the details into the knowledge base directly.",
        };
      }
    } else if (kind === "docx") {
      try {
        text = await deps.parseDocx(buf);
      } catch (e) {
        return { ok: false, status: 422, error: `Couldn't read that Word file: ${e instanceof Error ? e.message : "parse error"}. Try re-saving it as .docx or PDF.` };
      }
    } else if (kind === "doc") {
      // Legacy binary .doc -- best-effort scrape.
      text = scrapeLegacyDoc(buf);
      if (!cleanup(text)) {
        return {
          ok: false,
          status: 415,
          error: "This is an old Word .doc format that can't be read reliably -- please open it in Word and 'Save As' .docx or PDF, then upload again.",
        };
      }
    } else {
      return {
        ok: false,
        status: 415,
        error: `Unsupported file type${mime ? ` (${mime})` : ""}. Upload a PDF, Word .docx, an image (PNG/JPG), or a plain-text file (.txt, .md, .csv).`,
      };
    }

    text = cleanup(text);
    if (!text) {
      const scanned = kind === "pdf";
      return {
        ok: false,
        status: 422,
        error: scanned
          ? "This PDF has no selectable text and OCR couldn't recover any -- it may be low-quality scanned images. Re-export it as a text PDF, or paste the text into the knowledge base directly."
          : "Couldn't find any readable text in that document.",
      };
    }
    return { ok: true, text: text.slice(0, EXTRACT_MAX_CHARS), kind };
  } catch (e) {
    return { ok: false, status: 500, error: e instanceof Error ? e.message : "Failed to read the document." };
  }
}

/** The legacy route's exact HTTP response for a result (body keys and order preserved). */
export function extractResponse(r: ExtractResult): { status: number; body: Record<string, unknown> } {
  if (!r.ok) return { status: r.status, body: { error: r.error } };
  return { status: 200, body: r.ocr ? { ok: true, text: r.text, kind: r.kind, ocr: true } : { ok: true, text: r.text, kind: r.kind } };
}
