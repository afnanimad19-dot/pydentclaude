// Self-test: boots the connector in MOCK mode and exercises every endpoint, so
// you can verify the booking chain works with ONE command and zero setup:
//     npm run smoke
// (No Open Dental, no clinic API keys, no tunnel needed.)

process.env.OPEN_DENTAL_MOCK = "1";
process.env.CLINIC_API_KEY = process.env.CLINIC_API_KEY || "smoke-key";
process.env.PORT = process.env.PORT || "4123";

const base = `http://localhost:${process.env.PORT}`;
const key = process.env.CLINIC_API_KEY;
const h = { "Content-Type": "application/json", "x-api-key": key };

function assert(cond, msg) {
  if (!cond) { console.error("  ✗ FAIL:", msg); process.exit(1); }
  console.log("  ✓", msg);
}

await import("./server.js");
await new Promise((r) => setTimeout(r, 500));

console.log("\nPydent Connector — smoke test (mock mode)\n");

// Health (no auth)
const health = await (await fetch(`${base}/health`)).json();
assert(health.ok && health.mode === "mock", "health responds in mock mode");

// Auth is enforced
assert((await fetch(`${base}/doctors`)).status === 401, "requests without the API key are rejected (401)");

// Doctors + services
const docs = await (await fetch(`${base}/doctors`, { headers: h })).json();
assert(Array.isArray(docs.doctors) && docs.doctors.length > 0, `doctors listed (${docs.doctors?.length})`);
const doctorId = docs.doctors[0].id;

const date = "2026-07-01";
// Slots
const slots = await (await fetch(`${base}/available-slots`, { method: "POST", headers: h, body: JSON.stringify({ doctorId, serviceId: "cleaning", date }) })).json();
assert(Array.isArray(slots.slots) && slots.slots.length > 0, `open slots returned (${slots.slots?.length})`);
const time = slots.slots[0];

// Book
const book = await (await fetch(`${base}/create-appointment`, { method: "POST", headers: h, body: JSON.stringify({ name: "Test Patient", phone: "+971500000000", email: "t@example.com", doctorId, serviceId: "cleaning", datetime: `${date}T${time}:00` }) })).json();
assert(book.ok && book.appointmentId, `appointment booked (AptNum ${book.appointmentId}, PatNum ${book.patNum})`);

// The booked slot should no longer be offered
const slots2 = await (await fetch(`${base}/available-slots`, { method: "POST", headers: h, body: JSON.stringify({ doctorId, serviceId: "cleaning", date }) })).json();
assert(!slots2.slots.includes(time), "the booked time is no longer offered as open");

// Reschedule + cancel
assert((await (await fetch(`${base}/reschedule-appointment`, { method: "POST", headers: h, body: JSON.stringify({ appointmentId: book.appointmentId, datetime: `${date}T17:00:00` }) })).json()).ok, "appointment rescheduled");
assert((await (await fetch(`${base}/cancel-appointment`, { method: "POST", headers: h, body: JSON.stringify({ appointmentId: book.appointmentId }) })).json()).ok, "appointment cancelled");

console.log("\nSMOKE PASSED ✅  — the full slots → book → reschedule → cancel chain works.\n");
process.exit(0);
