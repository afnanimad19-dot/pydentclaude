import express from "express";
import { DOCTORS, SERVICES } from "./mappings.js";

// Pick the data layer: MOCK (in-memory, for safe end-to-end testing) when
// OPEN_DENTAL_MOCK=1 or when the real Open Dental keys aren't set; otherwise the
// real local Open Dental REST client. This is what lets the whole chain be tested
// before a clinic's live Open Dental is wired up.
const MOCK = process.env.OPEN_DENTAL_MOCK === "1" || !process.env.OPEN_DENTAL_DEVELOPER_KEY;
const od = await import(MOCK ? "./mock.js" : "./opendental.js");

const app = express();
app.use(express.json());

// Health check — no auth, so the clinic IT / tunnel can verify it's up.
app.get("/health", (_req, res) => res.json({ ok: true, mode: MOCK ? "mock" : "live", service: "pydent-connector" }));

// Every other request must carry the shared secret.
app.use((req, res, next) => {
  if (req.headers["x-api-key"] !== process.env.CLINIC_API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
});

app.get("/doctors", (_req, res) => {
  res.json({ doctors: DOCTORS.map((d) => ({ id: d.id, name: d.name, services: d.services })) });
});

app.get("/services", (_req, res) => {
  res.json({ services: Object.entries(SERVICES).map(([id, s]) => ({ id, name: s.name, durationMin: s.durationMin })) });
});

app.post("/available-slots", async (req, res) => {
  try {
    const { doctorId, serviceId, date } = req.body;
    const doc = DOCTORS.find((d) => d.id === String(doctorId)) || DOCTORS[0];
    const svc = SERVICES[serviceId] || Object.values(SERVICES)[0];
    if (!doc || !svc) return res.status(400).json({ error: "Unknown doctor or service" });
    const slots = await od.getSlots({ providerNum: doc.providerNum, operatoryNum: doc.operatoryNum, date, durationMin: svc.durationMin });
    res.json({ slots });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.post("/create-appointment", async (req, res) => {
  try {
    const { name, phone, email, doctorId, serviceId, datetime } = req.body;
    const doc = DOCTORS.find((d) => d.id === String(doctorId)) || DOCTORS[0];
    const svc = SERVICES[serviceId] || Object.values(SERVICES)[0];
    if (!doc || !svc) return res.status(400).json({ error: "Unknown doctor or service" });
    // Find-or-create the patient LOCALLY (name + phone only — no clinical data) to get a PatNum.
    const patNum = req.body.patNum || (await od.findOrCreatePatient({ name, phone, email }));
    const appt = await od.createAppointment({ patNum, providerNum: doc.providerNum, operatoryNum: doc.operatoryNum, datetime, procedureCode: svc.procedureCode });
    res.json({ ok: true, appointmentId: appt.AptNum ?? appt.id ?? null, patNum });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.post("/reschedule-appointment", async (req, res) => {
  try {
    await od.rescheduleAppointment({ aptNum: req.body.appointmentId, datetime: req.body.datetime });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.post("/cancel-appointment", async (req, res) => {
  try {
    await od.cancelAppointment({ aptNum: req.body.appointmentId });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Pydent Connector listening on http://localhost:${port} (${MOCK ? "MOCK" : "LIVE"} mode)`));
