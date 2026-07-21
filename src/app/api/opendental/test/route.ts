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
  // A LAN address can never work from the cloud — but when Pydent itself runs
  // on-premise (self-hosted / locally next to Open Dental), it's exactly right.
  const runningInCloud = !!(process.env.NETLIFY || process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  if (PRIVATE_HOST.test(base.hostname) && runningInCloud) {
    return NextResponse.json(
      { ok: false, error: `${base.hostname} is a local/LAN address — it only works on the clinic's own network. Pydent's cloud server needs a PUBLIC address (a Cloudflare Tunnel URL, or the clinic's public host reachable from the internet). (If you self-host Pydent inside the clinic network, LAN addresses work.)` },
      { status: 400 }
    );
  }

  const headers = odHeaders(cfg);
  const odApiMode = !!cfg.developerKey; // ODFHIR Developer/Customer auth = talking to the Open Dental API directly

  // Developer key set → this is the Open Dental API itself. Test it directly on
  // /providers (with the standard /api/v1 prefix as fallback) — one call proves
  // reachability, auth, and data together.
  if (odApiMode) {
    const tryProviders = async (base: string) =>
      fetch(`${base}/providers`, { headers, signal: AbortSignal.timeout(TIMEOUT), cache: "no-store" });
    try {
      let r = await tryProviders(cfg.url);
      if (r.status === 404 && !/\/api\//i.test(cfg.url)) r = await tryProviders(`${cfg.url}/api/v1`);
      if (r.status === 401 || r.status === 403) {
        return NextResponse.json(
          { ok: false, error: `Reached ${base.hostname} and it IS the Open Dental API, but it rejected the keys (HTTP ${r.status}) — re-check the Developer API Key and Customer API Key (header: ODFHIR Developer/Customer).` },
          { status: 401 }
        );
      }
      if (r.status === 404) {
        return NextResponse.json(
          { ok: false, error: `Reached ${base.hostname}, but /providers wasn't found there — the URL doesn't look like the Open Dental API base. Try adding /api/v1 to the URL (e.g. https://host:port/api/v1) and Save again.` },
          { status: 502 }
        );
      }
      if (!r.ok) {
        return NextResponse.json({ ok: false, error: `Reached ${base.hostname}, but /providers returned HTTP ${r.status}.` }, { status: 502 });
      }
      const data = (await r.json().catch(() => [])) as any;
      const doctors = Array.isArray(data) ? data.filter((p: any) => !p.IsHidden).length : 0;
      return NextResponse.json({ ok: true, doctors, enabled: cfg.enabled, mode: "opendental-api" });
    } catch (e) {
      const detail = fetchFailureDetail(e);
      const timedOut = /timed out/i.test(detail) || /ECONNRESET|reset/i.test(detail);
      return NextResponse.json(
        {
          ok: false,
          error: timedOut
            ? `Can't reach ${base.host} from Pydent's server — the connection ${detail.includes("reset") ? "was reset" : "timed out"}. The URL and keys are fine; the clinic firewall (FortiGate/FortiDDNS) is only answering allowed IP addresses, and Pydent's cloud servers don't have a fixed IP to allow-list. Two ways to fix it: (1) ask clinic IT to open that port to ALL source IPs — the Developer+Customer API keys still protect it, and this is exactly how other tools connect with just the URL + keys — or (2) run a Cloudflare Tunnel on the clinic machine (no ports opened at all) and paste its URL here instead. Nothing else needs to change: the same keys keep working.`
            : `Can't reach ${base.host}: ${detail}. Check the URL opens from OUTSIDE the clinic network.`,
        },
        { status: 502 }
      );
    }
  }

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
