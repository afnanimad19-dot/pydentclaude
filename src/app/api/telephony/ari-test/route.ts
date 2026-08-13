import { NextRequest, NextResponse } from "next/server";

// Live test for a clinic's Asterisk box, from the "Clinic Landline (on-prem)"
// connection profile. It hits Asterisk's ARI over HTTP with the given
// credentials and reports three separate signals so a failure says exactly which
// layer broke:
//   • reachable     — the box answered on the ARI port at all
//   • ariConnected  — ARI is enabled and the username/secret authenticate
//   • appRegistered — the Stasis app (e.g. pydent-agent) is currently registered
//                     (only true once the Pydent ARI connector is running there)
//
// NOTE: this runs from the Pydent backend, so it can only reach the box if the
// ARI host is reachable from the server (public, or on the same Tailscale/WG
// network). If it isn't, "reachable" comes back false with a clear hint — that
// itself is useful (the VPN/ACL isn't letting the backend in yet).
export const runtime = "nodejs";

function normalizeAriBase(input: string): string {
  let u = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  // Default ARI port when none was given.
  try {
    const url = new URL(u);
    if (!url.port && url.protocol === "http:") url.port = "8088";
    u = url.toString().replace(/\/+$/, "");
  } catch { /* keep as-is; the fetch will surface a bad URL */ }
  return u;
}

async function ariGet(base: string, path: string, auth: string, timeoutMs = 6000): Promise<{ status: number; json: unknown } | { error: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/ari${path}`, { headers: { Authorization: `Basic ${auth}` }, signal: ctrl.signal });
    let json: unknown = null;
    try { json = await res.json(); } catch { /* non-JSON body */ }
    return { status: res.status, json };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "request failed" };
  } finally {
    clearTimeout(t);
  }
}

export async function POST(req: NextRequest) {
  const { ariUrl, username, secret, stasisApp } = await req.json().catch(() => ({}));
  if (!ariUrl) return NextResponse.json({ reachable: false, ariConnected: false, appRegistered: false, error: "ariUrl is required." }, { status: 400 });

  const base = normalizeAriBase(String(ariUrl));
  const auth = Buffer.from(`${username ?? ""}:${secret ?? ""}`).toString("base64");

  // 1) Reachable + authenticated: /ari/asterisk/info needs valid ARI creds.
  const info = await ariGet(base, "/asterisk/info", auth);
  if ("error" in info) {
    return NextResponse.json({ reachable: false, ariConnected: false, appRegistered: false, error: `Could not reach ARI at ${base} — ${info.error}` });
  }
  const reachable = true; // the box answered on the ARI port
  if (info.status === 401 || info.status === 403) {
    return NextResponse.json({ reachable, ariConnected: false, appRegistered: false, error: "ARI reached, but the username/secret were rejected (401). Check ari.conf." });
  }
  if (info.status >= 400) {
    return NextResponse.json({ reachable, ariConnected: false, appRegistered: false, error: `ARI returned HTTP ${info.status}.` });
  }
  const version = (() => {
    const j = info.json as { system?: { version?: string }; build?: { version?: string } } | null;
    return j?.system?.version || j?.build?.version || "Asterisk";
  })();

  // 2) Stasis app registered? /ari/applications lists live registered apps.
  let appRegistered = false;
  if (stasisApp) {
    const apps = await ariGet(base, "/applications", auth);
    if (!("error" in apps) && apps.status < 400 && Array.isArray(apps.json)) {
      appRegistered = (apps.json as { name?: string }[]).some((a) => a?.name === String(stasisApp));
    }
  }

  return NextResponse.json({ reachable, ariConnected: true, appRegistered, version });
}
