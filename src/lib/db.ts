// Live data layer (Supabase) with graceful fallback to the bundled demo
// dataset when the database is unreachable or hasn't been migrated yet.

import { supabase } from "./supabase";
import {
  patients as mockPatients,
  appointments as mockAppointments,
  treatmentPlans as mockPlans,
  patientDocuments as mockDocs,
  insurancePolicies as mockInsurance,
  payments as mockPayments,
  type Patient,
  type Appointment,
  type TreatmentPlan,
  type PatientDocument,
  type InsurancePolicy,
  type Payment,
} from "./mock-data";

export type DataSource = "live" | "demo";

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToPatient(r: any): Patient {
  return {
    id: r.id,
    patNum: r.pat_num ?? 0,
    name: r.name,
    phone: r.phone ?? "",
    email: r.email ?? "",
    birthdate: r.birthdate ?? "",
    balance: Number(r.balance ?? 0),
    insurance: r.insurance ?? "Self-pay",
    lastVisit: r.last_visit ?? "—",
    nextAppointment: r.next_appointment ? r.next_appointment.slice(0, 16).replace("T", " ") : null,
    recallDue: !!r.recall_due,
    status: r.status,
  };
}

function rowToAppointment(r: any, patientName: string): Appointment {
  return {
    id: r.id,
    aptNum: r.apt_num ?? 0,
    patientId: r.patient_id,
    patientName,
    provider: r.provider ?? "",
    operatory: r.operatory ?? "",
    procedure: r.procedure ?? "",
    date: r.date,
    time: r.time ?? "",
    durationMin: r.duration_min ?? 60,
    status: r.status,
    confirmedVia: r.confirmed_via ?? null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function fetchPatients(): Promise<{ patients: Patient[]; source: DataSource }> {
  try {
    const { data, error } = await supabase.from("patients").select("*").order("name");
    if (error || !data) throw error ?? new Error("no data");
    return { patients: data.map(rowToPatient), source: "live" };
  } catch {
    return { patients: mockPatients, source: "demo" };
  }
}

export async function fetchAppointments(): Promise<{ appointments: Appointment[]; source: DataSource }> {
  try {
    const { data, error } = await supabase
      .from("appointments")
      .select("*, patients(name)")
      .order("date");
    if (error || !data) throw error ?? new Error("no data");
    return {
      appointments: data.map((r) => rowToAppointment(r, r.patients?.name ?? "Unknown")),
      source: "live",
    };
  } catch {
    return { appointments: mockAppointments, source: "demo" };
  }
}

export interface PatientBundle {
  patient: Patient;
  appointments: Appointment[];
  plans: TreatmentPlan[];
  documents: PatientDocument[];
  insurance: InsurancePolicy[];
  payments: Payment[];
  source: DataSource;
}

export async function fetchPatientBundle(id: string): Promise<PatientBundle | null> {
  try {
    const { data: p, error } = await supabase.from("patients").select("*").eq("id", id).single();
    if (error || !p) throw error ?? new Error("not found");

    const [apts, plans, docs, ins, pays] = await Promise.all([
      supabase.from("appointments").select("*").eq("patient_id", id).order("date"),
      supabase.from("treatment_plans").select("*, treatment_procedures(*)").eq("patient_id", id),
      supabase.from("documents").select("*").eq("patient_id", id).order("uploaded_at", { ascending: false }),
      supabase.from("insurance_policies").select("*").eq("patient_id", id),
      supabase.from("payments").select("*").eq("patient_id", id).order("date", { ascending: false }),
    ]);

    const patient = rowToPatient(p);
    return {
      patient,
      appointments: (apts.data ?? []).map((r) => rowToAppointment(r, patient.name)),
      plans: (plans.data ?? []).map((r) => ({
        id: r.id,
        patientId: r.patient_id,
        name: r.name,
        presentedOn: r.presented_on ?? "",
        status: r.status,
        procedures: (r.treatment_procedures ?? []).map(
          (proc: { code: string; description: string; tooth: string; fee: number; status: "Planned" | "Accepted" | "Completed" }) => ({
            code: proc.code,
            description: proc.description,
            tooth: proc.tooth ?? "",
            fee: Number(proc.fee),
            status: proc.status,
          })
        ),
      })),
      documents: (docs.data ?? []).map((r) => ({
        id: r.id,
        patientId: r.patient_id,
        name: r.name,
        category: r.category,
        uploadedAt: (r.uploaded_at ?? "").slice(0, 10),
        size: r.size_label ?? "",
      })),
      insurance: (ins.data ?? []).map((r) => ({
        id: r.id,
        patientId: r.patient_id,
        carrier: r.carrier,
        plan: r.plan,
        memberId: r.member_id,
        groupNumber: r.group_number,
        annualMax: Number(r.annual_max),
        usedBenefits: Number(r.used_benefits),
        deductible: Number(r.deductible),
        status: r.status,
      })),
      payments: (pays.data ?? []).map((r) => ({
        id: r.id,
        patientId: r.patient_id,
        date: r.date,
        amount: Number(r.amount),
        method: r.method,
        description: r.description ?? "",
        status: r.status,
      })),
      source: "live",
    };
  } catch {
    // Demo fallback (mock ids like "p1")
    const patient = mockPatients.find((p) => p.id === id);
    if (!patient) return null;
    return {
      patient,
      appointments: mockAppointments.filter((a) => a.patientId === id),
      plans: mockPlans.filter((t) => t.patientId === id),
      documents: mockDocs.filter((d) => d.patientId === id),
      insurance: mockInsurance.filter((i) => i.patientId === id),
      payments: mockPayments.filter((p2) => p2.patientId === id),
      source: "demo",
    };
  }
}

export async function createPatient(input: {
  name: string;
  phone: string;
  email: string;
  birthdate: string;
  insurance: string;
  status: string;
}): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase.from("patients").insert({
    name: input.name,
    phone: input.phone,
    email: input.email,
    birthdate: input.birthdate || null,
    insurance: input.insurance || "Self-pay",
    status: input.status,
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Patient created and saved to the database." };
}

export async function createAppointment(input: {
  patientId: string;
  provider: string;
  operatory: string;
  procedure: string;
  date: string;
  time: string;
}): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase.from("appointments").insert({
    patient_id: input.patientId,
    provider: input.provider,
    operatory: input.operatory,
    procedure: input.procedure || "Prophylaxis + exam",
    date: input.date,
    time: input.time,
    status: "Scheduled",
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Appointment saved to the schedule." };
}
