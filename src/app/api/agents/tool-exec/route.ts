import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { getSlots, bookAppointment, rescheduleAppt, cancelAppt, type BookingCtx } from "@/lib/booking-server";
import { sendAgentEmail } from "@/lib/email-send";

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
      default:
        result = "Unsupported tool.";
    }
  } catch (e) {
    result = `Error: ${e instanceof Error ? e.message : "tool failed"}`;
  }
  return NextResponse.json({ result });
}
