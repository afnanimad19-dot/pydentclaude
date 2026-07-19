// OCR fallback for knowledge-base documents whose text couldn't be extracted
// locally (scanned/image-only PDFs — photos of pages with no text layer). We hand
// the file to the Hyperfx engine's Python runtime, which renders each page and
// runs OCR (PyMuPDF + Tesseract) when there's no embedded text.
//
// This is strictly a FALLBACK: it only runs after the local pdf-parse/mammoth
// pass returns nothing, and if the engine isn't configured or can't OCR, callers
// keep their existing clear "no readable text" error. Nothing here can make a
// document that already extracted fine worse.

import { hfxCall } from "@/lib/hyperfx";

// Only attempt engine OCR for reasonably sized files — a multi-MB base64 payload
// inlined in a code string is fine for a few scanned pages, but we don't want to
// push huge scans through the RPC. ~8 MB of raw bytes.
const MAX_OCR_BYTES = 8 * 1024 * 1024;
const MARKER = "<<<PYDENT_OCR>>>";

// Build the Python program the engine runs. It base64-decodes the file, tries
// embedded text first (belt and suspenders), then OCRs any page that has none.
// It prints a marker followed by the recovered text so we can parse it out of
// whatever stdout wrapper the engine returns.
function ocrProgram(b64: string, kind: "pdf" | "image"): string {
  return [
    "import base64, io",
    `data = base64.b64decode(${JSON.stringify(b64)})`,
    "text = ''",
    "try:",
    kind === "pdf" ? "    import fitz" : "    pass",
    kind === "pdf" ? "    doc = fitz.open(stream=data, filetype='pdf')" : "",
    kind === "pdf" ? "    parts = []" : "",
    kind === "pdf" ? "    for page in doc:" : "",
    kind === "pdf" ? "        t = page.get_text()" : "",
    kind === "pdf" ? "        if not (t and t.strip()):" : "",
    kind === "pdf" ? "            try:" : "",
    kind === "pdf" ? "                import pytesseract" : "",
    kind === "pdf" ? "                from PIL import Image" : "",
    kind === "pdf" ? "                pix = page.get_pixmap(dpi=200)" : "",
    kind === "pdf" ? "                img = Image.open(io.BytesIO(pix.tobytes('png')))" : "",
    kind === "pdf" ? "                t = pytesseract.image_to_string(img)" : "",
    kind === "pdf" ? "            except Exception:" : "",
    kind === "pdf" ? "                t = ''" : "",
    kind === "pdf" ? "        parts.append(t or '')" : "",
    kind === "pdf" ? "    text = '\\n'.join(parts)" : "",
    kind === "image" ? "    import pytesseract" : "",
    kind === "image" ? "    from PIL import Image" : "",
    kind === "image" ? "    img = Image.open(io.BytesIO(data))" : "",
    kind === "image" ? "    text = pytesseract.image_to_string(img)" : "",
    "except Exception as e:",
    "    text = ''",
    `print(${JSON.stringify(MARKER)})`,
    "print(text)",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// Pull any string content out of the engine's tool result (shape varies).
function resultToText(r: { data?: unknown; content?: unknown[] }): string {
  const chunks: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string") chunks.push(v);
  };
  push(r.data);
  const d = r.data as Record<string, unknown> | undefined;
  if (d && typeof d === "object") {
    push(d.stdout);
    push(d.output);
    push(d.text);
    push(d.result);
  }
  for (const c of r.content ?? []) {
    const cc = c as Record<string, unknown>;
    if (cc && typeof cc === "object") push(cc.text);
  }
  return chunks.join("\n");
}

// Try OCR through the engine. Returns extracted text, or "" if it isn't
// available / found nothing (caller then keeps its own error).
export async function ocrViaEngine(buf: Buffer, kind: "pdf" | "image"): Promise<string> {
  if (buf.length === 0 || buf.length > MAX_OCR_BYTES) return "";
  const program = ocrProgram(buf.toString("base64"), kind);
  // The engine exposes a Python runtime as a native tool. hfxCall auto-enables /
  // retries and returns { ok:false } when the engine has no such tool — in which
  // case we simply give up and the caller's normal error stands.
  const r = await hfxCall("python", { code: program });
  if (!r.ok) return "";
  const out = resultToText(r);
  const idx = out.lastIndexOf(MARKER);
  const text = idx >= 0 ? out.slice(idx + MARKER.length) : "";
  return text.trim();
}
