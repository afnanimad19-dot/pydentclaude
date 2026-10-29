// Open Dental REST API client (LIVE mode). Runs ONLY on the clinic server.
//
// Verified against the official API documentation (opendental.com/site/api*,
// current for the 25.4 line — see docs/smart-scheduling/opendental-connector-audit.md):
//  * Auth header:   Authorization: ODFHIR {DeveloperKey}/{CustomerKey}
//  * Local API:     http://localhost:30222/api/v1 (runs inside opendental.exe);
//    Service API:   port 30223; Remote: https://api.opendental.com/api/v1
//  * GET /appointments/Slots?dateStart&dateEnd&ProvNum&OpNum&lengthMinutes
//    → [{ DateTimeStart: "yyyy-MM-dd HH:mm:ss", DateTimeEnd, ProvNum, OpNum }]
//    (dates must be today or later)
//  * GET /patients?Phone=…  /  POST /patients { LName, FName, WirelessPhone, Email }
//  * POST /appointments { PatNum, Op, AptDateTime } (+ ProvNum, Note)
//  * PUT /appointments/{AptNum} { AptDateTime: "yyyy-MM-dd HH:mm:ss" }
//  * PUT /appointments/{AptNum}/Break { sendToUnscheduledList: "true" }  (cancel)
//
// Failure policy: every upstream problem throws an OdError whose message is a
// fixed machine code — upstream response text, keys, and patient details are
// never attached, so nothing sensitive can reach a client-facing error. There
// is NO fallback to mock data here under any circumstance.

export class OdError extends Error {
  constructor(code, status) {
    super(code); // the code IS the message — nothing upstream leaks through
    this.code = code;
    this.status = status;
  }
}

// "2026-07-21T14:00[:ss]" → "2026-07-21 14:00:00" (Open Dental's datetime format).
export function odDateTime(dt) {
  const d = String(dt).slice(0, 10);
  const t = String(dt).slice(11, 16);
  return `${d} ${t}:00`;
}

export function createClient(config) {
  const auth = `ODFHIR ${config.developerKey}/${config.customerKey}`;

  async function od(path, init = {}) {
    let res;
    try {
      res = await fetch(`${config.baseUrl}${path}`, {
        ...init,
        headers: { Authorization: auth, "Content-Type": "application/json", ...(init.headers || {}) },
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (e) {
      if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new OdError("od_timeout");
      throw new OdError("od_unreachable");
    }
    if (res.status === 401 || res.status === 403) throw new OdError("od_auth_failed", res.status);
    const text = await res.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new OdError("od_bad_response", res.status);
      }
    }
    if (!res.ok) throw new OdError("od_http_error", res.status);
    return data;
  }

  // Open schedule times for a provider/operatory on one date → ["HH:MM", ...].
  async function getSlots({ providerNum, operatoryNum, date, durationMin }) {
    const params = new URLSearchParams({
      ProvNum: String(providerNum),
      OpNum: String(operatoryNum),
      dateStart: date,
      dateEnd: date,
      lengthMinutes: String(durationMin || 30),
    });
    const slots = await od(`/appointments/Slots?${params.toString()}`);
    if (!Array.isArray(slots)) throw new OdError("od_bad_response");
    // DateTimeStart is "yyyy-MM-dd HH:mm:ss" — chars 11–16 are "HH:MM".
    return slots.map((s) => String(s?.DateTimeStart ?? "").slice(11, 16)).filter((t) => /^\d{2}:\d{2}$/.test(t));
  }

  // Find a patient by phone; create a minimal record (no clinical data) if new.
  async function findOrCreatePatient({ name, phone, email }) {
    const parts = String(name || "").trim().split(/\s+/);
    const fName = parts[0] || "Patient";
    const lName = parts.slice(1).join(" ") || fName;
    if (phone) {
      try {
        const found = await od(`/patients?Phone=${encodeURIComponent(phone)}`);
        const hit = Array.isArray(found) ? found[0] : null;
        if (hit?.PatNum) return hit.PatNum;
      } catch (e) {
        // An auth problem is terminal; only a plain lookup miss falls through
        // to create (never to mock data).
        if (e?.code === "od_auth_failed" || e?.code === "od_timeout" || e?.code === "od_unreachable") throw e;
      }
    }
    const created = await od(`/patients`, {
      method: "POST",
      body: JSON.stringify({ LName: lName, FName: fName, WirelessPhone: phone || "", Email: email || "" }),
    });
    const patNum = Number(created?.PatNum);
    if (!patNum) throw new OdError("od_bad_response");
    return patNum;
  }

  // POST /appointments — documented required fields: PatNum, Op, AptDateTime.
  // The service travels in Note (ProcDescript is not in the documented schema).
  async function createAppointment({ patNum, providerNum, operatoryNum, datetime, serviceName }) {
    return od(`/appointments`, {
      method: "POST",
      body: JSON.stringify({
        PatNum: patNum,
        ProvNum: providerNum,
        Op: operatoryNum,
        AptDateTime: odDateTime(datetime),
        Note: `Booked via Pydent${serviceName ? ` — ${serviceName}` : ""}`,
      }),
    });
  }

  async function rescheduleAppointment({ aptNum, datetime }) {
    return od(`/appointments/${encodeURIComponent(String(aptNum))}`, {
      method: "PUT",
      body: JSON.stringify({ AptDateTime: odDateTime(datetime) }),
    });
  }

  // Documented cancel flow: Break the appointment onto the Unscheduled List.
  async function cancelAppointment({ aptNum }) {
    return od(`/appointments/${encodeURIComponent(String(aptNum))}/Break`, {
      method: "PUT",
      body: JSON.stringify({ sendToUnscheduledList: "true" }),
    });
  }

  return { getSlots, findOrCreatePatient, createAppointment, rescheduleAppointment, cancelAppointment };
}
