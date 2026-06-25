import { createClient } from "@supabase/supabase-js";

// Clinic memory for Remy — facts the team teaches the AI ("July whitening promo",
// "new hygienist Dr. X", "we don't do sedation") so the agents stay up to date.
// Server-only (service role).

function admin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://mzqynjywncbvqfikbzgm.supabase.co";
  if (!key) return null;
  return createClient(url, key);
}

export async function remember(ws: string, note: string, tag = ""): Promise<string> {
  const db = admin();
  if (!db) return "Memory storage not configured.";
  const clean = String(note || "").trim();
  if (!clean) return "Nothing to remember.";
  const { error } = await db.from("clinic_memory").insert({ workspace_id: ws, note: clean.slice(0, 1000), tag: tag.slice(0, 40) });
  if (error) return `Could not save: ${error.message}`;
  return `Got it — I'll remember: "${clean.slice(0, 120)}".`;
}

export async function recall(ws: string, query: string): Promise<string> {
  const db = admin();
  if (!db) return "Memory storage not configured.";
  const q = String(query || "").trim().toLowerCase();
  const { data } = await db.from("clinic_memory").select("note, tag, created_at").eq("workspace_id", ws).order("created_at", { ascending: false }).limit(200);
  let rows = data ?? [];
  if (q) {
    const terms = q.split(/\s+/).filter((t) => t.length > 2);
    rows = rows.filter((r) => terms.some((t) => String(r.note).toLowerCase().includes(t) || String(r.tag).toLowerCase().includes(t)));
  }
  if (!rows.length) return q ? `Nothing remembered about "${query}".` : "No memories saved yet.";
  return `Remembered facts:\n${rows.slice(0, 20).map((r) => `  • ${r.note}${r.tag ? ` [${r.tag}]` : ""}`).join("\n")}`;
}

export async function listMemories(ws: string): Promise<string> {
  return recall(ws, "");
}
