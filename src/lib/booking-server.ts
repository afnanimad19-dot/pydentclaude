// Server-side booking actions shared by the chat (WhatsApp/IG/Messenger) webhook
// and the voice (Vapi) webhook, so a booking made by a calling agent behaves
// exactly like one made by a chat agent: it lands on the Calendar, forwards to
// Open Dental when connected, and records the patient's details, the fee, and
// where the booking came from (which agent / channel).

import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { getOdConfig, odForward } from "@/lib/opendental-gateway";
import { triggerWorkflows } from "@/lib/workflow-runner";
import { pushToGoogleCalendar, updateGoogleCalendarEvent, deleteGoogleCalendarEvent } from "@/lib/google-api";
import { getHfxCreds, hfxCall, hfxConfigured } from "@/lib/hyperfx";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BookingCtx {
  ws: string | null;
  patientId: string | null; // known patient (else resolved from phone/email)
  name: string; // caller/contact name fallback
  phone: string; // caller/contact phone fallback
  source: string; // 'voice' | 'whatsapp' | 'instagram' | 'messenger' | 'sms' | 'email' | 'manual'
  bookedBy: string; // agent name that made the booking
  log?: (m: string) => Promise<void> | void;
}

export interface BookingArgs {
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  phone?: string;
  service?: string;
  treatment?: string;
  fee?: number | string;
  doctor?: string;
  datetime?: string;
}

// Mirror a booking onto the clinic's Google Calendar connected on the marketing
// engine (Hyperfx). Used when the in-app Google OAuth calendar isn't connected.
// The engine's tool arg names can vary by version, so retry once with alternate
// field names. Best-effort: a failure never blocks the booking.
export async function pushToEngineCalendar(
  ws: string,
  ev: { summary: string; description: string; date: string; time: string }
): Promise<{ ok: boolean; id?: string | null }> {
  try {
    const creds = await getHfxCreds(ws);
    if (!hfxConfigured(creds)) return { ok: false };
    const t = (ev.time || "09:00").slice(0, 5);
    const [h, m] = t.split(":").map(Number);
    const endMin = h * 60 + m + 30;
    const start = `${ev.date}T${t}:00`;
    const end = `${ev.date}T${String(Math.floor(endMin / 60) % 24).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}:00`;
    let r = await hfxCall("google_calendar_create_event", { summary: ev.summary, description: ev.description, start_time: start, end_time: end }, creds);
    if (!r.ok && /param|field|required|invalid|schema|argument|unexpected/i.test(r.error ?? "")) {
      r = await hfxCall("google_calendar_create_event", { title: ev.summary, description: ev.description, start, end }, creds);
    }
    if (!r.ok) return { ok: false };
    // Recover the event id so reschedules/cancellations can target it later.
    const d: any = r.data;
    const id = d?.id ?? d?.event_id ?? d?.eventId ?? d?.event?.id ?? null;
    return { ok: true, id: id ? String(id) : null };
  } catch {
    return { ok: false };
  }
}

// Move / remove the mirrored Google Calendar event for an appointment — works
// for both mirror paths: in-app OAuth ids, and engine-created events (stored
// with an "hfx:" prefix, updated through the engine's calendar tools).
async function syncCalendarEvent(
  ws: string | null,
  storedId: string | null | undefined,
  change: { kind: "move"; date: string; time: string } | { kind: "delete" }
): Promise<void> {
  if (!ws || !storedId) return;
  try {
    if (storedId.startsWith("hfx:")) {
      const eventId = storedId.slice(4);
      const creds = await getHfxCreds(ws);
      if (!hfxConfigured(creds)) return;
      if (change.kind === "move") {
        const t = change.time.slice(0, 5);
        const [h, m] = t.split(":").map(Number);
        const endMin = h * 60 + m + 30;
        const start = `${change.date}T${t}:00`;
        const end = `${change.date}T${String(Math.floor(endMin / 60) % 24).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}:00`;
        let r = await hfxCall("google_calendar_update_event", { event_id: eventId, start_time: start, end_time: end }, creds);
        if (!r.ok) r = await hfxCall("google_calendar_update_event", { eventId, start, end }, creds);
        void r;
      } else {
        // Delete tool availability varies — try it, else mark the event cancelled.
        const del = await hfxCall("google_calendar_delete_event", { event_id: eventId }, creds);
        if (!del.ok) await hfxCall("google_calendar_update_event", { event_id: eventId, summary: "CANCELLED — appointment" }, creds);
      }
    } else if (change.kind === "move") {
      await updateGoogleCalendarEvent(ws, storedId, { date: change.date, time: change.time });
    } else {
      await deleteGoogleCalendarEvent(ws, storedId);
    }
  } catch {
    /* calendar mirror is best-effort — the in-app calendar is the truth */
  }
}

function toFee(v: number | string | undefined): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Find an existing lead/patient by phone, then email; otherwise create one.
async function resolvePatient(ctx: BookingCtx, args: BookingArgs): Promise<string | null> {
  if (ctx.patientId) return ctx.patientId;
  const phone = (args.phone || ctx.phone || "").trim();
  const email = (args.email || "").trim();
  const fullName = [args.firstName, args.lastName].filter(Boolean).join(" ").trim() || args.name || ctx.name || "";

  if (phone) {
    const digits = phone.replace(/\D/g, "");
    const { data: pts } = await supabase.from("patients").select("id, phone").eq("workspace_id", ctx.ws);
    const match = (pts ?? []).find((p: any) => String(p.phone ?? "").replace(/\D/g, "").endsWith(digits.slice(-9)) && digits.length >= 7);
    if (match) return match.id;
  }
  if (email) {
    const { data } = await supabase.from("patients").select("id").eq("workspace_id", ctx.ws).eq("email", email).maybeSingle();
    if (data?.id) return data.id;
  }
  const { data: created } = await supabase
    .from("patients")
    .insert({
      workspace_id: ctx.ws,
      name: fullName || phone || "New lead",
      phone,
      email,
      status: "New",
      source_channel: ctx.source,
      source_agent: ctx.bookedBy || `${ctx.source} agent`,
    })
    .select("id")
    .single();
  return created?.id ?? null;
}

// Real open slots: Open Dental when connected, otherwise the local calendar
// (clinic hours 09:00–17:00 minus already-booked times).
export async function getSlots(ws: string | null, args: any): Promise<string> {
  const date = String(args?.date || "").slice(0, 10);
  if (!date) return "Ask the patient which date they'd like first.";
  try {
    const od = await getOdConfig(ws);
    if (od?.enabled) {
      const r = await odForward(ws, "/available-slots", { method: "POST", body: { doctorId: args.doctor || "", serviceId: args.service || args.treatment || "", date } });
      const slots = (r.data as any)?.slots;
      if (Array.isArray(slots) && slots.length) return `Open slots on ${date}: ${slots.join(", ")}.`;
      return `No open slots returned by Open Dental for ${date}.`;
    }
  } catch {
    /* fall through to local availability */
  }
  const { data: booked } = await supabase.from("appointments").select("time").eq("workspace_id", ws).eq("date", date).neq("status", "Broken");
  const taken = new Set((booked ?? []).map((b: any) => String(b.time || "").slice(0, 5)));
  const open: string[] = [];
  for (let h = 9; h < 17; h++) for (const m of ["00", "30"]) {
    const t = `${String(h).padStart(2, "0")}:${m}`;
    if (!taken.has(t)) open.push(t);
  }
  const offer = open.slice(0, 6);
  return offer.length ? `Open slots on ${date}: ${offer.join(", ")}.` : `Fully booked on ${date} — suggest another day.`;
}

// Book an appointment onto the Calendar (always) + Open Dental (if connected),
// recording the fee, the channel/source, and which agent booked it. Stores the
// Open Dental appointment id so reschedule/cancel can target it later.
export async function bookAppointment(ctx: BookingCtx, args: BookingArgs): Promise<string> {
  const ws = ctx.ws;
  const dt = String(args.datetime || "");
  const date = dt.slice(0, 10);
  const time = dt.slice(11, 16) || "09:00";
  if (!date) return "Could not book — no valid date/time was provided.";

  const treatment = (args.treatment || args.service || "Consultation").trim();
  const fee = toFee(args.fee);

  // Don't double-book: reject if the slot is already taken (same provider, or any
  // provider when none is specified).
  let conflictQ = supabase.from("appointments").select("id").eq("workspace_id", ws).eq("date", date).eq("time", time).neq("status", "Broken");
  if (args.doctor) conflictQ = conflictQ.eq("provider", args.doctor);
  const { data: clash } = await conflictQ.limit(1).maybeSingle();
  if (clash) return `That slot (${date} ${time}) is already taken — offer the patient a different open time.`;

  const patientId = await resolvePatient(ctx, args);

  // Fill in the lead's name/email/phone if the agent collected them, so the
  // calendar card and contact record are complete.
  const fullName = [args.firstName, args.lastName].filter(Boolean).join(" ").trim() || (args.name ?? "");
  if (patientId) {
    const patch: Record<string, string> = {};
    if (fullName) patch.name = fullName;
    if (args.email) patch.email = args.email;
    if (args.phone || ctx.phone) patch.phone = args.phone || ctx.phone;
    if (Object.keys(patch).length) await supabase.from("patients").update(patch).eq("id", patientId);
  }

  const baseRow: Record<string, any> = {
    workspace_id: ws,
    patient_id: patientId,
    provider: args.doctor || "",
    procedure: treatment,
    date,
    time,
    status: "Scheduled",
    confirmed_via: ctx.source,
    fee,
    source: ctx.source,
    booked_by: ctx.bookedBy || "",
  };

  let { data: appt, error: apptErr } = await supabase.from("appointments").insert(baseRow).select("id").single();
  // Newer columns (fee/source/booked_by) may not be migrated yet — retry without them.
  if (apptErr && /fee|source|booked_by/.test(apptErr.message)) {
    delete baseRow.fee;
    delete baseRow.source;
    delete baseRow.booked_by;
    ({ data: appt, error: apptErr } = await supabase.from("appointments").insert(baseRow).select("id").single());
  }
  if (apptErr || !appt) {
    await ctx.log?.(`⚠️ Booking NOT saved to calendar: ${apptErr?.message ?? "insert failed"}.`);
    return `Could not save the appointment (${apptErr?.message ?? "database error"}). Tell the patient you'll confirm shortly — do not say it is booked.`;
  }

  // The appointment is on OUR calendar now — that's the source of truth the agent
  // confirms to the caller. The external mirrors (Open Dental, Google Calendar) and
  // workflow triggers run in the BACKGROUND (fire-and-forget) so the voice tool
  // responds immediately and the agent doesn't keep saying "one moment" while a
  // slow HTTP push to Open Dental / Google completes.
  const apptId = appt.id;
  void (async () => {
    try {
      const od = await getOdConfig(ws);
      if (od?.enabled) {
        const r = await odForward(ws, "/create-appointment", {
          method: "POST",
          body: { name: fullName || ctx.name, phone: args.phone || ctx.phone || "", email: args.email || "", doctorId: args.doctor || "", serviceId: treatment, fee, datetime: dt, consent: true },
        });
        const extId = (r.data as any)?.appointmentId;
        if (r.status === 200 && extId && apptId) await supabase.from("appointments").update({ external_id: String(extId) }).eq("id", apptId);
      }
    } catch { /* keep the Calendar booking even if Open Dental is unreachable */ }
    try {
      if (ws) {
        const calSummary = `${treatment} — ${fullName || ctx.name || "Patient"}`;
        const calDescription = [`Booked via ${ctx.source}`, args.phone || ctx.phone ? `Phone: ${args.phone || ctx.phone}` : "", fee != null ? `Fee: ${fee}` : ""].filter(Boolean).join("\n");
        const eventId = await pushToGoogleCalendar(ws, { summary: calSummary, description: calDescription, date, time });
        if (eventId && apptId) await supabase.from("appointments").update({ google_calendar_event_id: eventId }).eq("id", apptId);
        // In-app Google OAuth not connected (or push failed) → mirror the event
        // through the Google Calendar connected on the marketing engine instead,
        // remembering its id (hfx: prefix) so reschedules/cancels can follow.
        if (!eventId) {
          const eng = await pushToEngineCalendar(ws, { summary: calSummary, description: calDescription, date, time });
          if (eng.ok && eng.id && apptId) await supabase.from("appointments").update({ google_calendar_event_id: `hfx:${eng.id}` }).eq("id", apptId);
        }
      }
    } catch { /* keep the booking even if Google Calendar push fails */ }
    try {
      await triggerWorkflows(supabase, ws, "appointment_booked", ctx.source, {
        patientId, conversationId: null, channel: ctx.source, contactPhone: args.phone || ctx.phone || "", name: fullName || ctx.name, lastMessage: "",
      });
    } catch { /* never block the booking */ }
  })();

  const feeNote = fee != null ? ` · fee ${fee}` : "";
  await ctx.log?.(`📅 Booked ${treatment} on ${date} ${time} for ${fullName || ctx.name}${feeNote} via ${ctx.source}.`);
  return `Appointment booked: ${treatment}${args.doctor ? ` with ${args.doctor}` : ""} on ${date} at ${time}${feeNote}.`;
}

// Reschedule the patient's next appointment.
export async function rescheduleAppt(ctx: BookingCtx, args: any): Promise<string> {
  const ws = ctx.ws;
  const patientId = ctx.patientId ?? (await resolvePatient(ctx, args));
  if (!patientId) return "No patient on file to reschedule.";
  const dt = String(args?.datetime || "");
  const date = dt.slice(0, 10);
  const time = dt.slice(11, 16) || "09:00";
  if (!date) return "Need a valid new date and time.";
  const { data: ap } = await supabase.from("appointments").select("id, external_id, google_calendar_event_id").eq("workspace_id", ws).eq("patient_id", patientId).gte("date", new Date().toISOString().slice(0, 10)).neq("status", "Broken").order("date").order("time").limit(1).maybeSingle();
  if (!ap) return "No upcoming appointment found to reschedule.";
  await supabase.from("appointments").update({ date, time }).eq("id", ap.id);
  void syncCalendarEvent(ws, ap.google_calendar_event_id, { kind: "move", date, time });
  try {
    const od = await getOdConfig(ws);
    if (od?.enabled && ap.external_id) await odForward(ws, "/reschedule-appointment", { method: "POST", body: { appointmentId: ap.external_id, datetime: dt } });
  } catch {
    /* keep the Calendar change */
  }
  await ctx.log?.(`🔁 Rescheduled appointment to ${date} ${time} for ${ctx.name} via ${ctx.source}.`);
  return `Rescheduled to ${date} at ${time}.`;
}

// Cancel the patient's next appointment.
export async function cancelAppt(ctx: BookingCtx, args?: any): Promise<string> {
  const ws = ctx.ws;
  const patientId = ctx.patientId ?? (await resolvePatient(ctx, args ?? {}));
  if (!patientId) return "No patient on file.";
  const { data: ap } = await supabase.from("appointments").select("id, external_id, google_calendar_event_id").eq("workspace_id", ws).eq("patient_id", patientId).gte("date", new Date().toISOString().slice(0, 10)).neq("status", "Broken").order("date").order("time").limit(1).maybeSingle();
  if (!ap) return "No upcoming appointment found to cancel.";
  await supabase.from("appointments").update({ status: "Broken" }).eq("id", ap.id);
  void syncCalendarEvent(ws, ap.google_calendar_event_id, { kind: "delete" });
  try {
    const od = await getOdConfig(ws);
    if (od?.enabled && ap.external_id) await odForward(ws, "/cancel-appointment", { method: "POST", body: { appointmentId: ap.external_id } });
  } catch {
    /* keep the Calendar change */
  }
  await ctx.log?.(`❌ Cancelled appointment for ${ctx.name} via ${ctx.source}.`);
  return "Your appointment has been cancelled.";
}
/* eslint-enable @typescript-eslint/no-explicit-any */
