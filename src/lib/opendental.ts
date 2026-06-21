// OpenDental API client for Pydent.
//
// Each clinic connects its own OpenDental API key (Developer + Customer key
// pair) from Settings → Integrations. Until a key is saved AND demo mode is
// turned off, every call resolves from the local demo dataset — so nothing
// can ever touch a live clinic's OpenDental database by accident.
//
// Live mode talks to the OpenDental REST API:
//   https://api.opendental.com/api/v1
// (or a clinic's self-hosted eConnector endpoint), authenticated with
//   Authorization: ODFHIR {DeveloperKey}/{CustomerKey}
//
// Read endpoints we plan to consume first (lowest-risk, read-only):
//   GET /patients              → patient roster, balances, contact info
//   GET /appointments          → schedule, confirmation status
//   GET /recalls               → recall/overdue lists (drives recall flows)
//   GET /treatplans            → unscheduled treatment (drives pipeline)
// Write endpoints come later, behind an explicit per-clinic opt-in:
//   POST /appointments         → booking from chat/voice
//   PUT  /appointments/{AptNum}/Confirm → confirmations from reminders
//   POST /commlogs             → log every conversation back to the chart

import { appointments, patients, type Appointment, type Patient } from "./mock-data";

export interface OpenDentalConfig {
  baseUrl: string;
  developerKey: string;
  customerKey: string;
  demoMode: boolean;
}

export const DEFAULT_CONFIG: OpenDentalConfig = {
  baseUrl: "https://api.opendental.com/api/v1",
  developerKey: "",
  customerKey: "",
  demoMode: true,
};

export class OpenDentalClient {
  constructor(private config: OpenDentalConfig = DEFAULT_CONFIG) {}

  get isLive(): boolean {
    return (
      !this.config.demoMode &&
      this.config.developerKey.length > 0 &&
      this.config.customerKey.length > 0
    );
  }

  private async request<T>(path: string): Promise<T> {
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      headers: {
        Authorization: `ODFHIR ${this.config.developerKey}/${this.config.customerKey}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`OpenDental API error ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  async getPatients(): Promise<Patient[]> {
    if (!this.isLive) return patients;
    // Live shape differs (PatNum, LName, FName, …) — mapped here when enabled.
    return this.request<Patient[]>("/patients");
  }

  async getAppointments(): Promise<Appointment[]> {
    if (!this.isLive) return appointments;
    return this.request<Appointment[]>("/appointments");
  }

  /** Smoke-test a key pair without writing anything. */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    if (!this.isLive) {
      return { ok: true, message: "Demo mode — using sample clinic data. No live connection attempted." };
    }
    try {
      await this.request("/patients?Limit=1");
      return { ok: true, message: "Connected to OpenDental successfully." };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Connection failed." };
    }
  }
}

export const openDental = new OpenDentalClient();
