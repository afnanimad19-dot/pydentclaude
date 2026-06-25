import { createClient } from "@supabase/supabase-js";

// Records what an agent did (published a blog, posted, made a report, etc.) for
// the per-agent Activity feed. Server-only; never throws into the tool flow.

export async function logActivity(ws: string, agentKey: string, action: string, detail = "", link = ""): Promise<void> {
  try {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://mzqynjywncbvqfikbzgm.supabase.co";
    if (!key) return;
    const admin = createClient(url, key);
    await admin.from("agent_activity").insert({ workspace_id: ws, agent_key: agentKey, action: action.slice(0, 120), detail: detail.slice(0, 300), link: link.slice(0, 500) });
  } catch {
    /* activity logging is best-effort */
  }
}
