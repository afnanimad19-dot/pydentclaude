// Knowledge-base retrieval for chat agents.
//
// The knowledge base is stored as ONE text blob per agent, with each uploaded
// document / imported web page introduced by a "--- <source name> ---" marker
// (the convention the Edit Agent screen has always written). Until now the
// gateway sent `knowledgeBase.slice(0, 48000)` — anything past 48k chars
// simply vanished, and relevant facts in the middle got lost in noise.
//
// This module makes the knowledge section RETRIEVAL-FIRST without changing how
// knowledge is stored and without any external service:
//   1. the blob is split into sources (marker boundaries) and then into
//      paragraph-aligned chunks with overlap, so a doctor profile stays whole;
//   2. chunks are scored against the current question plus recent conversation
//      (rare terms count more, exact name/phrase hits count a lot, and common
//      clinic abbreviations like RCT are expanded);
//   3. the prompt gets the top chunks FIRST — guaranteed present even if they
//      lived past the old 48k cliff — followed by as much of the full knowledge
//      base as still fits, so nothing that used to be included is ever lost.
//
// Everything here is pure and dependency-free: it runs identically for Test
// Chat, the inbox AI reply, and the WhatsApp/SMS auto-responders, and it is
// unit-tested offline in tests/kb-retrieval.test.mjs.

export interface KbChunk {
  source: string; // document name or "Website page: <url>"
  id: number;     // chunk index within the source
  text: string;
}

export interface ScoredChunk extends KbChunk {
  score: number;
}

export interface RetrievalResult {
  /** The knowledge text to put in the system prompt. */
  text: string;
  /** "full" = whole KB fit in budget; "retrieved" = top chunks + truncated rest. */
  mode: "full" | "retrieved" | "empty";
  /** Top chunks chosen (empty in full mode), for logs / the debug endpoint. */
  chunks: { source: string; id: number; score: number; chars: number; preview: string }[];
  totalKbChars: number;
  contextChars: number;
}

// Common clinic abbreviations expanded into the query so "What is RCT?" finds
// "root canal treatment". Generic dental vocabulary only — clinic-specific
// aliases (like a doctor's nickname) live in the clinic's own knowledge text.
const QUERY_ALIASES: Record<string, string> = {
  rct: "root canal treatment",
  gp: "general practice dentist",
  tmj: "temporomandibular joint",
  ortho: "orthodontics",
  osa: "obstructive sleep apnea",
  rx: "prescription",
};

const STOPWORDS = new Set(
  "a an and are as at be but by for from has have he her hers him his how i in is it its me my of on or our she so that the their them they this to us was we what when where which who whose why will with you your".split(" ")
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-zÀ-ɏ0-9]{2,}/gi) ?? []).filter((t) => !STOPWORDS.has(t));
}

/** Split the stored blob into named sources on the "--- name ---" markers. */
export function splitSources(kb: string): { name: string; text: string }[] {
  const parts: { name: string; text: string }[] = [];
  const re = /^---\s*(.+?)\s*---\s*$/gm;
  let last: { name: string; start: number } | null = null;
  let firstMarker = -1;
  for (let m = re.exec(kb); m; m = re.exec(kb)) {
    if (firstMarker === -1) firstMarker = m.index;
    if (last) parts.push({ name: last.name, text: kb.slice(last.start, m.index).trim() });
    last = { name: m[1], start: m.index + m[0].length };
  }
  if (last) parts.push({ name: last.name, text: kb.slice(last.start).trim() });
  // Text before the first marker (or a KB with no markers at all).
  const head = (firstMarker === -1 ? kb : kb.slice(0, firstMarker)).trim();
  if (head) parts.unshift({ name: "Knowledge base", text: head });
  return parts.filter((p) => p.text);
}

/** Paragraph-aligned chunks (~target chars) with one-paragraph overlap. */
export function chunkSource(name: string, text: string, target = 1500): KbChunk[] {
  const paras = text.split(/\n{2,}|\r\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: KbChunk[] = [];
  let buf: string[] = [];
  let len = 0;
  const flush = () => {
    if (!buf.length) return;
    chunks.push({ source: name, id: chunks.length, text: buf.join("\n\n") });
    // Overlap: carry the last paragraph into the next chunk so a fact split
    // across a boundary (e.g. a profile heading + its body) is never orphaned.
    const carry = buf[buf.length - 1];
    buf = carry.length < target / 2 ? [carry] : [];
    len = buf.reduce((n, p) => n + p.length, 0);
  };
  for (const p of paras) {
    if (len + p.length > target && len > 0) flush();
    buf.push(p);
    len += p.length;
    // A single huge paragraph becomes its own chunk rather than blocking.
    if (len >= target * 2) { chunks.push({ source: name, id: chunks.length, text: buf.join("\n\n") }); buf = []; len = 0; }
  }
  if (buf.length) chunks.push({ source: name, id: chunks.length, text: buf.join("\n\n") });
  return chunks;
}

export function chunkKnowledge(kb: string): KbChunk[] {
  return splitSources(kb).flatMap((s) => chunkSource(s.name, s.text));
}

function expandQuery(q: string): string {
  const extra = tokenize(q).map((t) => QUERY_ALIASES[t]).filter(Boolean).join(" ");
  return extra ? `${q} ${extra}` : q;
}

/**
 * Score chunks against the conversation. `queries[0]` is the current question
 * (full weight); the rest are recent conversation turns (reduced weight) so a
 * follow-up like "what is her experience?" still carries the doctor's name
 * mentioned two messages earlier.
 */
export function rankChunks(chunks: KbChunk[], queries: string[]): ScoredChunk[] {
  if (!chunks.length) return [];
  // Document frequency per token — rare tokens (names, "endodontics") are the
  // ones that identify the right chunk; "appointment" appears everywhere.
  const df = new Map<string, number>();
  const chunkTokens = chunks.map((c) => {
    const set = new Set(tokenize(c.text));
    for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
    return set;
  });
  const n = chunks.length;
  const idf = (t: string) => Math.log(1 + n / (1 + (df.get(t) ?? 0)));

  const scored = chunks.map((c, ci) => {
    let score = 0;
    const lower = c.text.toLowerCase();
    queries.forEach((raw, qi) => {
      const weight = qi === 0 ? 1 : 0.35; // current question dominates
      const q = expandQuery(raw);
      const toks = [...new Set(tokenize(q))];
      for (const t of toks) {
        if (chunkTokens[ci].has(t)) score += idf(t) * weight;
        // Prefix credit: "studied" ~ "studies", "qualification" ~ "qualifications".
        else if (t.length >= 5 && [...chunkTokens[ci]].some((ct) => ct.startsWith(t.slice(0, 5)))) score += 0.4 * idf(t) * weight;
      }
      // Exact phrase / name bonus: consecutive query-token pairs found verbatim
      // ("anmol batria", "root canal", "sleep apnea") strongly outrank chunks
      // that merely share single words.
      for (let i = 0; i + 1 < toks.length; i++) {
        const bigram = `${toks[i]} ${toks[i + 1]}`;
        if (lower.includes(bigram)) score += 3 * weight;
      }
    });
    return { ...c, score: Math.round(score * 100) / 100 };
  });
  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Build the knowledge text for one request.
 *
 * Guarantee: strictly-no-worse than the old `.slice(0, 48000)` — everything the
 * old cap included is still included (same overall budget), but the chunks that
 * actually answer the question are selected from ANYWHERE in the knowledge base
 * and placed first.
 */
export function retrieveKnowledge(
  kb: string,
  queries: string[],
  opts?: { budget?: number; relevantBudget?: number; topK?: number }
): RetrievalResult {
  const budget = opts?.budget ?? 48000;
  const relevantBudget = Math.min(opts?.relevantBudget ?? 12000, budget);
  const topK = opts?.topK ?? 8;
  const totalKbChars = kb.length;
  if (!kb.trim()) return { text: "", mode: "empty", chunks: [], totalKbChars, contextChars: 0 };
  // Small knowledge bases fit whole — retrieval can only ever REMOVE
  // information, so it only kicks in when the budget forces a choice.
  if (totalKbChars <= budget) return { text: kb, mode: "full", chunks: [], totalKbChars, contextChars: totalKbChars };

  const ranked = rankChunks(chunkKnowledge(kb), queries.filter((q) => q && q.trim()));
  const picked: ScoredChunk[] = [];
  let used = 0;
  for (const c of ranked) {
    if (picked.length >= topK) break;
    if (c.score <= 0) break;
    if (used + c.text.length > relevantBudget) continue;
    picked.push(c);
    used += c.text.length;
  }

  const relevantText = picked
    .map((c) => `--- Most relevant · ${c.source} (part ${c.id + 1}) ---\n${c.text}`)
    .join("\n\n");
  const restBudget = budget - relevantText.length;
  const rest = restBudget > 0 ? kb.slice(0, restBudget) : "";
  const text = [
    relevantText && `MOST RELEVANT TO THE CURRENT QUESTION:\n\n${relevantText}`,
    rest && `FULL KNOWLEDGE BASE (may be truncated — the most relevant parts are already shown above):\n\n${rest}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    text,
    mode: "retrieved",
    chunks: picked.map((c) => ({ source: c.source, id: c.id, score: c.score, chars: c.text.length, preview: c.text.slice(0, 120) })),
    totalKbChars,
    contextChars: text.length,
  };
}

/** The retrieval queries for a request: latest user message first, then recent turns. */
export function queriesFromMessages(messages: { role: string; content: string }[]): string[] {
  const recent = messages.slice(-6);
  const lastUser = [...recent].reverse().find((m) => m.role === "user")?.content ?? "";
  const context = recent.filter((m) => m.content !== lastUser).map((m) => m.content).join(" ").slice(0, 1500);
  return [lastUser, context].filter(Boolean);
}
