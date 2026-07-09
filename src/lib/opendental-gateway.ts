import { supabaseAdmin as supabase } from "@/lib/supabase-admin";

// Server-side gateway to a clinic's LOCAL Open Dental middleware. This never
// touches Open Dental directly and never stores clinical data — it validates and
// forwards scheduling requests to the clinic's own middleware (reachable via the
// Cloudflare Tunnel URL the clinic configured). See OPEN_DENTAL.md.

export async function getOdConfig(workspaceId: string | null): Promise<{ url: string; key: string; enabled: boolean } | null> {
  try {
    let q = supabase.from("opendental_config").select("clinic_api_url, clinic_api_key, enabled");
    q = workspaceId ? q.eq("workspace_id", workspaceId) : q.limit(1);
    const { data } = await q.maybeSingle();
    if (!data?.clinic_api_url) return null;
    return { url: String(data.clinic_api_url).replace(/\/$/, ""), key: data.clinic_api_key ?? "", enabled: !!data.enabled };
  } catch {
    return null;
  }
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

  try {
    const res = await fetch(`${cfg.url}${path}`, {
      method: init.method,
      headers: { "Content-Type": "application/json", "x-api-key": cfg.key },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } catch (e) {
    return { status: 502, data: { error: `Could not reach the clinic middleware: ${fetchFailureDetail(e)}` } };
  }
}
