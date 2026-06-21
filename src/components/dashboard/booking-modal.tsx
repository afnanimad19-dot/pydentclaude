"use client";

import { useState } from "react";
import { CalendarCheck2 } from "lucide-react";
import { Modal, Field, ModalFooter, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import { createBooking } from "@/lib/db";

const SERVICES = [
  "Check-up + cleaning",
  "New patient exam",
  "Emergency / pain",
  "Whitening",
  "Filling",
  "Root canal",
  "Crown / veneer",
  "Implant consult",
  "Braces / Invisalign consult",
];

// Minimal booking capture (name / email / phone / service + time). Lands on our
// Calendar and forwards to Open Dental when the clinic has it enabled.
export function BookingModal({
  open,
  onClose,
  onBooked,
  initialName = "",
  initialPhone = "",
  initialEmail = "",
  z,
}: {
  open: boolean;
  onClose: () => void;
  onBooked?: () => void;
  initialName?: string;
  initialPhone?: string;
  initialEmail?: string;
  z?: string;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState(initialPhone);
  const [email, setEmail] = useState(initialEmail);
  const [service, setService] = useState(SERVICES[0]);
  const [date, setDate] = useState(today);
  const [time, setTime] = useState("10:00");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!name.trim()) { toast("Enter the patient's name.", "info"); return; }
    setSaving(true);
    const res = await createBooking({ name: name.trim(), email, phone, service, date, time });
    setSaving(false);
    if (!res.ok) { toast(res.message, "info"); return; }
    toast(res.openDental ? `${res.message} ${res.openDental}` : res.message, "success");
    onBooked?.();
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Book an appointment" subtitle="It appears on the calendar and books in Open Dental when connected." z={z}>
      <div className="grid gap-4">
        <Field label="Patient name"><input className={inputCls} placeholder="Jordan Lee" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Phone"><input className={inputCls} placeholder="+1 (305) 555-0100" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          <Field label="Email"><input className={inputCls} placeholder="patient@email.com" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        </div>
        <Field label="Service">
          <select className={inputCls} value={service} onChange={(e) => setService(e.target.value)}>
            {SERVICES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Date"><input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Time"><input type="time" className={inputCls} value={time} onChange={(e) => setTime(e.target.value)} /></Field>
        </div>
        <p className="flex items-center gap-1.5 text-xs text-ink-400"><CalendarCheck2 className="h-3.5 w-3.5" /> Saves the lead (name, phone, email) and the booked service.</p>
      </div>
      <ModalFooter onClose={onClose} submitLabel={saving ? "Booking…" : "Book appointment"} onSubmit={submit} />
    </Modal>
  );
}
