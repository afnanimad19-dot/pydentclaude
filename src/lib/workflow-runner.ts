// Workflow runner — executes a saved workflow's nodes against a contact. Runs
// are persisted in `workflow_runs` so multi-step flows with waits survive across
// cron ticks. Used by the WhatsApp webhook (trigger on new conversation), the
// manual "Run" API, and the cron (to resume waiting runs).
//
// Node model (from the builder): { type, title, detail, config }.
//  - trigger   — start node; config.event = conversation_opened | new_lead | appointment_booked | manual
//  - message   — send `detail` (with {{merge}} fields) to the contact on the channel
//  - wait       — pause; config = { amount, unit }
//  - condition — config.contains: continue only if the last inbound message contains it
//  - handoff   — assign the conversation to a human (stops AI auto-reply)
//  - action     — config.action: tag (set patient status) | add_to_pipeline | none
//  - agent      — leave it to the channel's AI agent (no-op here)

import { sendByChannel } from "@/lib/wa-send";

/* eslint-disable @typescript-eslint/no-explicit-any */
type DB = any; // a Supabase client (anon shared or service-role admin)

export interface RunContext {
  patientId?: string | null;
  conversationId?: string | null;
  channel: string;
  contactPhone: string;
  name?: string;
  lastMessage?: string;
}

function renderTemplate(text: string, vars: Record<string, any>): string {
  return String(text || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
}

function waitMs(cfg: any): number {
  const amount = Math.max(0, Number(cfg?.amount ?? 1));
  const unit = cfg?.unit ?? "minutes";
  const per = unit === "days" ? 86400000 : unit === "hours" ? 3600000 : 60000; // default minutes
  return amount * per;
}

function triggerEvent(workflow: any): string {
  const trigger = (workflow.nodes ?? []).find((n: any) => n.type === "trigger");
  return trigger?.config?.event ?? "conversation_opened";
}

// Find Live workflows for this workspace+channel whose trigger matches the event.
export async function triggerWorkflows(db: DB, ws: string | null, event: string, channel: string, ctx: RunContext): Promise<number> {
  if (!ws) return 0;
  try {
    const { data: workflows } = await db.from("workflows").select("*").eq("workspace_id", ws).eq("status", "Live");
    let started = 0;
    for (const wf of workflows ?? []) {
      if (triggerEvent(wf) !== event) continue;
      // Only the "conversation opened" trigger is channel-specific; other events
      // (appointment booked, new lead) fire regardless of the workflow's channel.
      if (event === "conversation_opened" && wf.channel && channel && wf.channel !== channel) continue;
      // Don't double-fire the same workflow for the same conversation.
      if (ctx.conversationId) {
        const { data: existing } = await db.from("workflow_runs").select("id").eq("workflow_id", wf.id).eq("conversation_id", ctx.conversationId).limit(1).maybeSingle();
        if (existing) continue;
      }
      await startRun(db, ws, wf, ctx);
      started++;
    }
    return started;
  } catch {
    return 0;
  }
}

export async function startRun(db: DB, ws: string | null, workflow: any, ctx: RunContext): Promise<void> {
  const vars = {
    first_name: (ctx.name || "").split(" ")[0] || "there",
    name: ctx.name || "",
    phone: ctx.contactPhone || "",
    last_message: ctx.lastMessage || "",
  };
  const { data: run } = await db
    .from("workflow_runs")
    .insert({
      workspace_id: ws,
      workflow_id: workflow.id,
      patient_id: ctx.patientId ?? null,
      conversation_id: ctx.conversationId ?? null,
      channel: ctx.channel,
      contact_phone: ctx.contactPhone,
      status: "running",
      node_index: 0,
      vars,
    })
    .select("*")
    .single();
  if (run) await advanceRun(db, run, workflow);
}

// Execute nodes from run.node_index until a wait (persist + stop) or the end.
export async function advanceRun(db: DB, run: any, workflow: any): Promise<void> {
  const nodes: any[] = workflow.nodes ?? [];
  const vars: Record<string, any> = run.vars ?? {};
  const log: any[] = Array.isArray(run.log) ? run.log : [];
  let i = run.node_index ?? 0;

  for (; i < nodes.length; i++) {
    const node = nodes[i];
    try {
      if (node.type === "trigger") continue;

      if (node.type === "message") {
        const text = renderTemplate(node.detail, vars);
        if (run.contact_phone && text.trim()) {
          const sent = await sendByChannel(run.channel, run.contact_phone, text);
          log.push({ node: node.id, type: "message", ok: sent.ok, error: sent.error ?? null });
        } else {
          log.push({ node: node.id, type: "message", skipped: "no contact or empty text" });
        }
        continue;
      }

      if (node.type === "wait") {
        const resumeAt = new Date(Date.now() + waitMs(node.config)).toISOString();
        log.push({ node: node.id, type: "wait", resumeAt });
        await db.from("workflow_runs").update({ status: "waiting", node_index: i + 1, resume_at: resumeAt, vars, log, updated_at: new Date().toISOString() }).eq("id", run.id);
        return;
      }

      if (node.type === "condition") {
        const needle = String(node.config?.contains ?? "").toLowerCase().trim();
        const hay = String(vars.last_message ?? "").toLowerCase();
        const passed = !needle || hay.includes(needle);
        log.push({ node: node.id, type: "condition", passed });
        if (!passed) { i = nodes.length; break; } // stop the run
        continue;
      }

      if (node.type === "handoff") {
        if (run.conversation_id) await db.from("wa_conversations").update({ assigned_to: "Front desk (workflow)" }).eq("id", run.conversation_id);
        log.push({ node: node.id, type: "handoff" });
        continue;
      }

      if (node.type === "action") {
        const action = node.config?.action ?? "none";
        if (action === "tag" && run.patient_id && node.config?.value) {
          await db.from("patients").update({ status: node.config.value }).eq("id", run.patient_id);
        }
        log.push({ node: node.id, type: "action", action });
        continue;
      }

      // agent / unknown — leave it to the channel's AI agent.
      log.push({ node: node.id, type: node.type, note: "no-op" });
    } catch (e) {
      log.push({ node: node.id, type: node.type, error: e instanceof Error ? e.message : "failed" });
    }
  }

  await db.from("workflow_runs").update({ status: "done", node_index: nodes.length, log, updated_at: new Date().toISOString() }).eq("id", run.id);
}

// Resume every waiting run whose timer has elapsed (called by the cron).
export async function resumeDueRuns(db: DB, limit = 25): Promise<number> {
  const nowIso = new Date().toISOString();
  const { data: runs } = await db.from("workflow_runs").select("*").eq("status", "waiting").lte("resume_at", nowIso).order("resume_at").limit(limit);
  let resumed = 0;
  for (const run of runs ?? []) {
    const { data: wf } = await db.from("workflows").select("*").eq("id", run.workflow_id).maybeSingle();
    if (!wf) { await db.from("workflow_runs").update({ status: "failed", log: [...(run.log ?? []), { error: "workflow deleted" }] }).eq("id", run.id); continue; }
    // mark running so a second cron tick doesn't pick it up mid-flight
    await db.from("workflow_runs").update({ status: "running" }).eq("id", run.id);
    await advanceRun(db, run, wf);
    resumed++;
  }
  return resumed;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
