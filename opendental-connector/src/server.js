import express from "express";
import { DOCTORS, SERVICES } from "./mappings.js";
import { getSlots, createAppointment, rescheduleAppointment, cancelAppointment } from "./opendental.js";

const app = express();
app.use(express.json());

// Every request must carry the shared secret.
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
    const doc = DOCTORS.find((d) => d.id === doctorId);
    const svc = SERVICES[serviceId];
    if (!doc || !svc) return res.status(400).json({ error: "Unknown doctor or service" });
    const slots = await getSlots({ providerNum: doc.providerNum, operatoryNum: doc.operatoryNum, date, durationMin: svc.durationMin });
    res.json({ slots });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.post("/create-appointment", async (req, res) => {
  try {
    const { name, phone, doctorId, serviceId, datetime } = req.body;
    const doc = DOCTORS.find((d) => d.id === doctorId);
    const svc = SERVICES[serviceId];
    if (!doc || !svc) return res.status(400).json({ error: "Unknown doctor or service" });
    // TODO: find-or-create the patient in Open Dental from name+phone to get PatNum.
    const patNum = req.body.patNum || 0;
    const appt = await createAppointment({ patNum, providerNum: doc.providerNum, operatoryNum: doc.operatoryNum, datetime, procedureCode: svc.procedureCode });
    res.json({ ok: true, appointmentId: appt.AptNum ?? appt.id ?? null });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.post("/reschedule-appointment", async (req, res) => {
  try {
    await rescheduleAppointment({ aptNum: req.body.appointmentId, datetime: req.body.datetime });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.post("/cancel-appointment", async (req, res) => {
  try {
    await cancelAppointment({ aptNum: req.body.appointmentId });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Pydental Connector listening on http://localhost:${port}`));
