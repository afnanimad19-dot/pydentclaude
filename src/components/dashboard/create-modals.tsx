"use client";

import { useState } from "react";
import { CalendarDays, CheckCircle2, AlertTriangle } from "lucide-react";
import { Modal, Field, ModalFooter, inputCls } from "@/components/modal";
import { createPatient, createAppointment } from "@/lib/db";

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
  });

  function set<K extends keyof typeof form>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function close() {
    setResult(null);
    setForm({ firstName: "", lastName: "", phone: "", email: "", birthdate: "", status: "New", insurance: "" });
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
              <select className={inputCls}>
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

const SLOT_DATES: Record<string, string> = {
  "Mon 15": "2026-06-15",
  "Tue 16": "2026-06-16",
  "Wed 17": "2026-06-17",
  "Thu 18": "2026-06-18",
  "Fri 19": "2026-06-19",
};

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
  const [slot, setSlot] = useState<string | null>(null);
  const [selectedPatient, setSelectedPatient] = useState(patientId ?? "");
  const [provider, setProvider] = useState("Dr. Patel");
  const [operatory, setOperatory] = useState("Op 1");
  const [procedure, setProcedure] = useState("");
  const days = Object.keys(SLOT_DATES);
  const times = ["9:00", "10:00", "11:30", "14:00", "15:30", "16:30"];

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
    const [day, time] = [slot.slice(0, 6).trim(), slot.slice(6).trim()];
    setSaving(true);
    const res = await createAppointment({
      patientId: pid,
      provider,
      operatory,
      procedure,
      date: SLOT_DATES[day] ?? "2026-06-15",
      time,
    });
    setSaving(false);
    setResult(res);
    if (res.ok) onCreated?.();
  }

  return (
    <Modal open={open} onClose={close} title="New appointment" subtitle="Saved to your schedule — mirrors to Google Calendar when connected." wide>
      {result?.ok ? (
        <ResultNote ok text={`${result.message} (${slot})`} />
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
            <CalendarDays className="h-4 w-4 text-brand-500" /> Pick a slot — week of June 15
          </p>
          <div className="grid grid-cols-5 gap-2">
            {days.map((d) => (
              <div key={d} className="space-y-1.5">
                <p className="text-center text-xs font-semibold text-ink-500">{d}</p>
                {times.map((t) => {
                  const id = `${d} ${t}`;
                  return (
                    <button
                      key={id}
                      onClick={() => setSlot(id)}
                      className={`w-full rounded-lg border px-1 py-1.5 text-xs transition-colors ${
                        slot === id
                          ? "border-brand-500 bg-brand-600 font-semibold text-white"
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
            <input type="checkbox" defaultChecked className="h-4 w-4 accent-[#207e84]" />
            Also add to Google Calendar and send confirmation via patient&apos;s preferred channel
          </label>
          <ModalFooter onClose={close} submitLabel={saving ? "Booking…" : "Book appointment"} onSubmit={submit} />
        </>
      )}
    </Modal>
  );
}

export function NewCampaignModal({
  open,
  onClose,
  channel,
}: {
  open: boolean;
  onClose: () => void;
  channel: "WhatsApp" | "SMS" | "Email";
}) {
  const [done, setDone] = useState(false);
  function close() {
    setDone(false);
    onClose();
  }
  return (
    <Modal open={open} onClose={close} title={`New ${channel} campaign`} subtitle="Audiences come straight from your synced patient lists." wide>
      {done ? (
        <ResultNote ok text="Campaign saved as draft (demo) — sending activates when the channel is connected." />
      ) : (
        <>
          <div className="grid gap-4">
            <Field label="Campaign name"><input className={inputCls} placeholder="July recall — overdue 6+ months" /></Field>
            {channel === "Email" && <Field label="Subject line"><input className={inputCls} placeholder="We miss your smile, {{first_name}}" /></Field>}
            <Field label="Audience">
              <select className={inputCls}>
                <option>Recall due &gt; 180 days (214 patients)</option>
                <option>Unconfirmed appointments — next 48h (12)</option>
                <option>Unscheduled treatment plans (47)</option>
                <option>Inactive &gt; 12 months (342)</option>
                <option>All active patients (1,240)</option>
              </select>
            </Field>
            <Field label="Message">
              <textarea
                rows={4}
                className={inputCls}
                placeholder={`Hi {{first_name}}! You're due for your cleaning — want me to find you a time this week?`}
              />
            </Field>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Send">
                <select className={inputCls}>
                  <option>Send now</option>
                  <option>Schedule for later</option>
                  <option>Save as draft</option>
                </select>
              </Field>
              <Field label="If patient replies">
                <select className={inputCls}>
                  <option>Hand to booking chatbot</option>
                  <option>Route to Omnichannel Inbox</option>
                  <option>Queue voice agent follow-up</option>
                </select>
              </Field>
            </div>
          </div>
          <ModalFooter onClose={close} submitLabel="Create campaign" onSubmit={() => setDone(true)} />
        </>
      )}
    </Modal>
  );
}

export function NewAgentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [done, setDone] = useState(false);
  function close() {
    setDone(false);
    onClose();
  }
  return (
    <Modal open={open} onClose={close} title="New voice agent" subtitle="Powered by Retell AI once a phone line is connected." wide>
      {done ? (
        <ResultNote ok text="Agent created as draft (demo) — assign a phone number in Settings to take it live." />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Agent name"><input className={inputCls} placeholder="Nora" /></Field>
            <Field label="Role">
              <select className={inputCls}>
                <option>Front-desk receptionist (inbound)</option>
                <option>Recall & reactivation (outbound)</option>
                <option>Insurance verification (outbound)</option>
                <option>Post-op check-in (outbound)</option>
              </select>
            </Field>
            <Field label="Voice">
              <select className={inputCls}>
                <option>Warm female · US English</option>
                <option>Friendly male · US English</option>
                <option>Neutral female · US English</option>
              </select>
            </Field>
            <Field label="Languages">
              <select className={inputCls}>
                <option>English</option>
                <option>English + Spanish</option>
              </select>
            </Field>
          </div>
          <Field label="Instructions / personality">
            <textarea
              rows={4}
              className={inputCls}
              placeholder="You are the friendly receptionist for Bright Smile Dental. Greet warmly, answer questions about hours and insurance, and always offer to book an appointment…"
            />
          </Field>
          <label className="mt-4 flex items-center gap-2 text-sm text-ink-600">
            <input type="checkbox" defaultChecked className="h-4 w-4 accent-[#207e84]" />
            Can book appointments directly into the schedule
          </label>
          <ModalFooter onClose={close} submitLabel="Create agent" onSubmit={() => setDone(true)} />
        </>
      )}
    </Modal>
  );
}
