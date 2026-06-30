// In-memory MOCK of Open Dental — lets you test the WHOLE chain
// (Pydent dashboard → tunnel → connector → here) with NO real Open Dental install
// and NO clinic API keys. Enable with OPEN_DENTAL_MOCK=1 (or just leave the real
// keys unset and the connector falls back to this automatically).
//
// Nothing here is persisted — it resets when the process restarts. It exists only
// so booking can be verified end-to-end safely before touching a live clinic.

let seq = 5000;
const patients = []; // { patNum, name, phone, email }
const appts = [];    // { aptNum, patNum, providerNum, operatoryNum, datetime, procedureCode, status }

const BASE_SLOTS = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30"];

// Open schedule times for a date, minus anything already booked in that operatory.
export async function getSlots({ operatoryNum, date }) {
  const taken = appts
    .filter((a) => (a.datetime || "").startsWith(date) && a.status !== "Broken" && String(a.operatoryNum) === String(operatoryNum))
    .map((a) => a.datetime.slice(11, 16));
  return BASE_SLOTS.filter((t) => !taken.includes(t));
}

// Find a patient by phone (then email); create one if new. Returns the PatNum.
export async function findOrCreatePatient({ name, phone, email }) {
  let p = (phone && patients.find((x) => x.phone === phone)) || (email && patients.find((x) => x.email === email));
  if (!p) {
    p = { patNum: ++seq, name: name || "Patient", phone: phone || "", email: email || "" };
    patients.push(p);
  }
  return p.patNum;
}

export async function createAppointment({ patNum, providerNum, operatoryNum, datetime, procedureCode }) {
  const a = { aptNum: ++seq, patNum, providerNum, operatoryNum, datetime, procedureCode, status: "Scheduled" };
  appts.push(a);
  return { AptNum: a.aptNum };
}

export async function rescheduleAppointment({ aptNum, datetime }) {
  const a = appts.find((x) => String(x.aptNum) === String(aptNum));
  if (a) a.datetime = datetime;
  return { ok: true };
}

export async function cancelAppointment({ aptNum }) {
  const a = appts.find((x) => String(x.aptNum) === String(aptNum));
  if (a) a.status = "Broken";
  return { ok: true };
}

// Test/visibility helper (not exposed to Pydent) — current in-memory state.
export function _state() {
  return { patients: patients.length, appointments: appts.length };
}
