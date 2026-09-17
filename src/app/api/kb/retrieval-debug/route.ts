import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { retrieveKnowledge, splitSources } from "@/lib/kb-retrieval";

// Admin/diagnostic view of knowledge retrieval for one agent — makes "why did
// Sarah miss this fact?" answerable in seconds:
//
//   GET /api/kb/retrieval-debug?ws=<workspace>&agent=<name or id>&q=<question>
//
// Returns which sources exist, whether the query terms appear in the stored
// knowledge AT ALL (fact present vs. absent vs. retrieval failure), and exactly
// which chunks retrieval would hand the model, with scores. Returns source
// names, counts and short previews only — never patient data or secrets.
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const ws = req.nextUrl.searchParams.get("ws") ?? "";
  const agentKey = req.nextUrl.searchParams.get("agent") ?? "";
  const q = req.nextUrl.searchParams.get("q") ?? "";
  if (!ws || !agentKey || !q) {
    return NextResponse.json({ error: "Pass ?ws=<workspace id>&agent=<agent name or id>&q=<question>." }, { status: 400 });
  }

  let query = supabase.from("agents").select("id, name, knowledge_base, kb_files").eq("workspace_id", ws);
  query = /^[0-9a-f-]{36}$/i.test(agentKey) ? query.eq("id", agentKey) : query.ilike("name", agentKey);
  const { data: rows, error } = await query.limit(1);
  const agent = rows?.[0];
  if (error || !agent) return NextResponse.json({ error: error?.message ?? "Agent not found in this workspace." }, { status: 404 });

  const kb: string = agent.knowledge_base ?? "";
  const sources = splitSources(kb).map((s) => ({ name: s.name, chars: s.text.length }));

  // Term presence: is each interesting query word in the stored knowledge AT ALL?
  const terms = [...new Set((q.toLowerCase().match(/[a-zÀ-ɏ0-9]{3,}/gi) ?? []))];
  const lower = kb.toLowerCase();
  const termPresence = Object.fromEntries(terms.map((t) => [t, lower.includes(t)]));

  const r = retrieveKnowledge(kb, [q]);
  return NextResponse.json({
    agent: agent.name,
    query: q,
    kbChars: kb.length,
    kbFiles: agent.kb_files ?? [],
    sources,
    termPresence, // false for every term => the fact is NOT in the stored knowledge (data problem, not retrieval)
    retrieval: {
      mode: r.mode,
      contextChars: r.contextChars,
      chunks: r.chunks, // source, chunk id, score, chars, 120-char preview
    },
  });
}
