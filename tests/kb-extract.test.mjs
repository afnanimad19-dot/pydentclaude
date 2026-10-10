// A3 — /api/kb/extract refactor equivalence. The extraction moved verbatim to
// lib/kb-extract.ts; every expected message / status / body below is the one
// the Phase 0 route (9a1618f) produced. Parsers and OCR are injected fakes —
// no engine, network or database.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const X = await import("@/lib/kb-extract");
const root = path.resolve(import.meta.dirname, "..");
const src = (p) => fs.readFileSync(path.join(root, p), "utf8");

const PDF = Buffer.from("%PDF-1.4\n...");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const TIFF = Buffer.from([0x49, 0x49, 0x2a, 0x00, 1]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("[Content_Types].xml word/document.xml")]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const TEXT = Buffer.from("just some bytes");

function deps(over = {}) {
  const calls = { pdf: 0, docx: 0, ocr: [] };
  return {
    calls,
    d: {
      parsePdf: async () => { calls.pdf++; return over.pdf !== undefined ? (typeof over.pdf === "function" ? over.pdf() : over.pdf) : "PDF text"; },
      parseDocx: async () => { calls.docx++; return over.docx !== undefined ? (typeof over.docx === "function" ? over.docx() : over.docx) : "Word text"; },
      ocr: async (_b, kind) => { calls.ocr.push(kind); return over.ocr !== undefined ? (typeof over.ocr === "function" ? over.ocr() : over.ocr) : "OCR text"; },
    },
  };
}
const run = (buf, name = "document", mime = "", over) => {
  const { d, calls } = deps(over);
  return X.extractDocument({ buf, name, mime }, d).then((r) => ({ r, calls, res: X.extractResponse(r) }));
};
const boom = (msg) => () => { throw new Error(msg); };

test("format detection: magic bytes first, then the file name, then the MIME type", () => {
  assert.equal(X.sniff(PDF), "pdf");
  for (const b of [PNG, JPEG, WEBP, TIFF]) assert.equal(X.sniff(b), "image");
  assert.equal(X.sniff(DOCX), "docx");
  assert.equal(X.sniff(OLE), "doc");
  assert.equal(X.sniff(TEXT), "unknown");
  // Bytes win over a misleading name / MIME.
  assert.equal(X.detectKind(PDF, "photo.png", "image/png"), "pdf");
  assert.equal(X.detectKind(TEXT, "Report.PDF", ""), "pdf");
  assert.equal(X.detectKind(TEXT, "a.docx", ""), "docx");
  assert.equal(X.detectKind(TEXT, "a.doc", ""), "doc");
  for (const n of ["a.jpg", "a.jpeg", "a.tif", "a.tiff", "a.gif", "a.bmp", "a.webp"]) assert.equal(X.detectKind(TEXT, n, ""), "image", n);
  assert.equal(X.detectKind(TEXT, "x", "application/pdf"), "pdf");
  assert.equal(X.detectKind(TEXT, "x", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "docx");
  assert.equal(X.detectKind(TEXT, "x", "application/msword"), "doc");
  assert.equal(X.detectKind(TEXT, "x", "image/heic"), "image");
  assert.equal(X.detectKind(TEXT, "notes.txt", "text/plain"), "unknown");
});

test("empty file → 400 with the same message", async () => {
  const { res, calls } = await run(Buffer.alloc(0));
  assert.deepEqual(res, { status: 400, body: { error: "That file is empty (0 bytes) -- re-save or re-upload it." } });
  assert.equal(calls.pdf + calls.docx + calls.ocr.length, 0);
});

test("unsupported type → 415, with and without the MIME type in the message", async () => {
  assert.deepEqual((await run(TEXT, "notes.txt", "text/plain")).res, {
    status: 415,
    body: { error: "Unsupported file type (text/plain). Upload a PDF, Word .docx, an image (PNG/JPG), or a plain-text file (.txt, .md, .csv)." },
  });
  assert.equal((await run(TEXT, "x.bin", "")).res.body.error, "Unsupported file type. Upload a PDF, Word .docx, an image (PNG/JPG), or a plain-text file (.txt, .md, .csv).");
});

test("PDF with embedded text → 200 { ok, text, kind } (no OCR)", async () => {
  const { res, calls } = await run(PDF, "a.pdf", "application/pdf", { pdf: "  Hello\r\nWorld  " });
  assert.equal(JSON.stringify(res), JSON.stringify({ status: 200, body: { ok: true, text: "Hello\nWorld", kind: "pdf" } }));
  assert.deepEqual(calls.ocr, []);
});

test("PDF parse error → OCR fallback with ocr:true, else 422 naming the error", async () => {
  const ok = await run(PDF, "a.pdf", "", { pdf: boom("bad xref"), ocr: "Scanned text" });
  assert.equal(JSON.stringify(ok.res), JSON.stringify({ status: 200, body: { ok: true, text: "Scanned text", kind: "pdf", ocr: true } }));
  const fail = await run(PDF, "a.pdf", "", { pdf: boom("bad xref"), ocr: "" });
  assert.deepEqual(fail.res, { status: 422, body: { error: "Couldn't read that PDF: bad xref. If it's password-protected, remove the password and try again." } });
  const ocrThrows = await run(PDF, "a.pdf", "", { pdf: boom("bad xref"), ocr: boom("engine down") });
  assert.equal(ocrThrows.res.status, 422);
});

test("scanned PDF (no text) → OCR text WITHOUT the ocr flag; nothing → 422 scanned message", async () => {
  const ok = await run(PDF, "a.pdf", "", { pdf: "   ", ocr: "From OCR" });
  assert.equal(JSON.stringify(ok.res.body), JSON.stringify({ ok: true, text: "From OCR", kind: "pdf" }));
  const none = await run(PDF, "a.pdf", "", { pdf: "", ocr: "" });
  assert.deepEqual(none.res, {
    status: 422,
    body: { error: "This PDF has no selectable text and OCR couldn't recover any -- it may be low-quality scanned images. Re-export it as a text PDF, or paste the text into the knowledge base directly." },
  });
});

test("image → OCR; unreadable image → 422", async () => {
  const ok = await run(PNG, "scan.png", "image/png", { ocr: "Menu prices" });
  assert.deepEqual(ok.res.body, { ok: true, text: "Menu prices", kind: "image" });
  assert.deepEqual(ok.calls.ocr, ["image"]);
  for (const ocr of ["", boom("x")]) {
    assert.deepEqual((await run(JPEG, "a.jpg", "", { ocr })).res, {
      status: 422,
      body: { error: "Couldn't read text from that image. Make sure the text in the photo is sharp and upright, or type the details into the knowledge base directly." },
    });
  }
});

test("DOCX → text; parse error → 422 naming the error; empty → 422 generic", async () => {
  assert.deepEqual((await run(DOCX, "a.docx", "")).res.body, { ok: true, text: "Word text", kind: "docx" });
  assert.deepEqual((await run(DOCX, "a.docx", "", { docx: boom("not a zip") })).res, {
    status: 422,
    body: { error: "Couldn't read that Word file: not a zip. Try re-saving it as .docx or PDF." },
  });
  assert.deepEqual((await run(DOCX, "a.docx", "", { docx: "  " })).res, { status: 422, body: { error: "Couldn't find any readable text in that document." } });
});

test("legacy .doc → best-effort scrape; nothing readable → 415", async () => {
  const doc = Buffer.concat([OLE, Buffer.from("\x00\x01Clinic opening hours 9-5\x00\x02WordDocument\x00Prices list here\x00")]);
  const r = await run(doc, "old.doc", "");
  assert.equal(r.res.status, 200);
  assert.equal(r.res.body.kind, "doc");
  assert.match(r.res.body.text, /Clinic opening hours 9-5/);
  assert.doesNotMatch(r.res.body.text, /WordDocument/, "OLE plumbing dropped");
  assert.deepEqual((await run(OLE, "old.doc", "")).res, {
    status: 415,
    body: { error: "This is an old Word .doc format that can't be read reliably -- please open it in Word and 'Save As' .docx or PDF, then upload again." },
  });
});

test("cleanup and the 200,000-character clip are unchanged", async () => {
  assert.equal(X.cleanup("a\r\nb\u0001c   \n\n\n\nd\t \n"), "a\nb c\n\nd");
  assert.equal(X.EXTRACT_MAX_CHARS, 200_000);
  const big = await run(DOCX, "a.docx", "", { docx: "x".repeat(250_000) });
  assert.equal(big.res.body.text.length, 200_000);
  const bigOcr = await run(PDF, "a.pdf", "", { pdf: boom("e"), ocr: "y".repeat(250_000) });
  assert.equal(bigOcr.res.body.text.length, 200_000);
  assert.equal(bigOcr.res.body.ocr, true);
});

test("an unexpected internal error → 500 with its message (outer catch)", async () => {
  // A parser returning a non-string makes cleanup() throw inside the outer try.
  const r = await run(DOCX, "a.docx", "", { docx: {} });
  assert.equal(r.res.status, 500);
  assert.equal(typeof r.res.body.error, "string");
  assert.deepEqual(Object.keys(r.res.body), ["error"]);
});

test("route: still authenticated, same multipart handling, delegates to the library", () => {
  const route = src("src/app/api/kb/extract/route.ts");
  assert.match(route, /return withKbAuth\(\(\) => authorizeRequest\(req\), \(\) => extract\(req\)\);/);
  assert.match(route, /const form = await req\.formData\(\);/);
  assert.match(route, /if \(!\(file instanceof Blob\)\) \{\s*return NextResponse\.json\(\{ error: "No file received\." \}, \{ status: 400 \}\);/);
  assert.match(route, /const name = \(form\.get\("name"\) as string\) \|\| "document";/);
  assert.match(route, /const mime = \(file as Blob\)\.type \|\| "";/);
  assert.match(route, /extractResponse\(await extractDocument\(\{ buf, name, mime \}\)\)/);
  assert.match(route, /export const runtime = "nodejs";/);
  assert.match(route, /export const maxDuration = 60;/);
  // No parsing left in the route; no logging added.
  assert.doesNotMatch(route, /pdf-parse|mammoth|ocrViaEngine|function sniff|console\./);
});

test("library: no auth, no workspace, parsers loaded lazily (no top-level heavy imports)", () => {
  // Code only — comments may say what the library deliberately does NOT do.
  const lib = src("src/lib/kb-extract.ts").replace(/^\s*\/\/[^\n]*$/gm, "");
  assert.doesNotMatch(lib, /^import /m, "no top-level imports at all");
  assert.match(lib, /await import\("pdf-parse"\)/);
  assert.match(lib, /await import\("mammoth"\)/);
  assert.match(lib, /await import\("@\/lib\/kb-ocr"\)/);
  assert.doesNotMatch(lib, /authorize|workspace|supabase|console\./i);
  // Phase 2C: the ONE sanctioned env read is the external-OCR gate.
  assert.equal((lib.match(/process\.env/g) ?? []).length, 1, "only the KNOWLEDGE_EXTERNAL_OCR gate reads env");
  assert.match(lib, /env\.KNOWLEDGE_EXTERNAL_OCR === "on"/);
});

// ── Phase 2C: external OCR is OFF by default (healthcare data protection) ───

test("externalOcrEnabled: off unless KNOWLEDGE_EXTERNAL_OCR is exactly 'on'", () => {
  assert.equal(X.externalOcrEnabled({}), false);
  assert.equal(X.externalOcrEnabled({ KNOWLEDGE_EXTERNAL_OCR: "" }), false);
  assert.equal(X.externalOcrEnabled({ KNOWLEDGE_EXTERNAL_OCR: "true" }), false);
  assert.equal(X.externalOcrEnabled({ KNOWLEDGE_EXTERNAL_OCR: "ON" }), false);
  assert.equal(X.externalOcrEnabled({ KNOWLEDGE_EXTERNAL_OCR: "on" }), true);
  assert.match(src("src/lib/kb-extract.ts"), /ocrEnabled: \(\) => externalOcrEnabled\(\)/, "the real default deps carry the gate");
});

test("gate OFF: a scanned PDF fails closed with the disabled message and the OCR dep is NEVER called", async () => {
  const { d, calls } = deps({ pdf: "" });
  const r = await X.extractDocument({ buf: PDF, name: "scan.pdf", mime: "application/pdf" }, { ...d, ocrEnabled: () => false });
  assert.equal(r.ok, false);
  assert.equal(r.status, 422);
  assert.equal(r.error, X.OCR_DISABLED_PDF_ERROR);
  assert.deepEqual(calls.ocr, [], "document bytes never leave for the external service");
});

test("gate OFF: an image fails closed with the disabled message and the OCR dep is NEVER called", async () => {
  const { d, calls } = deps();
  const r = await X.extractDocument({ buf: PNG, name: "photo.png", mime: "image/png" }, { ...d, ocrEnabled: () => false });
  assert.equal(r.ok, false);
  assert.equal(r.status, 422);
  assert.equal(r.error, X.OCR_DISABLED_IMAGE_ERROR);
  assert.deepEqual(calls.ocr, []);
});

test("gate OFF: a PDF parse error keeps its password message without calling OCR; embedded text still works", async () => {
  const { d, calls } = deps({ pdf: () => { throw new Error("bad xref"); } });
  const r = await X.extractDocument({ buf: PDF, name: "x.pdf", mime: "" }, { ...d, ocrEnabled: () => false });
  assert.equal(r.ok, false);
  assert.match(r.error, /Couldn't read that PDF: bad xref/);
  assert.deepEqual(calls.ocr, []);
  const ok = await X.extractDocument({ buf: PDF, name: "x.pdf", mime: "" }, { ...deps().d, ocrEnabled: () => false });
  assert.equal(ok.ok, true, "local parsing is unaffected by the gate");
  assert.equal(ok.text, "PDF text");
});

test("gate ON (or injected deps without a gate): OCR behaves exactly as before", async () => {
  const on = await X.extractDocument({ buf: PNG, name: "p.png", mime: "" }, { ...deps().d, ocrEnabled: () => true });
  assert.equal(on.ok, true);
  assert.equal(on.text, "OCR text");
  const legacy = await X.extractDocument({ buf: PNG, name: "p.png", mime: "" }, deps().d);
  assert.equal(legacy.ok, true, "test deps without ocrEnabled keep historical behaviour");
});
