// Server-side booking actions shared by the chat (WhatsApp/IG/Messenger) webhook
// and the voice (Vapi) webhook, so a booking made by a calling agent behaves
// exactly like one made by a chat agent: it lands on the Calendar, forwards to
// Open Dental when connected, and records the patient's details, the fee, and
// where the booking came from (which agent / channel).

import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { getOdConfig, odForward } from "@/lib/opendental-gateway";
import { triggerWorkflows } from "@/lib/workflow-runner";
import { pushToGoogleCalendar, updateGoogleCalendarEvent, deleteGoogleCalendarEvent } from "@/lib/google-api";
import { getHfxCreds, hfxCall, hfxConfigured, hfxListTools, type HfxCreds } from "@/lib/hyperfx";
import {
  todayInTz, DEFAULT_CLINIC_TZ, clampDuration,
  normalizeSchedulingSettings, DEFAULT_SCHEDULING, openSlotsForDay, conflictsWithBooked, weekdayInTz,
  type SchedulingSettings, type BookedSlot,
} from "@/lib/scheduling";

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

// The clinic's timezone for calendar events (defaults to Dubai).
export async function clinicTimezone(ws: string | null): Promise<string> {
  try {
    if (ws) {
      const { data } = await supabase.from("clinic_settings").select("timezone").eq("workspace_id", ws).maybeSingle();
      if (data?.timezone) return data.timezone;
    }
  } catch { /* default below */ }
  return DEFAULT_CLINIC_TZ;
}

// "Today" as the CLINIC sees it (its own wall-clock date), used everywhere an
// upcoming-appointment cutoff is computed — the server's UTC date is up to
// 4 hours behind a Dubai clinic and misclassifies today's appointments.
export async function clinicToday(ws: string | null): Promise<string> {
  return todayInTz(await clinicTimezone(ws));
}

// Per-workspace scheduling settings (clinic hours, slot grid, default
// duration, closed days). The columns arrive with migration 0061; every
// deployment without them — and every workspace that never configured them —
// gets the historical defaults, so behaviour only changes when a clinic
// explicitly opts in.
async function clinicScheduling(ws: string | null): Promise<SchedulingSettings> {
  try {
    if (ws) {
      const { data, error } = await supabase
        .from("clinic_settings")
        .select("open_time, close_time, slot_minutes, default_duration_min, closed_days")
        .eq("workspace_id", ws)
        .maybeSingle();
      if (!error && data) return normalizeSchedulingSettings(data);
    }
  } catch { /* defaults below */ }
  return DEFAULT_SCHEDULING;
}


// ---- Schema-driven engine calendar -----------------------------------------
// The engine's calendar tool names AND parameter names differ between engine
// versions (a live test showed google_calendar_create_event rejecting `start`
// as an unexpected keyword). Instead of guessing shapes, read the tool's REAL
// input schema from the engine and map our values onto whatever its parameters
// are actually called. Cached briefly so bookings don't re-list tools each time.
type CalToolSpec = { name: string; props: Record<string, any>; required: string[] };
type CalSpecs = { create: CalToolSpec | null; update: CalToolSpec | null; del: CalToolSpec | null };
let calSpecCache: { url: string; at: number; specs: CalSpecs } | null = null;

async function engineCalendarSpecs(creds: HfxCreds): Promise<CalSpecs> {
  if (calSpecCache && calSpecCache.url === creds.url && Date.now() - calSpecCache.at < 10 * 60 * 1000) return calSpecCache.specs;
  const specs: CalSpecs = { create: null, update: null, del: null };
  try {
    const list = await hfxListTools(creds);
    for (const t of list.tools ?? []) {
      if (!/^google_calendar/.test(t.name) || !/event/i.test(t.name)) continue;
      const schema: any = t.inputSchema ?? {};
      const spec: CalToolSpec = { name: t.name, props: schema.properties ?? {}, required: schema.required ?? [] };
      if (/create/i.test(t.name) && !specs.create) specs.create = spec;
      else if (/update|edit|patch/i.test(t.name) && !specs.update) specs.update = spec;
      else if (/delete|remove/i.test(t.name) && !specs.del) specs.del = spec;
    }
  } catch { /* fall back to static shapes */ }
  calSpecCache = { url: creds.url, at: Date.now(), specs };
  return specs;
}

// Map our event values onto the tool's actual parameter names. Order matters:
// timezone/event-id/calendar-id are claimed before the broad start/end matches.
function fillCalendarArgs(
  spec: CalToolSpec,
  v: { summary?: string; description?: string; startIso?: string; endIso?: string; tz: string; eventId?: string }
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, rawDef] of Object.entries(spec.props)) {
    const def: any = rawDef;
    const k = key.toLowerCase();
    // Google's API wants start/end as { dateTime, timeZone } objects — default
    // to that shape (the live 400 came from sending flat strings); only send a
    // string when the schema explicitly says string, and stamp the UTC offset.
    const timeVal = (iso: string) => (def?.type === "object" ? { dateTime: isoWithOffset(iso, v.tz), timeZone: v.tz } : isoWithOffset(iso, v.tz));
    if (/(^|_)(time_?zone|tz)($|_)/.test(k)) args[key] = v.tz;
    else if (v.eventId && /event_?id|^id$/.test(k)) args[key] = v.eventId;
    else if (/calendar_?id/.test(k)) args[key] = "primary";
    else if (v.summary !== undefined && /(summary|title)/.test(k)) args[key] = v.summary;
    else if (v.description !== undefined && /desc/.test(k)) args[key] = v.description;
    else if (v.startIso && /(^|_)(start|begin|from)($|_)/.test(k)) args[key] = timeVal(v.startIso);
    else if (v.endIso && /(^|_)(end|until|finish)($|_)/.test(k)) args[key] = timeVal(v.endIso);
  }
  return args;
}


// RFC3339 with the real UTC offset for the clinic timezone (e.g. +04:00 for
// Asia/Dubai) — Google's API rejects offset-less datetimes with 400 Bad Request.
function isoWithOffset(dateTimeLocal: string, tz: string): string {
  try {
    const probe = new Date(`${dateTimeLocal}Z`);
    const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(probe)
      .find((x) => x.type === "timeZoneName")?.value ?? "GMT+04:00";
    const off = part.replace("GMT", "") || "+04:00";
    return `${dateTimeLocal}${off === "" ? "+00:00" : off}`;
  } catch {
    return `${dateTimeLocal}+04:00`;
  }
}

// The engine sometimes returns an upstream failure as a NORMAL text result
// ("Tool '...' error: ... status_code: 400 ...") without flagging it as an
// error — detect that so a failed calendar write can't masquerade as success.
function engineErrorIn(data: unknown): string | null {
  if (typeof data !== "string") return null;
  if (/Tool '.*' error/i.test(data) || /status_code:\s*[45]\d\d/.test(data)) return data.slice(0, 300);
  return null;
}

async function calCall(creds: HfxCreds, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const r = await hfxCall(name, args, creds);
  if (r.ok) {
    const err = engineErrorIn(r.data);
    if (err) return { ok: false, error: err, data: r.data };
  }
  return r;
}

// Deep-search the engine's response for an event id / link, whatever the
// nesting looks like (result/data/event wrappers vary by engine version).
function deepFindString(obj: any, keys: string[], depth = 0): string | null {
  if (!obj || typeof obj !== "object" || depth > 4) return null;
  for (const k of Object.keys(obj)) {
    if (keys.includes(k.toLowerCase()) && typeof obj[k] === "string" && obj[k]) return obj[k];
  }
  for (const k of Object.keys(obj)) {
    const r = deepFindString(obj[k], keys, depth + 1);
    if (r) return r;
  }
  return null;
}

// Diagnostic for the connection test: the engine calendar tools' REAL names and
// parameter lists, straight from the engine's tool schemas — ends the guessing.
export async function engineCalendarDebug(ws: string): Promise<Record<string, unknown>> {
  try {
    const creds = await getHfxCreds(ws);
    if (!hfxConfigured(creds)) return { error: "engine not configured" };
    calSpecCache = null; // always fresh for the test
    const specs = await engineCalendarSpecs(creds);
    const show = (sp: CalToolSpec | null) =>
      sp ? { tool: sp.name, params: Object.fromEntries(Object.entries(sp.props).map(([k, v]: [string, any]) => [k, v?.type ?? "unknown"])), required: sp.required } : null;
    return { create: show(specs.create), update: show(specs.update), del: show(specs.del) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "debug failed" };
  }
}

// Mirror a booking onto the clinic's Google Calendar connected on the marketing
// engine (Hyperfx). Used when the in-app Google OAuth calendar isn't connected.
// The engine's tool arg names can vary by version, so retry once with alternate
// field names. Best-effort: a failure never blocks the booking.
export async function pushToEngineCalendar(
  ws: string,
  ev: { summary: string; description: string; date: string; time: string }
): Promise<{ ok: boolean; id?: string | null; error?: string; link?: string | null; raw?: string }> {
  try {
    const creds = await getHfxCreds(ws);
    if (!hfxConfigured(creds)) return { ok: false, error: "Marketing engine not configured" };
    const t = (ev.time || "09:00").slice(0, 5);
    const [h, m] = t.split(":").map(Number);
    const endMin = h * 60 + m + 30;
    const start = `${ev.date}T${t}:00`;
    const end = `${ev.date}T${String(Math.floor(endMin / 60) % 24).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}:00`;
    // The engine's calendar tool has two naming generations
    // (google_calendar_events_create is current; *_create_event is legacy) and
    // its arg shape varies — walk names × arg shapes until one sticks. Always
    // pin the clinic timezone (Asia/Dubai default) so events land at the right
    // local hour.
    const tz = await clinicTimezone(ws);
    const startOff = isoWithOffset(start, tz);
    const endOff = isoWithOffset(end, tz);
    const argShapes: Record<string, unknown>[] = [
      { summary: ev.summary, description: ev.description, start: { dateTime: startOff, timeZone: tz }, end: { dateTime: endOff, timeZone: tz } },
      { summary: ev.summary, description: ev.description, start: startOff, end: endOff, time_zone: tz },
      { summary: ev.summary, description: ev.description, start_time: startOff, end_time: endOff, timezone: tz },
    ];
    let r: { ok: boolean; data?: unknown; error?: string } = { ok: false, error: "not attempted" };
    // EXACT mapping — confirmed live against the engine's schema:
    // google_calendar_events_create(summary*, calendar_id, description,
    // start_datetime, end_datetime, start_timezone, end_timezone, ...).
    // Local wall-clock datetimes + explicit timezone params.
    r = await calCall(creds, "google_calendar_events_create", {
      summary: ev.summary,
      description: ev.description,
      calendar_id: "primary",
      start_datetime: start,
      end_datetime: end,
      start_timezone: tz,
      end_timezone: tz,
    });
    // Keep the exact call's error: the legacy fallbacks below fail with
    // confusing "unexpected keyword" noise that hides the real reason.
    const primaryError = r.ok ? "" : String(r.error ?? "");
    // Fallbacks for other engine versions: schema-driven, then legacy shapes.
    if (!r.ok) {
      const specs = await engineCalendarSpecs(creds);
      if (specs.create) {
        r = await calCall(creds, specs.create.name, fillCalendarArgs(specs.create, { summary: ev.summary, description: ev.description, startIso: start, endIso: end, tz }));
      }
    }
    if (!r.ok) {
      outer: for (const tool of ["google_calendar_events_create", "google_calendar_create_event"]) {
        for (const args of argShapes) {
          r = await calCall(creds, tool, args);
          if (r.ok) break outer;
          if (!/param|field|required|invalid|schema|argument|unexpected|type|unknown tool|not found/i.test(r.error ?? "")) break outer;
        }
      }
    }
    if (!r.ok) return { ok: false, error: (primaryError || String(r.error ?? "engine calendar call failed")).slice(0, 1200) };
    // Recover the event id so reschedules/cancellations can target it later,
    // plus the html link + raw payload for the connection test's diagnostics.
    const d: any = r.data;
    const id = d?.id ?? d?.event_id ?? d?.eventId ?? d?.event?.id ?? deepFindString(d, ["id", "event_id", "eventid"]);
    const link = deepFindString(d, ["htmllink", "html_link", "link", "event_link", "url"]);
    let raw = "";
    try { raw = JSON.stringify(d).slice(0, 900); } catch { raw = String(d).slice(0, 900); }
    return { ok: true, id: id ? String(id) : null, link, raw };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "engine calendar call failed" };
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
      const tz = await clinicTimezone(ws);
      if (change.kind === "move") {
        const t = change.time.slice(0, 5);
        const [h, m] = t.split(":").map(Number);
        const endMin = h * 60 + m + 30;
        const start = `${change.date}T${t}:00`;
        const end = `${change.date}T${String(Math.floor(endMin / 60) % 24).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}:00`;
        let moved = false;
        {
          const r = await calCall(creds, "google_calendar_events_update", {
            event_id: eventId,
            calendar_id: "primary",
            start_datetime: start,
            end_datetime: end,
            start_timezone: tz,
            end_timezone: tz,
          });
          moved = r.ok;
        }
        if (!moved) {
          const specs = await engineCalendarSpecs(creds);
          if (specs.update) {
            const r = await calCall(creds, specs.update.name, fillCalendarArgs(specs.update, { startIso: start, endIso: end, tz, eventId }));
            moved = r.ok;
          }
        }
        if (!moved) {
          const shapes: Record<string, unknown>[] = [
            { event_id: eventId, start, end, time_zone: tz },
            { event_id: eventId, start_time: start, end_time: end, timezone: tz },
            { eventId, start: { dateTime: start, timeZone: tz }, end: { dateTime: end, timeZone: tz } },
          ];
          outer: for (const tool of ["google_calendar_events_update", "google_calendar_update_event"]) {
            for (const args of shapes) {
              const r = await calCall(creds, tool, args);
              if (r.ok) break outer;
              if (!/param|field|required|invalid|schema|argument|unexpected|type|unknown tool|not found/i.test(r.error ?? "")) break outer;
            }
          }
        }
      } else {
        // Delete the event; if the delete tool is missing, mark it cancelled.
        let deleted = false;
        {
          const del = await calCall(creds, "google_calendar_events_delete", { event_id: eventId, calendar_id: "primary" });
          deleted = del.ok;
        }
        if (!deleted) {
          const specs = await engineCalendarSpecs(creds);
          if (specs.del) {
            const del = await calCall(creds, specs.del.name, fillCalendarArgs(specs.del, { tz, eventId }));
            deleted = del.ok;
          }
        }
        for (const tool of deleted ? [] : ["google_calendar_events_delete", "google_calendar_delete_event"]) {
          const del = await calCall(creds, tool, { event_id: eventId });
          if (del.ok) { deleted = true; break; }
        }
        if (!deleted) {
          await calCall(creds, "google_calendar_events_update", { event_id: eventId, calendar_id: "primary", summary: "CANCELLED — appointment" });
        }
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

// Lookup-only patient match by phone (last-9-digit match), then email. Never
// creates a record — the Builder HTTP adapter uses this to identify the caller
// before touching an appointment, where silently creating a patient would be
// wrong. resolvePatient() below layers the create-if-missing behaviour on top.
export async function findExistingPatientId(ws: string | null, phoneRaw?: string | null, emailRaw?: string | null): Promise<string | null> {
  const phone = String(phoneRaw ?? "").trim();
  const email = String(emailRaw ?? "").trim();
  if (phone) {
    const digits = phone.replace(/\D/g, "");
    const { data: pts } = await supabase.from("patients").select("id, phone").eq("workspace_id", ws);
    const match = (pts ?? []).find((p: any) => String(p.phone ?? "").replace(/\D/g, "").endsWith(digits.slice(-9)) && digits.length >= 7);
    if (match) return match.id;
  }
  if (email) {
    const { data } = await supabase.from("patients").select("id").eq("workspace_id", ws).eq("email", email).maybeSingle();
    if (data?.id) return data.id;
  }
  return null;
}

// Find an existing lead/patient by phone, then email; otherwise create one.
async function resolvePatient(ctx: BookingCtx, args: BookingArgs): Promise<string | null> {
  if (ctx.patientId) return ctx.patientId;
  const phone = (args.phone || ctx.phone || "").trim();
  const email = (args.email || "").trim();
  const fullName = [args.firstName, args.lastName].filter(Boolean).join(" ").trim() || args.name || ctx.name || "";

  const existing = await findExistingPatientId(ctx.ws, phone, email);
  if (existing) return existing;
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

// sameProvider (loose doctor-name matching) now lives in lib/scheduling.ts,
// shared with the duration-aware overlap helpers and their tests.

// ── Structured results ──────────────────────────────────────────────────────
// The Builder HTTP tool adapter (src/lib/builder-tools.ts) needs machine-
// readable outcomes: success comes from what actually happened, never from
// parsing the spoken sentence. Each structured function carries the exact
// prose the voice worker / chat webhooks already receive in `spoken`, and the
// legacy string-returning exports below simply return that field — so every
// existing caller keeps byte-identical behaviour.
export interface SlotsResult {
  success: boolean;
  spoken: string;
  error?: string;                    // machine code, e.g. "missing_date"
  date?: string;
  slots?: string[];                  // ALL open times (spoken offers at most 6)
  source?: "opendental" | "local";
}

export interface BookingResult {
  success: boolean;
  spoken: string;
  error?: string;                    // "invalid_datetime" | "slot_taken" | "db_error"
  appointmentId?: string;            // Pydent appointment UUID (NOT the Open Dental AptNum)
  patientId?: string | null;
  date?: string;
  time?: string;
  treatment?: string;
  provider?: string;
  fee?: number | null;
}

export interface UpcomingAppointment {
  id: string;                        // Pydent appointment UUID
  external_id: string | null;        // internal mirror id (background sync); never part of the Builder contract
  google_calendar_event_id: string | null;
  patient_id: string | null;
  date: string;
  time: string;
  procedure: string | null;
  provider: string | null;
  status?: string | null;
}

export interface ApptActionResult {
  success: boolean;
  spoken: string;
  error?: string;
  appointmentId?: string;            // Pydent UUID acted on
  externalId?: string | null;        // Open Dental AptNum of that appointment
  date?: string;
  time?: string;
}

// Real open slots: Open Dental when it actually ANSWERS, otherwise the local
// calendar (clinic hours 09:00–17:00 minus times already booked FOR THAT
// DOCTOR — two patients at the same time with different doctors is normal).
export async function getSlotsStructured(ws: string | null, args: any): Promise<SlotsResult> {
  const date = String(args?.date || "").slice(0, 10);
  if (!date) return { success: false, error: "missing_date", spoken: "Ask the patient which date they'd like first." };
  try {
    const od = await getOdConfig(ws);
    if (od?.enabled) {
      const r = await odForward(ws, "/available-slots", { method: "POST", body: { doctorId: args.doctor || "", serviceId: args.service || args.treatment || "", date } });
      const slots = (r.data as any)?.slots;
      // Only trust Open Dental when it genuinely responded. An unreachable /
      // erroring Open Dental (firewall, tunnel down) must NOT read as "fully
      // booked forever" — fall through to the clinic calendar instead.
      if (r.status === 200 && Array.isArray(slots)) {
        if (slots.length) return { success: true, date, slots: slots.map(String), source: "opendental", spoken: `Open slots on ${date}: ${slots.join(", ")}.` };
        return { success: true, date, slots: [], source: "opendental", spoken: `Open Dental shows no open slots on ${date} — offer the patient a different day.` };
      }
    }
  } catch {
    /* fall through to local availability */
  }
  // Duration-aware local availability: a time is unavailable for THIS doctor
  // when it would OVERLAP one of their booked appointments (respecting each
  // row's duration_min) — other doctors' bookings don't block it. Clinic
  // hours / slot grid / closed days come from clinic_settings when configured
  // (migration 0061), else the historical 09:00–17:00 / 30-minute defaults.
  const settings = await clinicScheduling(ws);
  const tz = await clinicTimezone(ws);
  if (settings.closedDays.includes(weekdayInTz(date, tz))) {
    return { success: true, date, slots: [], source: "local", spoken: `The clinic is closed on ${date} — offer the patient a different day.` };
  }
  const booked = await bookedSlotsForDay(ws, date);
  const durationMin = clampDuration(args.duration ?? args.duration_min, settings.defaultDurationMin);
  const open = openSlotsForDay(booked, settings, { doctor: args.doctor, durationMin });
  const offer = open.slice(0, 6);
  const spoken = offer.length ? `Open slots on ${date}: ${offer.join(", ")}.` : `Fully booked on ${date}${args.doctor ? ` for ${args.doctor}` : ""} — suggest another day.`;
  return { success: true, date, slots: open, source: "local", spoken };
}

// All booked (non-Broken) appointments for a day, with durations. Older
// deployments may lack the duration_min column — retry without it and let
// apptDuration() fall back.
async function bookedSlotsForDay(ws: string | null, date: string): Promise<BookedSlot[]> {
  const { data, error } = await supabase.from("appointments").select("time, provider, duration_min").eq("workspace_id", ws).eq("date", date).neq("status", "Broken");
  if (!error) return (data ?? []) as BookedSlot[];
  const { data: slim } = await supabase.from("appointments").select("time, provider").eq("workspace_id", ws).eq("date", date).neq("status", "Broken");
  return (slim ?? []) as BookedSlot[];
}

export async function getSlots(ws: string | null, args: any): Promise<string> {
  return (await getSlotsStructured(ws, args)).spoken;
}

// Book an appointment onto the Calendar (always) + Open Dental (if connected),
// recording the fee, the channel/source, and which agent booked it. Stores the
// Open Dental appointment id so reschedule/cancel can target it later.
export async function bookAppointmentStructured(ctx: BookingCtx, args: BookingArgs): Promise<BookingResult> {
  const ws = ctx.ws;
  const dt = String(args.datetime || "");
  const date = dt.slice(0, 10);
  const time = dt.slice(11, 16) || "09:00";
  if (!date) return { success: false, error: "invalid_datetime", spoken: "Could not book — no valid date/time was provided." };

  const treatment = (args.treatment || args.service || "Consultation").trim();
  const fee = toFee(args.fee);
  const settings = await clinicScheduling(ws);
  const durationMin = clampDuration((args as any).duration ?? (args as any).duration_min, settings.defaultDurationMin);

  // Don't double-book THE SAME DOCTOR: two patients at the same time with
  // different doctors is perfectly normal, so only a same-provider OVERLAP
  // (or two unassigned bookings colliding) blocks the slot — duration-aware,
  // so a 60-minute appointment at 10:00 also blocks 10:30.
  const booked = await bookedSlotsForDay(ws, date);
  if (conflictsWithBooked(booked, time, durationMin, args.doctor)) {
    return { success: false, error: "slot_taken", date, time, spoken: `That slot (${date} ${time}) is already taken${args.doctor ? ` for ${args.doctor}` : ""} — offer the patient a different open time.` };
  }

  const patientId = await resolvePatient(ctx, args);

  // Exact-duplicate guard: the SAME patient already holds an appointment at
  // this exact date and time (any doctor) — never book it twice.
  if (patientId) {
    const { data: dup } = await supabase.from("appointments").select("id").eq("workspace_id", ws).eq("patient_id", patientId).eq("date", date).eq("time", time).neq("status", "Broken").limit(1);
    if (dup?.length) {
      return { success: false, error: "duplicate_booking", date, time, spoken: "This patient already has an appointment at that exact time — no duplicate was booked." };
    }
  }

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
    duration_min: durationMin,
    status: "Scheduled",
    confirmed_via: ctx.source,
    fee,
    source: ctx.source,
    booked_by: ctx.bookedBy || "",
  };

  let { data: appt, error: apptErr } = await supabase.from("appointments").insert(baseRow).select("id").single();
  // Newer columns (fee/source/booked_by/duration_min) may not be migrated yet — retry without them.
  if (apptErr && /fee|source|booked_by|duration_min/.test(apptErr.message)) {
    delete baseRow.fee;
    delete baseRow.source;
    delete baseRow.booked_by;
    delete baseRow.duration_min;
    ({ data: appt, error: apptErr } = await supabase.from("appointments").insert(baseRow).select("id").single());
  }
  if (apptErr || !appt) {
    await ctx.log?.(`⚠️ Booking NOT saved to calendar: ${apptErr?.message ?? "insert failed"}.`);
    return { success: false, error: "db_error", spoken: `Could not save the appointment (${apptErr?.message ?? "database error"}). Tell the patient you'll confirm shortly — do not say it is booked.` };
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
        // Fill any missing contact detail from the patient record so the
        // calendar card always carries who to call and how (phone + email),
        // not just the channel it came in on.
        let pPhone = args.phone || ctx.phone || "";
        let pEmail = args.email || "";
        if (patientId && (!pPhone || !pEmail)) {
          const { data: pc } = await supabase.from("patients").select("phone, email").eq("id", patientId).maybeSingle();
          if (pc) { pPhone = pPhone || (pc as any).phone || ""; pEmail = pEmail || (pc as any).email || ""; }
        }
        const patientName = fullName || ctx.name || "Patient";
        const calSummary = `${treatment} — ${patientName}`;
        // Rich description so clinic staff can see and reach the patient at a
        // glance: name, doctor, treatment, phone, email, channel and fee.
        const calDescription = [
          `Patient: ${patientName}`,
          args.doctor ? `Doctor: ${args.doctor}` : "",
          `Treatment: ${treatment}`,
          pPhone ? `Phone: ${pPhone}` : "",
          pEmail ? `Email: ${pEmail}` : "",
          `Booked via ${ctx.source}`,
          fee != null ? `Fee: ${fee}` : "",
        ].filter(Boolean).join("\n");
        const eventId = await pushToGoogleCalendar(ws, { summary: calSummary, description: calDescription, date, time });
        if (eventId && apptId) await supabase.from("appointments").update({ google_calendar_event_id: eventId }).eq("id", apptId);
        // In-app Google OAuth not connected (or push failed) → mirror the event
        // through the Google Calendar connected on the marketing engine instead,
        // remembering its id (hfx: prefix) so reschedules/cancels can follow.
        if (eventId) {
          await ctx.log?.(`📆 Google Calendar: event created (in-app connection).`);
        } else {
          const eng = await pushToEngineCalendar(ws, { summary: calSummary, description: calDescription, date, time });
          if (eng.ok && eng.id && apptId) await supabase.from("appointments").update({ google_calendar_event_id: `hfx:${eng.id}` }).eq("id", apptId);
          if (eng.ok) await ctx.log?.(`📆 Google Calendar: event created via the marketing engine${eng.id ? ` (id ${String(eng.id).slice(0, 24)})` : ""}. If you don't see it, tick that calendar's checkbox in Google Calendar's left sidebar.`);
          else await ctx.log?.(`⚠️ Google Calendar mirror FAILED: ${eng.error ?? "unknown"}. The booking is safe on the Pydent calendar.`);
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
  return {
    success: true,
    appointmentId: apptId,
    patientId,
    date,
    time,
    treatment,
    provider: args.doctor || "",
    fee,
    spoken: `Appointment booked: ${treatment}${args.doctor ? ` with ${args.doctor}` : ""} on ${date} at ${time}${feeNote}.`,
  };
}

export async function bookAppointment(ctx: BookingCtx, args: BookingArgs): Promise<string> {
  return (await bookAppointmentStructured(ctx, args)).spoken;
}

// All of a patient's upcoming (non-Broken) appointments, soonest first. The
// Builder adapter uses this to act only when the target is unambiguous — with
// two or more upcoming appointments it returns the choices instead of guessing.
export async function listUpcomingAppointments(ws: string | null, patientId: string): Promise<UpcomingAppointment[]> {
  const { data } = await supabase
    .from("appointments")
    .select("id, external_id, google_calendar_event_id, patient_id, date, time, procedure, provider, status")
    .eq("workspace_id", ws)
    .eq("patient_id", patientId)
    .gte("date", await clinicToday(ws))
    .neq("status", "Broken")
    .order("date")
    .order("time");
  return (data ?? []) as UpcomingAppointment[];
}

// Fetch ONE appointment by an explicit reference, always scoped to the
// workspace. `id` is the Pydent appointment UUID; `externalId` is the Open
// Dental AptNum stored in appointments.external_id — the two are distinct and
// never interchangeable. Ownership (patient) is checked by the caller.
export async function findAppointmentRef(
  ws: string | null,
  ref: { id?: string; externalId?: string }
): Promise<{ ok: true; appt: UpcomingAppointment } | { ok: false; error: string }> {
  const cols = "id, external_id, google_calendar_event_id, patient_id, date, time, procedure, provider, status";
  try {
    if (ref.id) {
      const { data } = await supabase.from("appointments").select(cols).eq("workspace_id", ws).eq("id", ref.id).maybeSingle();
      if (!data) return { ok: false, error: "appointment_not_found" };
      if ((data as any).status === "Broken") return { ok: false, error: "appointment_cancelled" };
      return { ok: true, appt: data as UpcomingAppointment };
    }
    if (ref.externalId) {
      const { data } = await supabase.from("appointments").select(cols).eq("workspace_id", ws).eq("external_id", ref.externalId).neq("status", "Broken").limit(2);
      if (!data?.length) return { ok: false, error: "appointment_not_found" };
      if (data.length > 1) return { ok: false, error: "ambiguous_reference" };
      return { ok: true, appt: data[0] as UpcomingAppointment };
    }
  } catch {
    // A malformed UUID makes Postgres reject the query — same outcome as no match.
    return { ok: false, error: "appointment_not_found" };
  }
  return { ok: false, error: "appointment_not_found" };
}

// Reschedule EXACTLY the given appointment row (already validated by the
// caller: workspace-scoped fetch + patient ownership). Shared by the legacy
// next-appointment path below and the Builder adapter's exact-id path.
export async function rescheduleApptRow(
  ctx: BookingCtx,
  ap: { id: string; external_id: string | null; google_calendar_event_id?: string | null },
  datetime: string
): Promise<ApptActionResult> {
  const ws = ctx.ws;
  const dt = String(datetime || "");
  const date = dt.slice(0, 10);
  const time = dt.slice(11, 16) || "09:00";
  if (!date) return { success: false, error: "invalid_datetime", spoken: "Need a valid new date and time." };
  const { error } = await supabase.from("appointments").update({ date, time }).eq("id", ap.id);
  if (error) return { success: false, error: "db_error", appointmentId: ap.id, spoken: `Could not reschedule (${error.message}). Tell the patient you'll confirm shortly — do not say it is moved.` };
  void syncCalendarEvent(ws, ap.google_calendar_event_id, { kind: "move", date, time });
  try {
    const od = await getOdConfig(ws);
    if (od?.enabled && ap.external_id) await odForward(ws, "/reschedule-appointment", { method: "POST", body: { appointmentId: ap.external_id, datetime: dt } });
  } catch {
    /* keep the Calendar change */
  }
  await ctx.log?.(`🔁 Rescheduled appointment to ${date} ${time} for ${ctx.name} via ${ctx.source}.`);
  return { success: true, appointmentId: ap.id, externalId: ap.external_id ?? null, date, time, spoken: `Rescheduled to ${date} at ${time}.` };
}

// Cancel EXACTLY the given appointment row (validation is the caller's job,
// as above).
export async function cancelApptRow(
  ctx: BookingCtx,
  ap: { id: string; external_id: string | null; google_calendar_event_id?: string | null }
): Promise<ApptActionResult> {
  const ws = ctx.ws;
  const { error } = await supabase.from("appointments").update({ status: "Broken" }).eq("id", ap.id);
  if (error) return { success: false, error: "db_error", appointmentId: ap.id, spoken: `Could not cancel (${error.message}). Tell the patient you'll confirm shortly — do not say it is cancelled.` };
  void syncCalendarEvent(ws, ap.google_calendar_event_id, { kind: "delete" });
  try {
    const od = await getOdConfig(ws);
    if (od?.enabled && ap.external_id) await odForward(ws, "/cancel-appointment", { method: "POST", body: { appointmentId: ap.external_id } });
  } catch {
    /* keep the Calendar change */
  }
  await ctx.log?.(`❌ Cancelled appointment for ${ctx.name} via ${ctx.source}.`);
  return { success: true, appointmentId: ap.id, externalId: ap.external_id ?? null, spoken: "Your appointment has been cancelled." };
}

// Reschedule the patient's next appointment.
export async function rescheduleAppt(ctx: BookingCtx, args: any): Promise<string> {
  const ws = ctx.ws;
  const patientId = ctx.patientId ?? (await resolvePatient(ctx, args));
  if (!patientId) return "No patient on file to reschedule.";
  const dt = String(args?.datetime || "");
  if (!dt.slice(0, 10)) return "Need a valid new date and time.";
  const { data: ap } = await supabase.from("appointments").select("id, external_id, google_calendar_event_id").eq("workspace_id", ws).eq("patient_id", patientId).gte("date", await clinicToday(ws)).neq("status", "Broken").order("date").order("time").limit(1).maybeSingle();
  if (!ap) return "No upcoming appointment found to reschedule.";
  return (await rescheduleApptRow(ctx, ap, dt)).spoken;
}

// Cancel the patient's next appointment.
export async function cancelAppt(ctx: BookingCtx, args?: any): Promise<string> {
  const ws = ctx.ws;
  const patientId = ctx.patientId ?? (await resolvePatient(ctx, args ?? {}));
  if (!patientId) return "No patient on file.";
  const { data: ap } = await supabase.from("appointments").select("id, external_id, google_calendar_event_id").eq("workspace_id", ws).eq("patient_id", patientId).gte("date", await clinicToday(ws)).neq("status", "Broken").order("date").order("time").limit(1).maybeSingle();
  if (!ap) return "No upcoming appointment found to cancel.";
  return (await cancelApptRow(ctx, ap)).spoken;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
