// Pydent ARI connector — the on-prem bridge that makes the clinic landline
// answer with a Pydent AI voice agent.
//
//   Landline → clinic PBX (D-Link) → SIP → Asterisk → Stasis(pydent-agent)
//        → THIS connector → asks Pydent which agent/engine → dials the engine
//          over SIP (LiveKit or Vapi) and bridges the caller to it
//
// It runs on the same box as Asterisk and talks to ARI on localhost. Both
// engines take calls over SIP, so the box never handles audio itself — it just
// originates a SIP leg to the engine and bridges the two channels. Only
// OUTBOUND connections to Pydent are made (device-token auth + a heartbeat so
// the dashboard shows the box online); nothing reaches into the clinic network.
//
// Node 18+ (uses the `ws` package for the ARI events socket).

import WebSocket from "ws";

// ── config ────────────────────────────────────────────────────────────────────
const CFG = {
  ariUrl: (process.env.ARI_URL || "http://127.0.0.1:8088").replace(/\/+$/, ""),
  ariUser: process.env.ARI_USER || "pydent",
  ariSecret: process.env.ARI_SECRET || "",
  stasisApp: process.env.STASIS_APP || "pydent-agent",
  pydentBase: (process.env.PYDENT_BASE || "https://pydent.ai").replace(/\/+$/, ""),
  // Per-box token from Pydent's "Save & pair box" screen.
  deviceToken: process.env.PYDENT_DEVICE_TOKEN || "",
  // PJSIP endpoint names on this box that route to each engine's SIP domain
  // (see README: [livekit] → <project>.sip.livekit.cloud, [vapi] → sip.vapi.ai).
  livekitEndpoint: process.env.LIVEKIT_PJSIP_ENDPOINT || "livekit",
  vapiEndpoint: process.env.VAPI_PJSIP_ENDPOINT || "vapi",
};

const STATE = { ariConnected: false };

function log(...a) { console.log(new Date().toISOString(), ...a); }
function warn(...a) { console.warn(new Date().toISOString(), ...a); }

// ── ARI REST ──────────────────────────────────────────────────────────────────
const ariAuth = "Basic " + Buffer.from(`${CFG.ariUser}:${CFG.ariSecret}`).toString("base64");

async function ari(method, path, params) {
  const url = new URL(`${CFG.ariUrl}/ari${path}`);
  if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  const res = await fetch(url, { method, headers: { Authorization: ariAuth } });
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => "");
    throw new Error(`ARI ${method} ${path} → ${res.status} ${body.slice(0, 200)}`);
  }
  const text = await res.text().catch(() => "");
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

// ── call sessions ─────────────────────────────────────────────────────────────
const sessions = new Map(); // callerChannelId -> Session

class Session {
  constructor(channelId) {
    this.channelId = channelId; // caller channel in Stasis
    this.bridgeId = null;
    this.legId = null;          // the SIP leg to the engine
    this.closed = false;
  }
  async close(reason) {
    if (this.closed) return;
    this.closed = true;
    log(`[${this.channelId.slice(-8)}] closing (${reason})`);
    for (const id of [this.legId, this.channelId]) {
      if (id) { try { await ari("DELETE", `/channels/${id}`); } catch {} }
    }
    if (this.bridgeId) { try { await ari("DELETE", `/bridges/${this.bridgeId}`); } catch {} }
    sessions.delete(this.channelId);
  }
}

// ── Pydent backend ────────────────────────────────────────────────────────────
async function resolveCall(dialedNumber) {
  const res = await fetch(`${CFG.pydentBase}/api/telephony/ari-resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceToken: CFG.deviceToken, dialedNumber }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `resolve failed (${res.status})`);
  return data;
}

async function sendHeartbeat() {
  try {
    await fetch(`${CFG.pydentBase}/api/telephony/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceToken: CFG.deviceToken, ariConnected: STATE.ariConnected, stasisRegistered: STATE.ariConnected, activeCalls: sessions.size }),
    });
  } catch (e) {
    warn("heartbeat failed:", e.message);
  }
}

// ── bridge the caller to the engine over SIP ──────────────────────────────────
// sipUri looks like sip:<user>@<domain>; we dial PJSIP/<user>@<endpoint>, where
// <endpoint> is a PJSIP endpoint on this box whose contact is the engine's
// domain. The leg re-enters Stasis (appArgs "engine-leg") and joins the bridge.
async function bridgeToEngine(sess, cfg) {
  const user = String(cfg.sipUri || "").replace(/^sip:/, "").split("@")[0] || "pydent";
  const endpointName = cfg.engine === "vapi" ? CFG.vapiEndpoint : CFG.livekitEndpoint;
  const bridge = await ari("POST", "/bridges", { type: "mixing" });
  sess.bridgeId = bridge.id;
  await ari("POST", `/bridges/${bridge.id}/addChannel`, { channel: sess.channelId });
  const leg = await ari("POST", "/channels", { endpoint: `PJSIP/${user}@${endpointName}`, app: CFG.stasisApp, appArgs: `engine-leg,${sess.channelId}`, timeout: 45 });
  sess.legId = leg.id;
  log(`[${sess.channelId.slice(-8)}] dialing ${cfg.engine} (${cfg.agentName}) → PJSIP/${user}@${endpointName}`);
}

// ── ARI events (Stasis) ───────────────────────────────────────────────────────
async function onStasisStart(ev) {
  const chan = ev.channel;
  const args = ev.args || [];

  // The engine leg we originated re-enters Stasis — add it to its bridge.
  if (args[0] === "engine-leg") {
    const sess = sessions.get(args[1]);
    if (sess && sess.bridgeId) await ari("POST", `/bridges/${sess.bridgeId}/addChannel`, { channel: chan.id });
    return;
  }

  const dialed = chan.dialplan?.exten || "";
  log(`StasisStart: channel ${chan.id}, dialed "${dialed}"`);
  await ari("POST", `/channels/${chan.id}/answer`);

  const sess = new Session(chan.id);
  sessions.set(chan.id, sess);
  try {
    const cfg = await resolveCall(dialed);
    await bridgeToEngine(sess, cfg);
  } catch (e) {
    warn("could not connect the call:", e.message);
    try { await ari("POST", `/channels/${chan.id}/play`, { media: "sound:vm-goodbye" }); } catch {}
    await sess.close("resolve/bridge failed");
  }
}

async function onStasisEnd(ev) {
  const id = ev.channel?.id;
  for (const s of sessions.values()) {
    if (s.channelId === id || s.legId === id) { await s.close("stasis end"); return; }
  }
}

function connectAriEvents() {
  const wsUrl = CFG.ariUrl.replace(/^http/, "ws") + `/ari/events?app=${encodeURIComponent(CFG.stasisApp)}&api_key=${encodeURIComponent(`${CFG.ariUser}:${CFG.ariSecret}`)}`;
  const ws = new WebSocket(wsUrl);
  ws.on("open", () => { STATE.ariConnected = true; log(`ARI events connected (app=${CFG.stasisApp})`); void sendHeartbeat(); });
  ws.on("message", async (raw) => {
    let ev;
    try { ev = JSON.parse(raw.toString()); } catch { return; }
    try {
      if (ev.type === "StasisStart") await onStasisStart(ev);
      else if (ev.type === "StasisEnd") await onStasisEnd(ev);
    } catch (e) { warn("event handler error:", e.message); }
  });
  ws.on("close", () => { STATE.ariConnected = false; warn("ARI events closed — reconnecting in 3s"); setTimeout(connectAriEvents, 3000); });
  ws.on("error", (e) => { warn("ARI events error:", e.message); });
}

// ── boot ──────────────────────────────────────────────────────────────────────
function requireCfg() {
  const missing = [];
  if (!CFG.ariSecret) missing.push("ARI_SECRET");
  if (!CFG.deviceToken) missing.push("PYDENT_DEVICE_TOKEN");
  if (missing.length) { console.error("Missing required env:", missing.join(", ")); process.exit(1); }
}

requireCfg();
log(`Pydent ARI connector starting — ARI ${CFG.ariUrl}, app ${CFG.stasisApp}, Pydent ${CFG.pydentBase}`);
connectAriEvents();
sendHeartbeat();
setInterval(sendHeartbeat, 15000);

process.on("SIGINT", async () => { for (const s of sessions.values()) await s.close("shutdown"); process.exit(0); });
process.on("SIGTERM", async () => { for (const s of sessions.values()) await s.close("shutdown"); process.exit(0); });
