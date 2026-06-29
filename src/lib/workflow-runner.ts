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
//  - action     — config.action: tag (set patient status) | add_to_pipeline (set
//                 lifecycle stage) | call (place an outbound voice call) | none
//  - agent      — leave it to the channel's AI agent (no-op here)

import { sendByChannel } from "@/lib/wa-send";
import { sendSms } from "@/lib/sms-send";
import { sendEmail } from "@/lib/email-send";
import { resolveVapiPhoneNumberId, placeOutboundCall } from "@/lib/vapi-call";
import { saveReport, markdownToHtml } from "@/lib/report-render";

// Base URL for report download links (the runner has no request origin).
const BASE_URL = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.NEXT_PUBLIC_SITE_URL || "";

/* eslint-disable @typescript-eslint/no-explicit-any */
type DB = any; // a Supabase client (anon shared or service-role admin)

export interface RunContext {
  patientId?: string | null;
  conversationId?: string | null;
  channel: string;
  contactPhone: string;
  name?: string;
  email?: string;
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
    email: ctx.email || "",
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

// Server-side practice rollup for the report action (the cron has no auth
// session, so this takes an explicit db client + ws and filters by workspace).
export async function fetchPracticeSummary(db: DB, ws: string, sinceIso: string) {
  const since = sinceIso.slice(0, 10);
  const [pats, appts] = await Promise.all([
    db.from("patients").select("created_at, recall_due, balance, status").eq("workspace_id", ws),
    db.from("appointments").select("date, status, fee").eq("workspace_id", ws).gte("date", since),
  ]);
  const patients: any[] = pats.data ?? [];
  const appointments: any[] = appts.data ?? [];
  const newPatients = patients.filter((p) => p.created_at && p.created_at >= sinceIso).length;
  const recallDue = patients.filter((p) => p.recall_due).length;
  const outstanding = patients.reduce((n, p) => n + Number(p.balance ?? 0), 0);
  const booked = appointments.length;
  const completed = appointments.filter((a) => a.status === "Completed").length;
  const broken = appointments.filter((a) => ["Broken", "Cancelled", "No-show", "Failed"].includes(String(a.status))).length;
  const production = appointments.filter((a) => a.status === "Completed").reduce((n, a) => n + Number(a.fee ?? 0), 0);
  return { totalPatients: patients.length, newPatients, recallDue, outstanding, booked, completed, broken, production };
}

function renderPracticeDigest(s: Awaited<ReturnType<typeof fetchPracticeSummary>>, periodLabel: string): string {
  return [
    `# Practice digest`,
    `_Period: ${periodLabel}_`,
    ``,
    `## Patients`,
    `- Total patients on file: **${s.totalPatients}**`,
    `- New patients this period: **${s.newPatients}**`,
    `- Due for recall: **${s.recallDue}**`,
    `- Outstanding balance: **${s.outstanding.toLocaleString()}**`,
    ``,
    `## Appointments`,
    `- Booked (this period): **${s.booked}**`,
    `- Completed: **${s.completed}**`,
    `- Broken / cancelled / no-show: **${s.broken}**`,
    `- Production (completed fees): **${s.production.toLocaleString()}**`,
  ].join("\n");
}

// Look up a patient's email for email-channel workflow messages.
async function patientEmail(db: DB, patientId: string): Promise<string> {
  try {
    const { data } = await db.from("patients").select("email").eq("id", patientId).maybeSingle();
    return data?.email ?? "";
  } catch {
    return "";
  }
}

// Place an outbound call for a "call" action: resolve the configured voice agent's
// Vapi assistant id + the chosen number's Vapi id, then dial the run's contact.
async function placeCall(db: DB, run: any, cfg: any): Promise<{ ok: boolean; message: string }> {
  if (!run.contact_phone) return { ok: false, message: "no contact number to call" };
  if (!cfg?.agentId) return { ok: false, message: "no voice agent configured on the call step" };
  try {
    const { data: agent } = await db.from("agents").select("vapi_assistant_id, name").eq("id", cfg.agentId).maybeSingle();
    if (!agent?.vapi_assistant_id) return { ok: false, message: "the call step's agent isn't synced to Vapi yet" };
    let vapiPhoneNumberId: string | null = null, fromNumber: string | null = null;
    if (cfg.numberId) {
      const { data: num } = await db.from("voice_numbers").select("vapi_phone_number_id, number").eq("id", cfg.numberId).maybeSingle();
      vapiPhoneNumberId = num?.vapi_phone_number_id ?? null;
      fromNumber = num?.number ?? null;
    }
    const phoneNumberId = await resolveVapiPhoneNumberId({ vapiPhoneNumberId, fromNumber });
    if (!phoneNumberId) return { ok: false, message: "the call step's number isn't registered on Vapi" };
    const r = await placeOutboundCall({ assistantId: agent.vapi_assistant_id, phoneNumberId, toNumber: run.contact_phone });
    return r.ok ? { ok: true, message: `calling ${run.contact_phone}` } : { ok: false, message: r.error ?? "call failed" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "call failed" };
  }
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
        if (!text.trim()) { log.push({ node: node.id, type: "message", skipped: "empty text" }); continue; }
        // Route to the right transport for the run's channel. SMS → Twilio,
        // Email → the clinic's email provider (needs a recipient email), and
        // WhatsApp/Messenger/Instagram → the Meta channels.
        if (run.channel === "sms") {
          if (!run.contact_phone) { log.push({ node: node.id, type: "message", skipped: "no phone" }); continue; }
          const r = await sendSms({ to: run.contact_phone, body: text, ws: run.workspace_id });
          log.push({ node: node.id, type: "message", channel: "sms", ok: r.startsWith("SMS sent"), info: r });
        } else if (run.channel === "email") {
          const to = vars.email || (run.patient_id ? await patientEmail(db, run.patient_id) : "");
          if (!to) { log.push({ node: node.id, type: "message", skipped: "no email recipient" }); continue; }
          const subject = node.config?.subject || node.title || "A message from your clinic";
          const r = await sendEmail({ to, subject: renderTemplate(String(subject), vars), html: `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;line-height:1.6">${text.replace(/\n/g, "<br>")}</div>`, ws: run.workspace_id });
          log.push({ node: node.id, type: "message", channel: "email", ok: r.startsWith("Email sent"), info: r });
        } else if (run.contact_phone) {
          const sent = await sendByChannel(run.channel, run.contact_phone, text);
          log.push({ node: node.id, type: "message", ok: sent.ok, error: sent.error ?? null });
        } else {
          log.push({ node: node.id, type: "message", skipped: "no contact" });
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
          log.push({ node: node.id, type: "action", action });
        } else if (action === "add_to_pipeline") {
          // Set the contact's lifecycle stage (this is what the Pipeline reads).
          const stage = node.config?.value || "New Lead";
          if (run.conversation_id) await db.from("wa_conversations").update({ lifecycle: stage }).eq("id", run.conversation_id);
          log.push({ node: node.id, type: "action", action, stage, applied: !!run.conversation_id });
        } else if (action === "call") {
          // Place an outbound voice call to the contact with a chosen voice agent + number.
          const r = await placeCall(db, run, node.config);
          log.push({ node: node.id, type: "action", action, ok: r.ok, info: r.message });
        } else {
          log.push({ node: node.id, type: "action", action });
        }
        continue;
      }

      if (node.type === "report") {
        const cfg = node.config ?? {};
        const days = Number(cfg.days ?? 7);
        const sinceIso = new Date(Date.now() - days * 86400000).toISOString();
        const summary = await fetchPracticeSummary(db, run.workspace_id, sinceIso);
        const periodLabel = `last ${days} day${days === 1 ? "" : "s"}`;
        const md = renderPracticeDigest(summary, periodLabel);
        const title = renderTemplate(String(cfg.subject || node.title || "Practice digest"), vars);
        const reportId = await saveReport(run.workspace_id, "reports", title, md);
        const link = reportId && BASE_URL ? `${BASE_URL}/api/team/report/${reportId}?format=${cfg.format || "docx"}` : "";
        const to = cfg.recipient || vars.report_recipient || vars.email;
        if (to) {
          const html = markdownToHtml(title, md) + (link ? `<p><a href="${link}">Download ${cfg.format || "docx"}</a></p>` : "");
          const r = await sendEmail({ to: String(to), subject: title, html, ws: run.workspace_id });
          log.push({ node: node.id, type: "report", ok: r.startsWith("Email sent"), reportId, info: r });
        } else {
          log.push({ node: node.id, type: "report", skipped: "no recipient", reportId });
        }
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

function cadenceMs(cadence: string): number {
  return cadence === "daily" ? 86400000 : cadence === "monthly" ? 30 * 86400000 : 7 * 86400000;
}

// Fire Live workflows whose trigger is 'scheduled' and whose cadence has elapsed
// since last_fired_at. Claims each (sets last_fired_at) BEFORE running so an
// overlapping cron tick can't double-fire. Tolerates the column being absent.
export async function triggerScheduledWorkflows(db: DB): Promise<number> {
  let workflows: any[] = [];
  try {
    const { data, error } = await db.from("workflows").select("*").eq("status", "Live");
    if (error) return 0;
    workflows = data ?? [];
  } catch {
    return 0;
  }
  const now = Date.now();
  let fired = 0;
  for (const wf of workflows) {
    try {
      if (triggerEvent(wf) !== "scheduled") continue;
      const trigger = (wf.nodes ?? []).find((n: any) => n.type === "trigger");
      const cadence = trigger?.config?.cadence ?? "weekly";
      const last = wf.last_fired_at ? Date.parse(wf.last_fired_at) : 0;
      if (last && now - last < cadenceMs(cadence)) continue;
      // Claim it: only proceed if our update of last_fired_at sticks against the
      // same prior value (prevents two ticks both firing). If the column is
      // missing, this errors and we skip scheduled handling entirely.
      let q = db.from("workflows").update({ last_fired_at: new Date(now).toISOString() }).eq("id", wf.id);
      q = wf.last_fired_at ? q.eq("last_fired_at", wf.last_fired_at) : q.is("last_fired_at", null);
      const claim = await q.select("id");
      if (claim.error) { if (/last_fired_at/.test(claim.error.message)) return fired; continue; }
      if (!claim.data?.length) continue; // someone else claimed it
      const recipient = trigger?.config?.recipient || "";
      await startRun(db, wf.workspace_id, wf, { channel: "email", contactPhone: "", email: recipient, name: "", lastMessage: "" });
      fired++;
    } catch { /* one bad workflow shouldn't abort the tick */ }
  }
  return fired;
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
