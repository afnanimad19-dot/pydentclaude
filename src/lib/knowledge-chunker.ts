// Phase 2B — deterministic chunking of ONE Central Knowledge document into the
// chunk rows that knowledge_reindex_document (migration 0068) persists.
//
// PURE by contract: no Supabase, no network, no environment, no filesystem, no
// timestamps, no randomness. The same input ALWAYS produces the same ordered
// output — the 0068 function replaces a document's chunk set wholesale, so
// determinism is what makes re-indexing idempotent and retries safe.
//
// Chunks do NOT overlap: every piece of normalized source text belongs to
// exactly ONE chunk. (The legacy kb-retrieval chunker carries a short trailing
// paragraph into the next chunk, which is fine for its transient in-memory
// ranking but would persist duplicate FTS hits, distort candidate counts and
// ranking, and complicate future embeddings. If retrieval evaluation later
// proves overlap helps, it is introduced deliberately in a later phase.)
//
// Boundaries, in priority order: "--- section ---" markers (the Central
// Knowledge blob convention, same regex as kb-retrieval's splitSources —
// reimplemented here so the legacy module stays untouched) → blank-line
// paragraphs → sentences → deterministic hard split. Normal prose is never cut
// at an arbitrary character offset.

/** One chunk in the exact JSON shape knowledge_reindex_document reads. */
export interface KnowledgeChunk {
  /** 0..n-1 in document order — the 0068 function validates the ordinals. */
  chunk_index: number;
  /** 1..4000 chars (knowledge_chunks CHECK constraint). */
  content: string;
  /** 1..200 chars (knowledge_chunks CHECK constraint). */
  source_label: string;
  /** The "--- marker ---" section label, or null before the first marker. */
  heading: string | null;
}

/** Preferred chunk size — packing flushes before exceeding this. */
export const CHUNK_TARGET_CHARS = 1500;
/** Hard ceiling — the knowledge_chunks CHECK constraint. Never exceeded. */
export const CHUNK_MAX_CHARS = 4000;
/** A trailing chunk smaller than this merges into the previous one (when it fits). */
export const CHUNK_TAIL_MIN_CHARS = 200;
/** source_label ceiling — the knowledge_chunks CHECK constraint. */
export const SOURCE_LABEL_MAX_CHARS = 200;

/**
 * Cut index at or just before `end` that never splits a surrogate pair — a
 * lone surrogate is not valid JSON/UTF-8 and would be refused by the database.
 */
function cutPoint(s: string, end: number): number {
  if (end > 0 && end < s.length) {
    const before = s.charCodeAt(end - 1);
    const at = s.charCodeAt(end);
    if (before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff) return end - 1;
  }
  return end;
}

/**
 * The chunk's source_label: the Central Knowledge "Resource name / file-or-url"
 * convention (knowledge-runtime's centralSourceLabel), additionally capped at
 * the database's 200-character limit. Pure and deterministic.
 */
export function chunkSourceLabel(resourceName: string, doc: { filename: string | null; sourceUrl: string | null }): string {
  const docLabel = String(doc.filename ?? doc.sourceUrl ?? "Document").trim() || "Document";
  const label = `${String(resourceName ?? "").trim() || "Knowledge resource"} / ${docLabel}`.replace(/\s+/g, " ");
  return label.slice(0, cutPoint(label, SOURCE_LABEL_MAX_CHARS));
}

interface Section {
  heading: string | null;
  text: string;
}

/**
 * Split on the "--- name ---" markers (splitSources' convention and regex).
 * Text before the first marker — or a document with no markers — is a section
 * with heading null.
 */
function splitIntoSections(text: string): Section[] {
  const sections: Section[] = [];
  const re = /^---\s*(.+?)\s*---\s*$/gm;
  let last: { heading: string | null; start: number } | null = null;
  let firstMarker = -1;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (firstMarker === -1) firstMarker = m.index;
    if (last) sections.push({ heading: last.heading, text: text.slice(last.start, m.index) });
    const heading = m[1].replace(/\s+/g, " ").trim();
    last = { heading: heading || null, start: m.index + m[0].length };
  }
  if (last) sections.push({ heading: last.heading, text: text.slice(last.start) });
  const head = firstMarker === -1 ? text : text.slice(0, firstMarker);
  if (head.trim()) sections.unshift({ heading: null, text: head });
  return sections.filter((s) => s.text.trim());
}

/**
 * A paragraph longer than the hard max: split on sentence boundaries and pack
 * the sentences toward the target; a single sentence (or unbroken run) longer
 * than the hard max is hard-split deterministically, never through a surrogate
 * pair. Every returned piece is 1..CHUNK_MAX_CHARS.
 */
function splitOversizedParagraph(paragraph: string): string[] {
  const sentences = paragraph.match(/[^.!?]*[.!?]+[)"'\]»]*(?:\s+|$)|[^.!?]+$/g) ?? [paragraph];
  const units: string[] = [];
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length <= CHUNK_MAX_CHARS) {
      units.push(s);
      continue;
    }
    let i = 0;
    while (i < s.length) {
      const end = cutPoint(s, Math.min(i + CHUNK_MAX_CHARS, s.length));
      units.push(s.slice(i, end));
      i = end;
    }
  }
  const pieces: string[] = [];
  let buf: string[] = [];
  let len = 0;
  const flush = () => {
    if (!buf.length) return;
    pieces.push(buf.join(" "));
    buf = [];
    len = 0;
  };
  for (const u of units) {
    if (len > 0 && len + 1 + u.length > CHUNK_TARGET_CHARS) flush();
    len = len === 0 ? u.length : len + 1 + u.length;
    buf.push(u);
  }
  flush();
  return pieces;
}

/**
 * Chunk one section's text: blank-line paragraphs packed toward the target
 * (joined back with "\n\n"), oversized paragraphs pre-split on sentences, and
 * a small trailing chunk merged into the previous one when the merge stays
 * within the hard max. No unit is ever emitted twice (no overlap).
 */
function chunkSectionText(text: string): string[] {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const units: string[] = [];
  for (const p of paras) {
    if (p.length <= CHUNK_MAX_CHARS) units.push(p);
    else units.push(...splitOversizedParagraph(p));
  }
  const chunks: string[] = [];
  let buf: string[] = [];
  let len = 0;
  const flush = () => {
    if (!buf.length) return;
    chunks.push(buf.join("\n\n"));
    buf = [];
    len = 0;
  };
  // Every unit is ≤ CHUNK_MAX_CHARS and the packer flushes BEFORE a joint
  // length would pass the target, so no emitted chunk can exceed the hard max.
  for (const u of units) {
    if (len > 0 && len + 2 + u.length > CHUNK_TARGET_CHARS) flush();
    len = len === 0 ? u.length : len + 2 + u.length;
    buf.push(u);
  }
  flush();
  if (chunks.length >= 2) {
    const tail = chunks[chunks.length - 1];
    const prev = chunks[chunks.length - 2];
    if (tail.length < CHUNK_TAIL_MIN_CHARS && prev.length + 2 + tail.length <= CHUNK_MAX_CHARS) {
      chunks.splice(chunks.length - 2, 2, `${prev}\n\n${tail}`);
    }
  }
  return chunks;
}

/**
 * Chunk one document's stored content into the complete ordered chunk set for
 * knowledge_reindex_document. Whitespace-only content chunks to [] (a valid
 * empty replacement). Line endings are normalized (\r\n and \r → \n) so the
 * same text arriving with different endings indexes identically.
 */
export function chunkDocumentContent(input: { content: string; sourceLabel: string }): KnowledgeChunk[] {
  const normalizedLabel = String(input.sourceLabel ?? "").replace(/\s+/g, " ").trim();
  const sourceLabel = normalizedLabel.slice(0, cutPoint(normalizedLabel, SOURCE_LABEL_MAX_CHARS)) || "Knowledge document";
  const text = String(input.content ?? "").replace(/\r\n?/g, "\n");
  if (!text.trim()) return [];
  const chunks: KnowledgeChunk[] = [];
  for (const section of splitIntoSections(text)) {
    for (const content of chunkSectionText(section.text)) {
      chunks.push({ chunk_index: chunks.length, content, source_label: sourceLabel, heading: section.heading });
    }
  }
  return chunks;
}
