"use client";

import { useEffect, useState } from "react";
import { Phone, Mail, Tag, CalendarClock } from "lucide-react";
import { Modal } from "@/components/modal";
import { StatusBadge } from "@/components/ui";
import { fetchPatientBundle } from "@/lib/db";
import { type Patient, type Appointment } from "@/lib/mock-data";

// Friendly label for where a contact came from.
function sourceLabel(p: Patient): string {
  const src = p.sourceChannel ?? "";
  const who = p.sourceAgent ? ` · ${p.sourceAgent}` : "";
  const map: Record<string, string> = {
    voice: "Calling agent",
    whatsapp: "WhatsApp",
    instagram: "Instagram",
    messenger: "Messenger",
    sms: "SMS",
    email: "Email",
    manual: "Added manually",
  };
  if (map[src]) return `${map[src]}${who}`;
  if (p.sourceAgent) return p.sourceAgent;
  return "—";
}

// Lightweight contact card — name, phone, email, where they came from, and their
// appointments. Deliberately NOT the clinical chart (no payments / insurance /
// documents); a link opens the full chart when needed.
export function ContactDetailModal({ contact, onClose }: { contact: Patient; onClose: () => void }) {
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetchPatientBundle(contact.id)
      .then((b) => { if (alive && b) setAppts(b.appointments); })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [contact.id]);

  return (
    <Modal open onClose={onClose} title={contact.name} subtitle={sourceLabel(contact)}>
      <div className="grid gap-3 text-sm">
        <div className="grid gap-2">
          {[
            [Phone, contact.phone || "—"],
            [Mail, contact.email || "—"],
            [Tag, sourceLabel(contact)],
          ].map(([Icon, v], i) => {
            const I = Icon as typeof Phone;
            return (
              <div key={i} className="flex items-center gap-2.5 rounded-xl bg-ink-50 px-4 py-2.5">
                <I className="h-4 w-4 shrink-0 text-ink-400" />
                <span className="font-medium text-ink-900">{v as string}</span>
              </div>
            );
          })}
          <div className="flex items-center justify-between rounded-xl bg-ink-50 px-4 py-2.5">
            <span className="text-ink-500">Status</span>
            <StatusBadge status={contact.status} tone={contact.status === "Active" ? "green" : contact.status === "New" ? "blue" : "gray"} />
          </div>
        </div>

        <div>
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
            <CalendarClock className="h-3.5 w-3.5" /> Appointments
          </p>
          {loading ? (
            <p className="rounded-xl border border-ink-100 px-4 py-3 text-sm text-ink-400">Loading…</p>
          ) : appts.length === 0 ? (
            <p className="rounded-xl border border-ink-100 px-4 py-3 text-sm text-ink-400">No appointments yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {appts.map((a) => (
                <li key={a.id} className="flex items-center justify-between rounded-xl border border-ink-100 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink-900">{a.procedure}</p>
                    <p className="text-xs text-ink-500">{a.date} · {a.time}{a.fee != null ? ` · fee ${a.fee}` : ""}</p>
                  </div>
                  <span className="shrink-0 text-xs text-ink-400">{a.status}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <a
          href={`/dashboard/patients/${contact.id}`}
          className="mt-1 rounded-xl border border-ink-200 px-4 py-2 text-center text-sm font-semibold text-ink-700 hover:bg-ink-50"
        >
          Open full chart →
        </a>
      </div>
    </Modal>
  );
}
