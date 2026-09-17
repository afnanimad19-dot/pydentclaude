import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { getSlots, bookAppointment, rescheduleAppt, cancelAppt, type BookingCtx } from "@/lib/booking-server";
import { sendAgentEmail } from "@/lib/email-send";
import { retrieveKnowledge } from "@/lib/kb-retrieval";

/* eslint-disable @typescript-eslint/no-explicit-any */
// search_knowledge: the voice agent's per-turn knowledge retrieval. Runs the
// SAME retrieval code the chat agents use (lib/kb-retrieval.ts) over the
// agent's stored knowledge base, so a fact anywhere in the documents or the
// crawled website is reachable mid-call — nothing depends on how much of the
// KB fit into the initial prompt. Returns top chunks with their source names.
async function searchKnowledge(agent: any, a: any): Promise<string> {
  const query = String(a.query ?? "").trim();
  if (!query) return "Provide a query describing what to look up.";
  const started = Date.now();
  const r = retrieveKnowledge(String(agent.knowledge_base ?? ""), [query, String(a.context ?? "")], {
    budget: 6000,
    relevantBudget: 6000,
    topK: 4,
  });
  // Small KBs come back whole ("full" mode) — trim to the budget for a voice turn.
  const text = r.mode === "full" ? r.text.slice(0, 6000) : r.text;
  // Observability: sources + scores + latency, never the knowledge text itself.
  console.log(
    `[kb-retrieval] agent=${agent.name} channel=voice mode=${r.mode} kb_chars=${r.totalKbChars} latency_ms=${Date.now() - started} top=${r.chunks.map((c) => `${c.source}#${c.id}:${c.score}`).slice(0, 4).join(", ") || "(full)"}`
  );
  if (!text.trim()) return "The knowledge base has no information about that.";
  return `Relevant clinic knowledge (answer ONLY from this; if the specific fact isn't here, say you don't have it):\n${text}`;
}

// lookup_patient / create_patient — real backends for the tools the voice
// worker registers. Lookup prefers phone (digits-only match); create dedupes
// by phone so a repeat caller never becomes a duplicate record.
async function lookupPatient(agent: any, a: any): Promise<string> {
  const ws = agent.workspace_id ?? null;
  const phone = String(a.phone ?? "").replace(/[^0-9+]/g, "");
  const name = String(a.name ?? "").trim();
  if (!phone && !name) return "Provide a phone number or a name to look up.";
  const q = supabase.from("patients").select("id, name, phone, email, next_appointment, insurance").eq("workspace_id", ws);
  const { data } = phone
    ? await q.ilike("phone", `%${phone.replace(/^\+/, "").slice(-9)}%`).limit(3)
    : await q.ilike("name", `%${name}%`).limit(3);
  if (!data?.length) return "No matching patient record found — they may be a new patient.";
  return data
    .map((p: any) => `Found: ${p.name}${p.phone ? `, phone ${p.phone}` : ""}${p.email ? `, email ${p.email}` : ""}${p.next_appointment ? `, next appointment ${p.next_appointment}` : ""}${p.insurance ? `, insurance ${p.insurance}` : ""}`)
    .join("\n");
}

async function createPatient(agent: any, a: any): Promise<string> {
  const ws = agent.workspace_id ?? null;
  const name = String(a.name ?? "").trim();
  const phone = String(a.phone ?? "").replace(/[^0-9+]/g, "");
  const email = String(a.email ?? "").trim();
  if (!name) return "A name is required to create a patient record.";
  if (phone) {
    const { data: existing } = await supabase
      .from("patients").select("id, name").eq("workspace_id", ws)
      .ilike("phone", `%${phone.replace(/^\+/, "").slice(-9)}%`).limit(1);
    if (existing?.length) return `A record already exists for this phone number (${existing[0].name}) — no duplicate was created.`;
  }
  const { error } = await supabase.from("patients").insert({
    workspace_id: ws, name, phone, email, status: "New",
    source_channel: "voice", source_agent: agent.name,
  });
  if (error) {
    // Older DBs may lack source columns — retry with the core fields.
    const { error: e2 } = await supabase.from("patients").insert({ workspace_id: ws, name, phone, email, status: "New" });
    if (e2) return `Could not create the record: ${e2.message}`;
  }
  return `Created a new patient record for ${name}.`;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// Executes one agent tool call from a live in-browser Grok voice session. The
// realtime model calls a function on the client; the browser posts it here so
// the actual booking/email runs server-side with the same code path as every
// other channel (Calendar + Open Dental + workflows).
export const runtime = "nodejs";

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function POST(req: NextRequest) {
  const { agentId, name, args } = await req.json().catch(() => ({}));
  if (!agentId || !name) return NextResponse.json({ error: "agentId and name are required." }, { status: 400 });

  const { data: agent } = await supabase.from("agents").select("*").eq("id", agentId).maybeSingle();
  if (!agent) return NextResponse.json({ error: "Agent not found." }, { status: 404 });

  const a: any = args ?? {};
  const ctx: BookingCtx = {
    ws: agent.workspace_id ?? null,
    patientId: null,
    name: String(a.name ?? ""),
    phone: String(a.phone ?? ""),
    source: "voice",
    bookedBy: agent.name,
  };

  let result: string;
  try {
    switch (name) {
      case "get_available_slots":
        result = await getSlots(ctx.ws, a);
        break;
      case "book_appointment":
        result = await bookAppointment(ctx, a);
        break;
      case "reschedule_appointment":
        result = await rescheduleAppt(ctx, a);
        break;
      case "cancel_appointment":
        result = await cancelAppt(ctx, a);
        break;
      case "send_email":
        result = await sendAgentEmail({ to: String(a.to ?? ""), subject: String(a.subject ?? ""), body: String(a.body ?? ""), ws: agent.workspace_id ?? undefined, fromName: agent.name });
        break;
      case "search_knowledge":
        result = await searchKnowledge(agent, a);
        break;
      case "lookup_patient":
        result = await lookupPatient(agent, a);
        break;
      case "create_patient":
        result = await createPatient(agent, a);
        break;
      default:
        result = "Unsupported tool.";
    }
  } catch (e) {
    result = `Error: ${e instanceof Error ? e.message : "tool failed"}`;
  }
  return NextResponse.json({ result });
}
