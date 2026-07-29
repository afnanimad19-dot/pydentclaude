"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarDays, CheckCircle2, AlertTriangle } from "lucide-react";
import { Modal, Field, ModalFooter, inputCls } from "@/components/modal";
import {
  createPatient,
  createAppointment,
  fetchAppointments,
  getWorkspaceId,
} from "@/lib/db";

function ResultNote({ ok, text }: { ok: boolean; text: string }) {
  return ok ? (
    <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600">
      <CheckCircle2 className="h-4 w-4 shrink-0" /> {text}
    </div>
  ) : (
    <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-600">
      <AlertTriangle className="h-4 w-4 shrink-0" /> {text}
    </div>
  );
}

export function NewPatientModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    phone: "",
    email: "",
    birthdate: "",
    status: "New",
    insurance: "",
    preferredChannel: "WhatsApp",
  });

  function set<K extends keyof typeof form>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function close() {
    setResult(null);
    setForm({ firstName: "", lastName: "", phone: "", email: "", birthdate: "", status: "New", insurance: "", preferredChannel: "WhatsApp" });
    onClose();
  }

  async function submit() {
    if (!form.firstName.trim() && !form.lastName.trim()) {
      setResult({ ok: false, message: "Please enter the patient's name." });
      return;
    }
    setSaving(true);
    const res = await createPatient({
      name: `${form.firstName.trim()} ${form.lastName.trim()}`.trim(),
      phone: form.phone,
      email: form.email,
      birthdate: form.birthdate,
      insurance: form.insurance,
      status: form.status,
      preferredChannel: form.preferredChannel,
    });
    setSaving(false);
    setResult(res);
    if (res.ok) onCreated?.();
  }

  return (
    <Modal open={open} onClose={close} title="New patient" subtitle="Saved straight to your clinic database." wide>
      {result?.ok ? (
        <ResultNote ok text={result.message} />
      ) : (
        <>
          {result && <div className="mb-4"><ResultNote ok={false} text={result.message} /></div>}
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="First name">
              <input className={inputCls} placeholder="Maria" value={form.firstName} onChange={(e) => set("firstName", e.target.value)} />
            </Field>
            <Field label="Last name">
              <input className={inputCls} placeholder="Hernandez" value={form.lastName} onChange={(e) => set("lastName", e.target.value)} />
            </Field>
            <Field label="Phone">
              <input className={inputCls} placeholder="+1 (305) 555-0100" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
            </Field>
            <Field label="Email">
              <input className={inputCls} placeholder="patient@email.com" value={form.email} onChange={(e) => set("email", e.target.value)} />
            </Field>
            <Field label="Date of birth">
              <input type="date" className={inputCls} value={form.birthdate} onChange={(e) => set("birthdate", e.target.value)} />
            </Field>
            <Field label="Status">
              <select className={inputCls} value={form.status} onChange={(e) => set("status", e.target.value)}>
                <option>New</option>
                <option>Active</option>
                <option>Inactive</option>
              </select>
            </Field>
            <Field label="Insurance carrier">
              <input className={inputCls} placeholder="Delta Dental, Cigna, Self-pay…" value={form.insurance} onChange={(e) => set("insurance", e.target.value)} />
            </Field>
            <Field label="Preferred channel">
              <select className={inputCls} value={form.preferredChannel} onChange={(e) => set("preferredChannel", e.target.value)}>
                <option>WhatsApp</option>
                <option>SMS</option>
                <option>Email</option>
                <option>Phone call</option>
              </select>
            </Field>
          </div>
          <ModalFooter onClose={close} submitLabel={saving ? "Saving…" : "Create patient"} onSubmit={submit} />
        </>
      )}
    </Modal>
  );
}

// The next 6 real days starting today, as { label: "Mon 28", date: "2026-07-28" }.
function upcomingDays(): { label: string; date: string }[] {
  const out: { label: string; date: string }[] = [];
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let i = 0; i < 6; i++) {
    const d = new Date(Date.now() + i * 86400000);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    out.push({ label: `${names[d.getDay()]} ${d.getDate()}`, date: iso });
  }
  return out;
}

// Clinic hours 09:00–17:00 in half-hour slots — the same grid the AI agents'
// get_available_slots uses, so both sides of the app agree on availability.
const DAY_TIMES: string[] = (() => {
  const t: string[] = [];
  for (let h = 9; h < 17; h++) for (const m of ["00", "30"]) t.push(`${String(h).padStart(2, "0")}:${m}`);
  return t;
})();

export function NewAppointmentModal({
  open,
  onClose,
  patientId,
  patientName,
  patientOptions,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  patientId?: string;
  patientName?: string;
  patientOptions?: { id: string; name: string }[];
  onCreated?: () => void;
}) {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [slot, setSlot] = useState<{ date: string; time: string; label: string } | null>(null);
  const [selectedPatient, setSelectedPatient] = useState(patientId ?? "");
  const [provider, setProvider] = useState("Dr. Patel");
  const [operatory, setOperatory] = useState("Op 1");
  const [procedure, setProcedure] = useState("");
  const [mirrorGcal, setMirrorGcal] = useState(true);
  // REAL availability: which date+time slots are already booked.
  const [taken, setTaken] = useState<Set<string>>(new Set());
  const days = useMemo(() => upcomingDays(), []);

  useEffect(() => {
    if (!open) return;
    fetchAppointments().then(({ appointments }) => {
      const t = new Set<string>();
      for (const a of appointments) {
        if (a.status === "Broken") continue;
        t.add(`${a.date} ${String(a.time ?? "").slice(0, 5)}`);
      }
      setTaken(t);
    });
  }, [open]);

  function close() {
    setResult(null);
    setSlot(null);
    onClose();
  }

  async function submit() {
    const pid = patientId ?? selectedPatient;
    if (!pid) {
      setResult({ ok: false, message: "Please choose a patient." });
      return;
    }
    if (!slot) {
      setResult({ ok: false, message: "Please pick a time slot." });
      return;
    }
    setSaving(true);
    const res = await createAppointment({
      patientId: pid,
      provider,
      operatory,
      procedure,
      date: slot.date,
      time: slot.time,
    });
    if (res.ok && mirrorGcal) {
      // Mirror to the clinic's Google Calendar (in-app OAuth or the engine's
      // connected calendar) — same push agent bookings get. Best-effort.
      try {
        const ws = await getWorkspaceId();
        const pName = patientName ?? patientOptions?.find((p) => p.id === pid)?.name ?? "Patient";
        void fetch("/api/calendar/gcal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ws, summary: `${procedure || "Appointment"} — ${pName}`, description: `Provider: ${provider} · ${operatory} · booked manually`, date: slot.date, time: slot.time }),
        });
      } catch { /* calendar mirror is optional */ }
    }
    setSaving(false);
    setResult(res);
    if (res.ok) onCreated?.();
  }

  return (
    <Modal open={open} onClose={close} title="New appointment" subtitle="Saved to your schedule — mirrors to Google Calendar when connected." wide>
      {result?.ok ? (
        <ResultNote ok text={`${result.message} (${slot?.label ?? ""})`} />
      ) : (
        <>
          {result && <div className="mb-4"><ResultNote ok={false} text={result.message} /></div>}
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Patient">
              {patientId ? (
                <input className={inputCls} value={patientName} readOnly />
              ) : patientOptions?.length ? (
                <select className={inputCls} value={selectedPatient} onChange={(e) => setSelectedPatient(e.target.value)}>
                  <option value="">Choose patient…</option>
                  {patientOptions.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              ) : (
                <input className={inputCls} placeholder="Search patient…" />
              )}
            </Field>
            <Field label="Provider">
              <select className={inputCls} value={provider} onChange={(e) => setProvider(e.target.value)}>
                <option>Dr. Patel</option>
                <option>Dr. Gomez</option>
                <option>Hygiene — Kelly</option>
              </select>
            </Field>
            <Field label="Procedure">
              <input className={inputCls} placeholder="Prophylaxis + exam" value={procedure} onChange={(e) => setProcedure(e.target.value)} />
            </Field>
            <Field label="Operatory">
              <select className={inputCls} value={operatory} onChange={(e) => setOperatory(e.target.value)}>
                <option>Op 1</option>
                <option>Op 2</option>
                <option>Op 3</option>
                <option>Op 4</option>
              </select>
            </Field>
          </div>
          <p className="mb-2 mt-5 flex items-center gap-1.5 text-sm font-medium text-ink-700">
            <CalendarDays className="h-4 w-4 text-brand-500" /> Pick a slot — live availability, next 6 days (booked times are crossed out)
          </p>
          <div className="grid max-h-72 grid-cols-6 gap-2 overflow-y-auto pr-1">
            {days.map((d) => (
              <div key={d.date} className="space-y-1.5">
                <p className="text-center text-xs font-semibold text-ink-500">{d.label}</p>
                {DAY_TIMES.map((t) => {
                  const isTaken = taken.has(`${d.date} ${t}`);
                  const active = slot?.date === d.date && slot?.time === t;
                  return (
                    <button
                      key={t}
                      disabled={isTaken}
                      onClick={() => setSlot({ date: d.date, time: t, label: `${d.label} ${t}` })}
                      className={`w-full rounded-lg border px-1 py-1.5 text-xs transition-colors ${
                        active
                          ? "border-brand-500 bg-brand-600 font-semibold text-white"
                          : isTaken
                          ? "cursor-not-allowed border-ink-100 text-ink-300 line-through"
                          : "border-ink-200 text-ink-600 hover:border-brand-400 hover:text-brand-600"
                      }`}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm text-ink-600">
            <input type="checkbox" checked={mirrorGcal} onChange={(e) => setMirrorGcal(e.target.checked)} className="h-4 w-4 accent-[#7c3aed]" />
            Also add to Google Calendar (via your connected calendar)
          </label>
          <ModalFooter onClose={close} submitLabel={saving ? "Booking…" : "Book appointment"} onSubmit={submit} />
        </>
      )}
    </Modal>
  );
}

