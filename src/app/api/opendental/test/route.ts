import { NextRequest, NextResponse } from "next/server";
import { getOdConfig, odHeaders, fetchFailureDetail } from "@/lib/opendental-gateway";

// Staged connection test for the clinic's Open Dental endpoint. Instead of one
// opaque "fetch failed", it reports which layer broke: URL sanity, reachability
// (the #1 failure — firewall / tunnel), then auth + data.
export const runtime = "nodejs";

const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;
const TIMEOUT = 20000;

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function GET(req: NextRequest) {
  const ws = req.nextUrl.searchParams.get("ws");
  const cfg = await getOdConfig(ws);
  if (!cfg) {
    return NextResponse.json({ ok: false, error: "No URL saved yet — enter the URL + API keys and click Save first." }, { status: 400 });
  }

  // 1 — URL sanity.
  let base: URL;
  try {
    base = new URL(cfg.url);
  } catch {
    return NextResponse.json({ ok: false, error: `"${cfg.url}" is not a valid URL — it must be the full https:// address.` }, { status: 400 });
  }
  if (PRIVATE_HOST.test(base.hostname)) {
    return NextResponse.json(
      { ok: false, error: `${base.hostname} is a local/LAN address — it only works on the clinic's own network. Pydent's server needs a PUBLIC address (a Cloudflare Tunnel URL, or the clinic's public host reachable from the internet).` },
      { status: 400 }
    );
  }

  const headers = odHeaders(cfg);
  const odApiMode = !!cfg.developerKey; // ODFHIR Developer/Customer auth = talking to the Open Dental API directly

  // 2 — reachability. A failure here is almost always the tunnel/firewall.
  try {
    const r = await fetch(`${cfg.url}/health`, { headers, signal: AbortSignal.timeout(TIMEOUT), cache: "no-store" });
    if (r.status === 401 || r.status === 403) {
      return NextResponse.json(
        { ok: false, error: `Reached ${base.hostname}, but it rejected the API keys (HTTP ${r.status}) — re-check the Customer API Key${odApiMode ? " and Developer API Key" : ""}.` },
        { status: 401 }
      );
    }
    if (r.status === 404) {
      // Reachable, but no /health route. If this is the Open Dental API itself
      // (developer key set), that's expected — its paths differ from a middleware.
      return NextResponse.json(
        {
          ok: false,
          error: odApiMode
            ? `Good news: ${base.hostname} is REACHABLE and your firewall is letting Pydent through (it answered HTTP 404 for /health). But this looks like the Open Dental API directly, whose endpoints differ from Pydent's middleware (/health, /doctors, /slots, /book). Tell me to map bookings onto the real Open Dental API endpoints and I'll wire it up.`
            : `Reached ${base.hostname}, but /health returned 404 — the URL points at something that isn't the Pydent middleware. Check the URL/path with whoever set up the connector.`,
        },
        { status: 502 }
      );
    }
    if (!r.ok) {
      return NextResponse.json({ ok: false, error: `Reached ${base.hostname}, but /health returned HTTP ${r.status}.` }, { status: 502 });
    }
  } catch (e) {
    const detail = fetchFailureDetail(e);
    const timedOut = /timed out/i.test(detail);
    return NextResponse.json(
      {
        ok: false,
        error: timedOut
          ? `Can't reach ${base.host} from Pydent's server — the connection timed out. A URL that works from another tool or on-site but times out here almost always means the clinic firewall (e.g. FortiGate / FortiDDNS) is only allowing certain IP addresses, and Pydent's servers aren't on the allow-list. Fix it one of two ways: (1) put the connector behind a Cloudflare Tunnel — those work from anywhere with no IP allow-list — or (2) allow Pydent's outbound servers through the firewall to ${base.host}.`
          : `Can't reach ${base.host}: ${detail}. Check the tunnel/connector is running and that this exact URL opens in a browser from outside the clinic network.`,
      },
      { status: 502 }
    );
  }

  // 3 — auth + data on the middleware's /doctors.
  try {
    const r = await fetch(`${cfg.url}/doctors`, { headers, signal: AbortSignal.timeout(TIMEOUT), cache: "no-store" });
    if (r.status === 401 || r.status === 403) {
      return NextResponse.json({ ok: false, error: `Reached the connector but it REJECTED the credentials (HTTP ${r.status}) — the API key(s) must match.` }, { status: 401 });
    }
    if (!r.ok) {
      return NextResponse.json({ ok: false, error: `Connector reached but /doctors returned HTTP ${r.status}.` }, { status: 502 });
    }
    const data = (await r.json().catch(() => ({}))) as any;
    const doctors = Array.isArray(data?.doctors) ? data.doctors.length : 0;
    return NextResponse.json({ ok: true, doctors, enabled: cfg.enabled });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `/health answered but /doctors failed: ${fetchFailureDetail(e)}` }, { status: 502 });
  }
}
