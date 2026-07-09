import { NextRequest, NextResponse } from "next/server";
import { getOdConfig, odHeaders, fetchFailureDetail } from "@/lib/opendental-gateway";

// Staged connection test for the Open Dental middleware. Instead of one opaque
// "fetch failed", it checks each layer and reports exactly which one broke:
//   1. Is a URL saved and valid (and not a localhost/LAN address we can't reach)?
//   2. Does <url>/health answer (no API key needed — pure reachability/tunnel test)?
//   3. Does <url>/doctors accept the saved API key (auth test)?
export const runtime = "nodejs";

const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function GET(req: NextRequest) {
  const ws = req.nextUrl.searchParams.get("ws");
  const cfg = await getOdConfig(ws);
  if (!cfg) {
    return NextResponse.json({ ok: false, error: "No middleware URL saved yet — enter the URL + API key and click Save first." }, { status: 400 });
  }

  // 1 — URL sanity.
  let base: URL;
  try {
    base = new URL(cfg.url);
  } catch {
    return NextResponse.json({ ok: false, error: `"${cfg.url}" is not a valid URL — it must be the full https:// Cloudflare Tunnel address.` }, { status: 400 });
  }
  if (PRIVATE_HOST.test(base.hostname)) {
    return NextResponse.json(
      { ok: false, error: `${base.hostname} is a local/LAN address — it only works on the clinic's own network. Pydent's server needs the PUBLIC Cloudflare Tunnel URL (e.g. https://clinic-api.yourdomain.com or the trycloudflare.com URL the tunnel printed).` },
      { status: 400 }
    );
  }

  // Send everything the clinic configured on BOTH probes: the x-api-key shared
  // secret plus HTTP Basic auth (username/password) when the middleware needs it.
  const headers = odHeaders(cfg);
  const hasBasicAuth = !!(cfg.username || cfg.password);

  // 2 — reachability: a failure here is the tunnel/URL (or Basic auth on 401).
  let mode = "unknown";
  try {
    const r = await fetch(`${cfg.url}/health`, { headers, signal: AbortSignal.timeout(10000), cache: "no-store" });
    if (r.status === 401 || r.status === 403) {
      return NextResponse.json(
        {
          ok: false,
          error: hasBasicAuth
            ? `Reached ${base.hostname}, but it rejected the username/password (HTTP ${r.status}) — re-check the middleware username and password with your provider.`
            : `Reached ${base.hostname}, but it requires a username/password (HTTP ${r.status}) — fill in the Middleware username + password fields and save.`,
        },
        { status: 401 }
      );
    }
    if (!r.ok) {
      return NextResponse.json(
        { ok: false, error: `Reached ${base.hostname}, but /health returned HTTP ${r.status} — something answered that isn't the middleware. Check with your provider that the URL points at the connector.` },
        { status: 502 }
      );
    }
    const h = (await r.json().catch(() => ({}))) as any;
    mode = h?.mode ?? "unknown";
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Can't reach ${base.hostname}: ${fetchFailureDetail(e)}. Check that the tunnel AND the middleware are running on the clinic server, and that this exact URL opens /health in a browser.` },
      { status: 502 }
    );
  }

  // 3 — auth + data: /doctors requires the shared secret.
  try {
    const r = await fetch(`${cfg.url}/doctors`, { headers, signal: AbortSignal.timeout(10000), cache: "no-store" });
    if (r.status === 401 || r.status === 403) {
      return NextResponse.json(
        { ok: false, mode, error: `Middleware reached (${mode} mode) but it REJECTED the credentials (HTTP ${r.status}) — the API key must match the middleware's key${hasBasicAuth ? ", and the username/password must be correct" : ""}.` },
        { status: 401 }
      );
    }
    if (!r.ok) {
      return NextResponse.json({ ok: false, mode, error: `Middleware reached but /doctors returned HTTP ${r.status}.` }, { status: 502 });
    }
    const data = (await r.json().catch(() => ({}))) as any;
    const doctors = Array.isArray(data?.doctors) ? data.doctors.length : 0;
    return NextResponse.json({ ok: true, mode, doctors, enabled: cfg.enabled });
  } catch (e) {
    return NextResponse.json({ ok: false, mode, error: `/health answered but /doctors failed: ${fetchFailureDetail(e)}` }, { status: 502 });
  }
}
