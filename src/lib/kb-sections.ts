// Section-level edits of the legacy per-agent knowledge blob
// (agents.knowledge_base). Each uploaded document / website import is stored as
//
//   --- <name> ---
//   <extracted text>
//
// using the SAME marker grammar lib/kb-retrieval.ts (splitSources) reads, so
// what we remove or replace here is exactly what the runtime treats as that
// source. Pure functions; never build a RegExp from a filename.
//
// Boundaries: a section runs from its marker to the next TOP-LEVEL marker.
// "--- Website page: <url> ---" markers are the per-page sub-markers a website
// import nests inside its "--- Website — <title> ---" section, so they belong
// to the section that precedes them. Any other marker starts a new section, so
// knowledge we don't own (e.g. the seeded "--- Website import (…) ---", or a
// section left over from older data) is never swallowed.
//
// AI Learning (teachAgent) appends "Q: …\nA: …" paragraphs to the END of the
// blob without a marker. When the section being removed or replaced is the
// last one, those trailing taught answers are preserved.

const MARKER = /^---\s*(.+?)\s*---\s*$/gm; // identical to splitSources()
const NESTED = /^Website page:/;
const TAUGHT = /^Q: [^\n]*\nA: /;

interface Marker {
  name: string;
  start: number; // index of the marker line
}

function markers(kb: string): Marker[] {
  const out: Marker[] = [];
  const re = new RegExp(MARKER.source, MARKER.flags);
  for (let m = re.exec(kb); m; m = re.exec(kb)) out.push({ name: m[1], start: m.index });
  return out;
}

function validName(name: string): string | null {
  const n = String(name ?? "").trim();
  if (!n || /[\r\n]/.test(n)) return null;
  return n;
}

/** [start, end) spans of every top-level section called `name`. */
function sectionSpans(kb: string, name: string): { start: number; end: number }[] {
  const ms = markers(kb);
  const spans: { start: number; end: number }[] = [];
  for (let i = 0; i < ms.length; i++) {
    if (ms[i].name !== name) continue;
    let end = kb.length;
    for (let j = i + 1; j < ms.length; j++) {
      if (!NESTED.test(ms[j].name)) {
        end = ms[j].start;
        break;
      }
    }
    // Skip a duplicate marker that sits inside a span we already took.
    if (spans.length && ms[i].start < spans[spans.length - 1].end) continue;
    spans.push({ start: ms[i].start, end });
  }
  return spans;
}

/** Trailing taught Q&A paragraphs of a span that reaches the end of the blob. */
function taughtTail(spanText: string): string {
  const paras = spanText.split(/\n{2,}/);
  const kept: string[] = [];
  for (let i = paras.length - 1; i > 0; i--) {
    const p = paras[i].trim();
    if (!p) continue;
    if (!TAUGHT.test(p)) break;
    kept.unshift(p);
  }
  return kept.join("\n\n");
}

function join(parts: string[]): string {
  return parts.map((p) => p.trim()).filter(Boolean).join("\n\n");
}

export function hasKbSection(kb: string, name: string): boolean {
  const n = validName(name);
  return !!n && sectionSpans(String(kb ?? ""), n).length > 0;
}

/**
 * Remove every top-level section called `name` (legacy data can hold the same
 * name twice). Everything else — the text before the first marker, other
 * sections, taught Q&A at the end — is kept, in order. Unknown name → unchanged.
 */
export function removeKbSection(kb: string, name: string): string {
  const text = String(kb ?? "");
  const n = validName(name);
  if (!n) return text;
  const spans = sectionSpans(text, n);
  if (!spans.length) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const s of spans) {
    parts.push(text.slice(cursor, s.start));
    if (s.end === text.length) parts.push(taughtTail(text.slice(s.start, s.end)));
    cursor = s.end;
  }
  parts.push(text.slice(cursor));
  return join(parts);
}

/**
 * Insert or replace the section called `name` with `content`. An existing
 * section is replaced IN PLACE (first occurrence; any duplicates are removed),
 * so the result always holds exactly one section for that name. New names are
 * appended at the end.
 */
export function upsertKbSection(kb: string, name: string, content: string): string {
  const text = String(kb ?? "");
  const n = validName(name);
  if (!n) return text;
  const section = `--- ${n} ---\n${String(content ?? "").trim()}`;
  const spans = sectionSpans(text, n);
  if (!spans.length) return join([text, section]);
  const parts: string[] = [];
  let cursor = 0;
  spans.forEach((s, i) => {
    parts.push(text.slice(cursor, s.start));
    if (i === 0) parts.push(section);
    if (s.end === text.length) parts.push(taughtTail(text.slice(s.start, s.end)));
    cursor = s.end;
  });
  parts.push(text.slice(cursor));
  return join(parts);
}

/** A failed extraction placeholder (never replaces good knowledge). */
export function isFailedExtraction(text: string): boolean {
  const t = String(text ?? "").trim();
  return !t || /^\[Could not read /.test(t);
}

/**
 * The knowledge blob to save: the stored blob with every document read in this
 * editing session upserted (replace-in-place, never appended twice), limited to
 * names still listed in kb_files. Failed extractions of a name that already has
 * knowledge leave the existing section untouched.
 */
export function composeKnowledge(kb: string, sessionTexts: Record<string, string>, kbFiles: string[]): string {
  let out = String(kb ?? "");
  for (const name of kbFiles) {
    if (!(name in sessionTexts)) continue;
    const t = sessionTexts[name];
    if (isFailedExtraction(t) && hasKbSection(out, name)) continue;
    out = upsertKbSection(out, name, t);
  }
  return out;
}
