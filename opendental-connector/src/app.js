// HTTP surface of the connector — pure app factory so tests can boot it with an
// injected data layer (mock or a stubbed Open Dental client) and a fixed config.
//
// Security properties enforced here:
//  * Shared-secret auth (x-api-key) with a timing-safe comparison; 401 on
//    missing/incorrect keys. The key value never appears in logs or responses.
//  * Read-only mode (default ON) rejects create/reschedule/cancel with 403
//    BEFORE any Open Dental call.
//  * Strict validation: unknown doctor/service ids are 400 errors — the first
//    doctor/service is NEVER silently selected. Dates, datetimes, durations and
//    required booking fields are validated before anything is forwarded.
//  * Upstream failures map to fixed machine codes + safe messages: no upstream
//    response text, no credentials, no patient data in any error. There is no
//    fallback to mock data after an API failure.

import express from "express";
import { timingSafeEqual, createHash } from "node:crypto";
import { DOCTORS, SERVICES } from "./mappings.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

// Constant-time string comparison (hash both sides so lengths match).
export function safeEqual(a, b) {
  const h = (v) => createHash("sha256").update(String(v ?? "")).digest();
  return timingSafeEqual(h(a), h(b));
}

const isValidDate = (d) => DATE_RE.test(String(d ?? "")) && Number.isFinite(Date.parse(`${d}T00:00:00Z`));
const isValidDatetime = (d) => DATETIME_RE.test(String(d ?? "")) && Number.isFinite(Date.parse(`${String(d).slice(0, 16)}:00Z`));

// Fixed, safe client responses for data-layer failures. Anything not in this
// table (including unexpected exceptions) collapses to the generic entry, so
// upstream text, stack traces, keys, and patient details can never leak.
const UPSTREAM_ERRORS = {
  od_timeout: { status: 504, body: { error: "upstream_timeout", message: "Open Dental did not answer in time. Try again." } },
  od_auth_failed: { status: 502, body: { error: "od_auth_failed", message: "Open Dental rejected the connector's API credentials. Check the configured keys on the clinic server." } },
  od_unreachable: { status: 502, body: { error: "od_unreachable", message: "Could not reach Open Dental. Is the API service running?" } },
  od_bad_response: { status: 502, body: { error: "od_bad_response", message: "Open Dental returned an unexpected response." } },
  od_http_error: { status: 502, body: { error: "od_error", message: "Open Dental could not process the request." } },
};

function upstreamFailure(res, e) {
  const mapped = UPSTREAM_ERRORS[e?.code] ?? { status: 502, body: { error: "upstream_failed", message: "The request could not be completed." } };
  return res.status(mapped.status).json(mapped.body);
}

export function createApp({ od, config, doctors = DOCTORS, services = SERVICES }) {
  const app = express();
  app.use(express.json({ limit: "64kb" }));

  // Health check — no auth so clinic IT / the tunnel can verify it's up.
  // Mode + read-only state only: never configuration values or patient data.
  app.get("/health", (_req, res) =>
    res.json({ ok: true, mode: config.mock ? "mock" : "live", readOnly: config.readOnly, service: "pydent-connector" })
  );

  // Every other request must carry the shared secret (timing-safe check).
  app.use((req, res, next) => {
    const presented = req.headers["x-api-key"];
    if (typeof presented !== "string" || !presented || !safeEqual(presented, config.clinicApiKey)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    next();
  });

  app.get("/doctors", (_req, res) => {
    res.json({ doctors: doctors.map((d) => ({ id: d.id, name: d.name, services: d.services })) });
  });

  app.get("/services", (_req, res) => {
    res.json({ services: Object.entries(services).map(([id, s]) => ({ id, name: s.name, durationMin: s.durationMin })) });
  });

  // Strict lookups: exact id match or a 400 — never a silent default.
  function requireDoctor(res, doctorId) {
    const doc = doctors.find((d) => d.id === String(doctorId ?? ""));
    if (!doc) {
      res.status(400).json({ error: "unknown_doctor", message: "Unknown doctor id. Use an id from GET /doctors." });
      return null;
    }
    return doc;
  }

  function requireService(res, doc, serviceId) {
    const id = String(serviceId ?? "");
    const svc = Object.prototype.hasOwnProperty.call(services, id) ? services[id] : null;
    if (!svc) {
      res.status(400).json({ error: "unknown_service", message: "Unknown service id. Use an id from GET /services." });
      return null;
    }
    if (!doc.services.includes(id)) {
      res.status(400).json({ error: "service_not_offered", message: "This doctor does not offer that service." });
      return null;
    }
    return svc;
  }

  // Appointment duration: the service's configured length, or a sane explicit
  // override — anything else is rejected rather than guessed.
  function requireDuration(res, svc, durationMin) {
    if (durationMin === undefined || durationMin === null || durationMin === "") return svc.durationMin;
    const n = Number(durationMin);
    if (!Number.isInteger(n) || n < 5 || n > 240) {
      res.status(400).json({ error: "invalid_duration", message: "durationMin must be a whole number of minutes between 5 and 240." });
      return null;
    }
    return n;
  }

  app.post("/available-slots", async (req, res) => {
    const { doctorId, serviceId, date, durationMin } = req.body ?? {};
    const doc = requireDoctor(res, doctorId);
    if (!doc) return;
    const svc = requireService(res, doc, serviceId);
    if (!svc) return;
    if (!isValidDate(date)) return res.status(400).json({ error: "invalid_date", message: "date must be YYYY-MM-DD." });
    const duration = requireDuration(res, svc, durationMin);
    if (duration === null) return;
    try {
      const slots = await od.getSlots({ providerNum: doc.providerNum, operatoryNum: doc.operatoryNum, date, durationMin: duration });
      res.json({ slots });
    } catch (e) {
      // A failed availability read is an ERROR — never an empty/mock calendar.
      upstreamFailure(res, e);
    }
  });

  // Write endpoints — rejected up front in read-only mode (the default).
  const rejectWhenReadOnly = (req, res, next) => {
    if (config.readOnly) {
      return res.status(403).json({
        error: "read_only_mode",
        message: "This connector is running in read-only mode: appointments cannot be created, rescheduled, or cancelled.",
      });
    }
    next();
  };
  app.post("/create-appointment", rejectWhenReadOnly, async (req, res) => {
    const { name, phone, email, doctorId, serviceId, datetime, patNum } = req.body ?? {};
    const doc = requireDoctor(res, doctorId);
    if (!doc) return;
    const svc = requireService(res, doc, serviceId);
    if (!svc) return;
    if (!isValidDatetime(datetime)) return res.status(400).json({ error: "invalid_datetime", message: "datetime must be YYYY-MM-DDTHH:MM." });
    if (patNum !== undefined && (!Number.isInteger(Number(patNum)) || Number(patNum) <= 0)) {
      return res.status(400).json({ error: "invalid_patnum", message: "patNum must be a positive integer when provided." });
    }
    if (patNum === undefined) {
      if (String(name ?? "").trim().length < 2) return res.status(400).json({ error: "missing_name", message: "name is required to book (or pass an existing patNum)." });
      if (String(phone ?? "").replace(/\D/g, "").length < 7) return res.status(400).json({ error: "missing_phone", message: "phone is required to book (or pass an existing patNum)." });
    }
    try {
      const resolvedPatNum = patNum !== undefined ? Number(patNum) : await od.findOrCreatePatient({ name, phone, email });
      const appt = await od.createAppointment({
        patNum: resolvedPatNum,
        providerNum: doc.providerNum,
        operatoryNum: doc.operatoryNum,
        datetime,
        serviceName: svc.name,
        procedureCode: svc.procedureCode,
      });
      res.json({ ok: true, appointmentId: appt.AptNum ?? appt.id ?? null, patNum: resolvedPatNum });
    } catch (e) {
      upstreamFailure(res, e);
    }
  });

  app.post("/reschedule-appointment", rejectWhenReadOnly, async (req, res) => {
    const { appointmentId, datetime } = req.body ?? {};
    if (!Number.isInteger(Number(appointmentId)) || Number(appointmentId) <= 0) {
      return res.status(400).json({ error: "invalid_appointment_id", message: "appointmentId must be a positive integer." });
    }
    if (!isValidDatetime(datetime)) return res.status(400).json({ error: "invalid_datetime", message: "datetime must be YYYY-MM-DDTHH:MM." });
    try {
      await od.rescheduleAppointment({ aptNum: Number(appointmentId), datetime });
      res.json({ ok: true });
    } catch (e) {
      upstreamFailure(res, e);
    }
  });

  app.post("/cancel-appointment", rejectWhenReadOnly, async (req, res) => {
    const { appointmentId } = req.body ?? {};
    if (!Number.isInteger(Number(appointmentId)) || Number(appointmentId) <= 0) {
      return res.status(400).json({ error: "invalid_appointment_id", message: "appointmentId must be a positive integer." });
    }
    try {
      await od.cancelAppointment({ aptNum: Number(appointmentId) });
      res.json({ ok: true });
    } catch (e) {
      upstreamFailure(res, e);
    }
  });

  // JSON parse failures and anything unexpected: fixed safe messages only.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
      return res.status(400).json({ error: "invalid_json", message: "Request body must be valid JSON." });
    }
    res.status(500).json({ error: "internal_error", message: "The request could not be processed." });
  });

  return app;
}
