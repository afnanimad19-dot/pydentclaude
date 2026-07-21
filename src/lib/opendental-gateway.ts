import { supabaseAdmin as supabase } from "@/lib/supabase-admin";

// Server-side gateway to a clinic's LOCAL Open Dental middleware. This never
// touches Open Dental directly and never stores clinical data — it validates and
// forwards scheduling requests to the clinic's own middleware (reachable via the
// Cloudflare Tunnel URL the clinic configured). See OPEN_DENTAL.md.

export interface OdGatewayConfig {
  url: string;
  key: string;          // Customer API Key
  developerKey: string; // Developer API Key (Open Dental API: ODFHIR Developer/Customer)
  username: string;
  password: string;
  enabled: boolean;
}

export async function getOdConfig(workspaceId: string | null): Promise<OdGatewayConfig | null> {
  try {
    // select("*") so this keeps working whether or not the username/password
    // columns (migration 0051) exist yet.
    let q = supabase.from("opendental_config").select("*");
    q = workspaceId ? q.eq("workspace_id", workspaceId) : q.limit(1);
    const { data } = await q.maybeSingle();
    if (!data?.clinic_api_url) return null;
    return {
      url: String(data.clinic_api_url).replace(/\/$/, ""),
      key: data.clinic_api_key ?? "",
      developerKey: data.developer_key ?? "",
      username: data.clinic_username ?? "",
      password: data.clinic_password ?? "",
      enabled: !!data.enabled,
    };
  } catch {
    return null;
  }
}

// Headers for every call. Open Dental's own API authenticates with
// `Authorization: ODFHIR {DeveloperKey}/{CustomerKey}` — used when a Developer
// API Key is set. Otherwise we fall back to a custom middleware's scheme:
// the shared-secret x-api-key plus optional HTTP Basic (username/password).
export function odHeaders(cfg: OdGatewayConfig): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.key) h["x-api-key"] = cfg.key; // harmless for OD; needed by custom middleware
  if (cfg.developerKey) {
    // Open Dental API standard: ODFHIR <developer>/<customer>.
    h.Authorization = `ODFHIR ${cfg.developerKey}/${cfg.key}`;
  } else if (cfg.username || cfg.password) {
    h.Authorization = `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64")}`;
  }
  return h;
}

// Node's fetch hides the real network failure behind "fetch failed" — the actual
// reason (DNS, refused, TLS, timeout) lives in error.cause. Surface it so a failed
// connection test tells the clinic exactly what to fix.
export function fetchFailureDetail(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; hostname?: string; address?: string; message?: string } };
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timed out — the URL is reachable-looking but nothing answered in time";
  const c = err?.cause;
  if (c?.code === "ENOTFOUND" || c?.code === "EAI_AGAIN") return `DNS lookup failed for ${c.hostname ?? "the host"} — that domain doesn't resolve (typo in the URL, or the tunnel hostname doesn't exist)`;
  if (c?.code === "ECONNREFUSED") return `connection refused${c.address ? ` at ${c.address}` : ""} — nothing is listening there (is the connector/tunnel running?)`;
  if (c?.code === "ECONNRESET") return "connection reset by the remote side";
  if (String(c?.code ?? "").includes("CERT") || /certificate/i.test(c?.message ?? "")) return "TLS certificate problem on the middleware URL";
  if (c?.code) return c.code;
  return err?.message ?? "network error";
}

export async function odForward(
  workspaceId: string | null,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown }
): Promise<{ status: number; data: unknown }> {
  const cfg = await getOdConfig(workspaceId);
  if (!cfg) return { status: 400, data: { error: "Open Dental is not connected for this clinic." } };
  if (!cfg.enabled) return { status: 400, data: { error: "Open Dental connection is turned off." } };

  // A Developer API Key means the URL is the Open Dental API itself (their local
  // API service / relay), NOT the Pydent connector — its endpoints and shapes
  // differ, so translate each connector operation onto the real Open Dental API.
  if (cfg.developerKey) {
    try {
      return await odApiForward(cfg, path, init);
    } catch (e) {
      return { status: 502, data: { error: `Could not reach Open Dental: ${fetchFailureDetail(e)}` } };
    }
  }

  try {
    const res = await fetch(`${cfg.url}${path}`, {
      method: init.method,
      headers: odHeaders(cfg),
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } catch (e) {
    return { status: 502, data: { error: `Could not reach the clinic middleware: ${fetchFailureDetail(e)}` } };
  }
}

// ---------------------------------------------------------------- OD API mode
// Direct Open Dental API support (auth: ODFHIR DeveloperKey/CustomerKey). The
// clinic pastes the SAME URL + Customer key + Developer key other integrations
// use — no connector install needed. We map Pydent's operations onto the real
// Open Dental REST endpoints: /providers, /appointments/Slots, /patients,
// /appointments. Dates use Open Dental's "yyyy-MM-dd HH:mm:ss" format.

/* eslint-disable @typescript-eslint/no-explicit-any */
async function odApiFetch(
  cfg: OdGatewayConfig,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown
): Promise<{ status: number; data: any }> {
  const call = async (base: string) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: odHeaders(cfg),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
  const first = await call(cfg.url);
  // The OD API service serves under /api/v1 — if the clinic saved the bare
  // host:port, transparently retry with the standard prefix.
  if (first.status === 404 && !/\/api\//i.test(cfg.url)) {
    const retry = await call(`${cfg.url}/api/v1`);
    if (retry.status !== 404) return retry;
  }
  return first;
}

// "2026-07-21T14:00" → "2026-07-21 14:00:00" (Open Dental's datetime format).
function odDateTime(dt: string): string {
  const d = String(dt).slice(0, 10);
  const t = String(dt).slice(11, 16) || "09:00";
  return `${d} ${t}:00`;
}

async function odApiProviders(cfg: OdGatewayConfig): Promise<{ status: number; data: unknown }> {
  const r = await odApiFetch(cfg, "GET", "/providers");
  if (r.status === 401 || r.status === 403) return { status: r.status, data: { error: "Open Dental rejected the API keys — re-check the Developer and Customer API Keys." } };
  if (r.status !== 200 || !Array.isArray(r.data)) return { status: r.status || 502, data: { error: `Open Dental /providers returned HTTP ${r.status}.`, doctors: [] } };
  const doctors = (r.data as any[])
    .filter((p) => !p.IsHidden)
    .map((p) => ({
      id: String(p.ProvNum ?? ""),
      name: [p.FName, p.LName].filter(Boolean).join(" ").trim() || p.Abbr || `Provider ${p.ProvNum}`,
      specialty: p.Specialty ?? "",
    }));
  return { status: 200, data: { doctors } };
}

async function odApiSlots(cfg: OdGatewayConfig, body: any): Promise<{ status: number; data: unknown }> {
  const date = String(body?.date ?? "").slice(0, 10);
  const q = new URLSearchParams({ date });
  const prov = String(body?.doctorId ?? "").replace(/\D/g, "");
  if (prov) q.set("ProvNum", prov);
  const r = await odApiFetch(cfg, "GET", `/appointments/Slots?${q.toString()}`);
  if (r.status !== 200 || !Array.isArray(r.data)) {
    return { status: r.status || 502, data: { slots: [], error: `Open Dental slots returned HTTP ${r.status}.` } };
  }
  const slots = (r.data as any[]).map((s) => String(s.DateTimeStart ?? "").slice(11, 16)).filter(Boolean);
  return { status: 200, data: { slots } };
}

// Find the patient by phone; create a minimal record if they're new.
async function odApiFindOrCreatePatient(cfg: OdGatewayConfig, name: string, phone: string, email: string): Promise<number | null> {
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.length >= 7) {
    const r = await odApiFetch(cfg, "GET", `/patients?Phone=${encodeURIComponent(digits.slice(-10))}`);
    if (r.status === 200 && Array.isArray(r.data) && r.data.length) {
      const pn = Number((r.data[0] as any)?.PatNum);
      if (pn) return pn;
    }
  }
  const parts = (name || "").trim().split(/\s+/);
  const FName = parts[0] || "Patient";
  const LName = parts.slice(1).join(" ") || "Lead";
  const create = await odApiFetch(cfg, "POST", "/patients", { FName, LName, WirelessPhone: phone || "", Email: email || "" });
  const pn = Number((create.data as any)?.PatNum);
  return create.status >= 200 && create.status < 300 && pn ? pn : null;
}

async function odApiCreateAppt(cfg: OdGatewayConfig, body: any): Promise<{ status: number; data: unknown }> {
  const dt = String(body?.datetime ?? "");
  const date = dt.slice(0, 10);
  if (!date) return { status: 400, data: { error: "No date/time provided." } };
  const patNum = await odApiFindOrCreatePatient(cfg, String(body?.name ?? ""), String(body?.phone ?? ""), String(body?.email ?? ""));
  if (!patNum) return { status: 502, data: { error: "Open Dental could not find or create the patient record." } };

  // Open Dental needs an operatory (Op). Use the open slot matching the
  // requested time (its OpNum + ProvNum), else the first open slot that day.
  const want = odDateTime(dt);
  const slotsR = await odApiFetch(cfg, "GET", `/appointments/Slots?date=${date}`);
  const list: any[] = Array.isArray(slotsR.data) ? slotsR.data : [];
  const hit = list.find((s) => String(s.DateTimeStart ?? "").startsWith(want.slice(0, 16))) ?? list[0];

  const payload: Record<string, unknown> = {
    PatNum: patNum,
    AptDateTime: want,
    Op: hit?.OpNum ?? 1,
    Note: `Booked via Pydent${body?.serviceId ? ` — ${body.serviceId}` : ""}`,
  };
  const provArg = String(body?.doctorId ?? "").replace(/\D/g, "");
  if (provArg) payload.ProvNum = Number(provArg);
  else if (hit?.ProvNum) payload.ProvNum = hit.ProvNum;

  const r = await odApiFetch(cfg, "POST", "/appointments", payload);
  const apt = (r.data as any)?.AptNum;
  if (r.status >= 200 && r.status < 300 && apt) return { status: 200, data: { appointmentId: String(apt) } };
  const detail = typeof r.data === "string" ? r.data : (r.data as any)?.error ?? (r.data as any)?.message ?? "";
  return { status: r.status || 502, data: { error: `Open Dental rejected the appointment (HTTP ${r.status})${detail ? `: ${String(detail).slice(0, 200)}` : ""}.` } };
}

async function odApiForward(
  cfg: OdGatewayConfig,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown }
): Promise<{ status: number; data: unknown }> {
  const body: any = init.body ?? {};
  switch (path) {
    case "/health":
    case "/doctors":
      return odApiProviders(cfg);
    case "/available-slots":
      return odApiSlots(cfg, body);
    case "/create-appointment":
      return odApiCreateAppt(cfg, body);
    case "/reschedule-appointment": {
      const r = await odApiFetch(cfg, "PUT", `/appointments/${encodeURIComponent(String(body?.appointmentId ?? ""))}`, { AptDateTime: odDateTime(String(body?.datetime ?? "")) });
      return r.status >= 200 && r.status < 300 ? { status: 200, data: { ok: true } } : { status: r.status || 502, data: { error: `Open Dental reschedule failed (HTTP ${r.status}).` } };
    }
    case "/cancel-appointment": {
      const r = await odApiFetch(cfg, "PUT", `/appointments/${encodeURIComponent(String(body?.appointmentId ?? ""))}/Break`, { sendToUnscheduledList: true });
      return r.status >= 200 && r.status < 300 ? { status: 200, data: { ok: true } } : { status: r.status || 502, data: { error: `Open Dental cancel failed (HTTP ${r.status}).` } };
    }
    default:
      return { status: 404, data: { error: `Unsupported Open Dental API operation: ${path}` } };
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
