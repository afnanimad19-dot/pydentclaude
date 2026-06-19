// Thin Open Dental REST API client. Runs ONLY on the clinic server.
// Auth header format: "Authorization: ODFHIR {DeveloperKey}/{CustomerKey}".
const BASE = process.env.OPEN_DENTAL_BASE_URL || "http://localhost:30222/api/v1";
const AUTH = `ODFHIR ${process.env.OPEN_DENTAL_DEVELOPER_KEY}/${process.env.OPEN_DENTAL_CUSTOMER_KEY}`;

async function od(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: AUTH, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data?.error || `Open Dental ${res.status}`);
  return data;
}

// Open Dental "GET Slots" returns open schedule times for a provider/operatory.
// Endpoint + params can vary by version — adjust to your install.
export async function getSlots({ providerNum, operatoryNum, date, durationMin }) {
  const params = new URLSearchParams({
    ProvNum: String(providerNum),
    OpNum: String(operatoryNum),
    dateStart: date,
    dateEnd: date,
    lengthMinutes: String(durationMin || 30),
  });
  const slots = await od(`/appointments/Slots?${params.toString()}`);
  // Normalise to ["HH:MM", ...]
  return (slots || []).map((s) => (s.DateTimeStart || "").slice(11, 16)).filter(Boolean);
}

// Creates the appointment. Open Dental requires a PatNum; create/find the patient
// here from name+phone (kept local), then POST the appointment.
export async function createAppointment({ patNum, providerNum, operatoryNum, datetime, procedureCode }) {
  return od(`/appointments`, {
    method: "POST",
    body: JSON.stringify({
      PatNum: patNum,
      ProvNum: providerNum,
      Op: operatoryNum,
      AptDateTime: datetime,
      ProcDescript: procedureCode,
      AptStatus: "Scheduled",
    }),
  });
}

export async function rescheduleAppointment({ aptNum, datetime }) {
  return od(`/appointments/${aptNum}`, { method: "PUT", body: JSON.stringify({ AptDateTime: datetime }) });
}

export async function cancelAppointment({ aptNum }) {
  return od(`/appointments/${aptNum}`, { method: "PUT", body: JSON.stringify({ AptStatus: "Broken" }) });
}
