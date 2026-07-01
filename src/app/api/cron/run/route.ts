import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { resumeDueRuns, triggerScheduledWorkflows } from "@/lib/workflow-runner";
import { runDueMessageBroadcasts } from "@/lib/message-broadcast-runner";

// Autopilot runner. Point a scheduler (Netlify Scheduled Function, Supabase cron,
// or cron-job.org) at /api/cron/run?key=CRON_SECRET every ~15 min. It runs the
// due scheduled_tasks by calling the relevant agent with the task instruction,
// then reschedules. Safe to call repeatedly.

export const runtime = "nodejs";
export const maxDuration = 300;

const TEAM_ROUTES = new Set(["helena", "sam", "kai", "angela"]);

function admin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://mzqynjywncbvqfikbzgm.supabase.co";
  return key ? createClient(url, key) : null;
}

function advance(cadence: string): string {
  const ms = cadence === "daily" ? 86400000 : cadence === "monthly" ? 30 * 86400000 : 7 * 86400000;
  return new Date(Date.now() + ms).toISOString();
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.nextUrl.searchParams.get("key") !== secret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const db = admin();
  if (!db) return NextResponse.json({ error: "Server not configured (SUPABASE_SERVICE_ROLE_KEY)." }, { status: 503 });

  // Resume any workflow runs whose wait timer has elapsed.
  let workflowsResumed = 0;
  try { workflowsResumed = await resumeDueRuns(db); } catch { /* keep going */ }
  // Fire scheduled (recurring) workflows whose cadence has elapsed (e.g. weekly reports).
  let scheduledFired = 0;
  try { scheduledFired = await triggerScheduledWorkflows(db); } catch { /* keep going */ }
  // Send any scheduled native Email/SMS broadcasts whose time has arrived.
  let messageBroadcasts = 0;
  try { messageBroadcasts = (await runDueMessageBroadcasts()).ran; } catch { /* keep going */ }

  const nowIso = new Date().toISOString();
  const { data: tasks } = await db.from("scheduled_tasks").select("*").eq("status", "active").lte("next_run", nowIso).order("next_run").limit(5);
  if (!tasks?.length) return NextResponse.json({ ran: 0, workflowsResumed, scheduledFired, messageBroadcasts });

  const origin = req.nextUrl.origin;
  let ran = 0;
  for (const t of tasks) {
    if (!TEAM_ROUTES.has(t.agent_key)) { await db.from("scheduled_tasks").update({ next_run: advance(t.cadence), last_run: nowIso, last_result: "skipped (unknown agent)" }).eq("id", t.id); continue; }
    // Gather the clinic's website + brand for context.
    const [{ data: cs }, { data: bk }] = await Promise.all([
      db.from("clinic_settings").select("website").eq("workspace_id", t.workspace_id).maybeSingle(),
      db.from("brand_knowledge").select("profile, colors").eq("workspace_id", t.workspace_id).maybeSingle(),
    ]);
    const brand = [bk?.profile, bk?.colors && `Brand colours: ${bk.colors}`].filter(Boolean).join("\n");
    let result = "";
    try {
      const res = await fetch(`${origin}/api/team/${t.agent_key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: t.workspace_id, website: cs?.website ?? "", brand, messages: [{ role: "user", content: `[AUTOPILOT TASK] ${t.instruction}` }] }),
      });
      const j = await res.json();
      result = (j.reply ?? j.error ?? "done").slice(0, 500);
    } catch (e) {
      result = `error: ${e instanceof Error ? e.message : "failed"}`;
    }
    await db.from("scheduled_tasks").update({ next_run: advance(t.cadence), last_run: nowIso, last_result: result }).eq("id", t.id);
    await db.from("agent_activity").insert({ workspace_id: t.workspace_id, agent_key: t.agent_key, action: "Autopilot ran", detail: t.title || t.instruction.slice(0, 80) });
    ran++;
  }
  return NextResponse.json({ ran, workflowsResumed, scheduledFired, messageBroadcasts });
}
