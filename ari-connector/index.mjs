// Pydent ARI connector — the on-prem bridge that makes the clinic landline
// answer with a Pydent AI voice agent.
//
//   Landline → clinic PBX (D-Link) → SIP → Asterisk → Stasis(pydent-agent)
//        → THIS connector → audio ↔ AI engine (xAI Grok / Vapi)
//
// It runs on the same box as Asterisk. Asterisk hands each inbound call into the
// Stasis app; this connector answers it, opens an AudioSocket media channel, asks
// the Pydent backend which agent + engine to use, and bridges the caller's audio
// to that engine. Tool calls (book/reschedule/cancel/email) run through Pydent's
// existing /api/agents/tool-exec, so bookings from a phone call are real.
//
// Node 18+ (global fetch/WebSocket-free — we use the `ws` package for sockets).

import net from "node:net";
import crypto from "node:crypto";
import WebSocket from "ws";

// ── config ────────────────────────────────────────────────────────────────────
const CFG = {
  ariUrl: (process.env.ARI_URL || "http://127.0.0.1:8088").replace(/\/+$/, ""),
  ariUser: process.env.ARI_USER || "pydent",
  ariSecret: process.env.ARI_SECRET || "",
  stasisApp: process.env.STASIS_APP || "pydent-agent",
  pydentBase: (process.env.PYDENT_BASE || "https://pydent.ai").replace(/\/+$/, ""),
  connectorToken: process.env.PYDENT_CONNECTOR_TOKEN || "",
  ws: process.env.PYDENT_WS || "",
  asHost: process.env.AUDIOSOCKET_HOST || "127.0.0.1",
  asPort: Number(process.env.AUDIOSOCKET_PORT || 9092),
};

// xAI streams/accepts PCM16 at 24 kHz; Asterisk AudioSocket "slin" is 16-bit
// mono at 8 kHz. We resample between the two.
const AS_RATE = 8000;
const XAI_RATE = 24000;

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

// ── resampling (linear) ─────────────────────────────────────────────────────
function resampleInt16(input, inRate, outRate) {
  if (inRate === outRate) return input;
  const ratio = outRate / inRate;
  const outLen = Math.floor(input.length * ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    out[i] = (input[i0] * (1 - frac) + input[i1] * frac) | 0;
  }
  return out;
}

function bufToInt16(buf) {
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
}
function int16ToBuf(i16) {
  return Buffer.from(i16.buffer, i16.byteOffset, i16.length * 2);
}

// ── AudioSocket protocol (Asterisk external media, encapsulation=audiosocket) ──
// Frame: [type:1][len:2 BE][payload]. Types: 0x00 hangup, 0x01 uuid,
// 0x10 audio (slin 16-bit LE 8kHz mono), 0xff error.
const AS_HANGUP = 0x00, AS_UUID = 0x01, AS_AUDIO = 0x10, AS_ERROR = 0xff;

function asFrame(type, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(3);
  head.writeUInt8(type, 0);
  head.writeUInt16BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

// Sessions keyed by the AudioSocket UUID we pass to externalMedia.
const sessions = new Map(); // uuid -> Session

class Session {
  constructor(uuid, channelId) {
    this.uuid = uuid;
    this.channelId = channelId;     // the caller channel in Stasis
    this.bridgeId = null;
    this.mediaChannelId = null;     // the externalMedia channel
    this.asSocket = null;           // TCP socket from Asterisk
    this.engineWs = null;           // xAI realtime socket
    this.agentId = null;
    this.closed = false;
    this.responseActive = false;
  }

  // Send 24kHz PCM16 (from xAI) back to the caller as 8kHz AudioSocket audio.
  sendAudioToCaller(pcm24) {
    if (!this.asSocket || this.asSocket.destroyed) return;
    const down = resampleInt16(pcm24, XAI_RATE, AS_RATE);
    const buf = int16ToBuf(down);
    // Chunk into 20ms frames (320 bytes @ 8kHz) so Asterisk paces playback.
    for (let off = 0; off < buf.length; off += 320) {
      this.asSocket.write(asFrame(AS_AUDIO, buf.subarray(off, Math.min(off + 320, buf.length))));
    }
  }

  async close(reason) {
    if (this.closed) return;
    this.closed = true;
    log(`[${this.uuid.slice(0, 8)}] closing (${reason})`);
    try { this.engineWs?.close(); } catch {}
    try { this.asSocket?.end(); } catch {}
    for (const id of [this.mediaChannelId, this.channelId]) {
      if (id) { try { await ari("DELETE", `/channels/${id}`); } catch {} }
    }
    if (this.bridgeId) { try { await ari("DELETE", `/bridges/${this.bridgeId}`); } catch {} }
    sessions.delete(this.uuid);
  }
}

// ── Pydent backend: who answers + which engine ────────────────────────────────
async function resolveCall(dialedNumber) {
  const res = await fetch(`${CFG.pydentBase}/api/telephony/ari-resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: CFG.connectorToken, ws: CFG.ws, dialedNumber }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `resolve failed (${res.status})`);
  return data;
}

async function runTool(agentId, name, args) {
  try {
    const res = await fetch(`${CFG.pydentBase}/api/agents/tool-exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, name, args }),
    });
    const data = await res.json().catch(() => ({}));
    return data.result ?? data.error ?? "Tool failed.";
  } catch (e) {
    return `Error: ${e.message || "could not reach Pydent to run the action."}`;
  }
}

// ── xAI Grok realtime bridge ─────────────────────────────────────────────────
function startXaiBridge(sess, cfg) {
  const url = `${cfg.url}?model=${encodeURIComponent(cfg.model)}`;
  const ws = new WebSocket(url, [`xai-client-secret.${cfg.token}`]);
  sess.engineWs = ws;
  sess.agentId = cfg.agentId;

  ws.on("open", () => {
    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        voice: cfg.voice,
        instructions: cfg.instructions,
        turn_detection: { type: "server_vad" },
        audio: {
          input: {
            format: { type: "audio/pcm", rate: XAI_RATE },
            transport: "json",
            ...(cfg.languageHint ? { transcription: { language_hint: cfg.languageHint } } : {}),
          },
          output: { format: { type: "audio/pcm", rate: XAI_RATE }, transport: "json" },
        },
        ...(Array.isArray(cfg.tools) && cfg.tools.length ? { tools: cfg.tools } : {}),
      },
    }));
    if (cfg.greetFirst && cfg.firstMessage) {
      ws.send(JSON.stringify({
        type: "conversation.item.create",
        item: { type: "force_message", role: "assistant", interruptible: true, content: [{ type: "output_text", text: cfg.firstMessage }] },
      }));
    }
    log(`[${sess.uuid.slice(0, 8)}] xAI session open (${cfg.agentName})`);
  });

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const type = msg?.type ?? "";
    if (type === "response.output_audio.delta" || type === "response.audio.delta") {
      sess.responseActive = true;
      if (typeof msg.delta === "string") {
        const pcm = bufToInt16(Buffer.from(msg.delta, "base64"));
        sess.sendAudioToCaller(pcm);
      }
    } else if (type === "response.done") {
      sess.responseActive = false;
    } else if (type === "input_audio_buffer.speech_started") {
      // Barge-in: caller started talking — stop the model's current answer.
      if (sess.responseActive) { try { ws.send(JSON.stringify({ type: "response.cancel" })); } catch {} sess.responseActive = false; }
    } else if (type === "response.function_call_arguments.done") {
      const name = msg?.name ?? msg?.function?.name ?? "";
      const callId = msg?.call_id ?? msg?.callId ?? "";
      let args = {};
      try { args = typeof msg?.arguments === "string" ? JSON.parse(msg.arguments) : (msg?.arguments ?? {}); } catch {}
      const result = await runTool(sess.agentId, name, args);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: result } }));
        ws.send(JSON.stringify({ type: "response.create" }));
      }
    } else if (type === "error") {
      const detail = String(msg?.error?.message ?? msg?.message ?? "");
      if (!/cancel|no active response|not.*active/i.test(detail)) warn(`[${sess.uuid.slice(0, 8)}] xAI:`, detail);
    }
  });

  ws.on("close", () => { void sess.close("xai closed"); });
  ws.on("error", (e) => { warn(`[${sess.uuid.slice(0, 8)}] xAI ws error:`, e.message); });
}

// Feed 8kHz AudioSocket audio up to xAI as 24kHz PCM16.
function feedCallerAudioToXai(sess, slinBuf) {
  const ws = sess.engineWs;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const up = resampleInt16(bufToInt16(slinBuf), AS_RATE, XAI_RATE);
  ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: int16ToBuf(up).toString("base64") }));
}

// ── Vapi bridge: hand the call to Vapi over SIP, let Vapi run the agent ───────
async function bridgeToVapi(sess, cfg) {
  // Originate a SIP leg to Vapi's inbound SIP with the assistant selected, and
  // bridge the caller to it. Vapi handles audio + the agent, so we don't touch
  // media here. (Vapi inbound SIP: sip:<assistantId>@sip.vapi.ai.)
  const bridge = await ari("POST", "/bridges", { type: "mixing" });
  sess.bridgeId = bridge.id;
  await ari("POST", `/bridges/${bridge.id}/addChannel`, { channel: sess.channelId });
  const endpoint = `PJSIP/${cfg.vapiAssistantId}@vapi`; // requires a "vapi" PJSIP endpoint on the box (see README)
  const leg = await ari("POST", "/channels", { endpoint, app: CFG.stasisApp, appArgs: "vapi-leg" });
  sess.mediaChannelId = leg.id;
  // The leg joins the bridge when it enters Stasis (StasisStart handler).
  sess._pendingVapiLeg = leg.id;
  log(`[${sess.uuid.slice(0, 8)}] bridging caller to Vapi (${cfg.vapiAssistantId})`);
}

// ── AudioSocket TCP server ────────────────────────────────────────────────────
function startAudioSocketServer() {
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let sess = null;
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      // Parse as many complete frames as we have.
      while (buf.length >= 3) {
        const type = buf.readUInt8(0);
        const len = buf.readUInt16BE(1);
        if (buf.length < 3 + len) break;
        const payload = buf.subarray(3, 3 + len);
        buf = buf.subarray(3 + len);
        if (type === AS_UUID) {
          const uuid = payload.toString("hex").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
          sess = sessions.get(uuid) || [...sessions.values()].find((s) => s.uuid === uuid) || null;
          if (sess) { sess.asSocket = socket; log(`[${uuid.slice(0, 8)}] AudioSocket attached`); }
          else warn(`AudioSocket UUID with no session: ${uuid}`);
        } else if (type === AS_AUDIO && sess && !sess.closed) {
          if (sess.engineWs) feedCallerAudioToXai(sess, Buffer.from(payload));
        } else if (type === AS_HANGUP || type === AS_ERROR) {
          if (sess) void sess.close("audiosocket " + (type === AS_ERROR ? "error" : "hangup"));
        }
      }
    });
    socket.on("close", () => { if (sess) void sess.close("audiosocket closed"); });
    socket.on("error", () => {});
  });
  server.listen(CFG.asPort, CFG.asHost, () => log(`AudioSocket server on ${CFG.asHost}:${CFG.asPort}`));
}

// ── ARI events (Stasis) ───────────────────────────────────────────────────────
async function onStasisStart(ev) {
  const chan = ev.channel;
  const args = ev.args || [];

  // The Vapi leg we originated re-enters Stasis — just add it to its bridge.
  if (args[0] === "vapi-leg") {
    for (const s of sessions.values()) {
      if (s._pendingVapiLeg === chan.id && s.bridgeId) {
        await ari("POST", `/bridges/${s.bridgeId}/addChannel`, { channel: chan.id });
        s._pendingVapiLeg = null;
        return;
      }
    }
    return;
  }

  const dialed = chan.dialplan?.exten || chan.caller?.number || "";
  log(`StasisStart: channel ${chan.id}, dialed "${dialed}"`);
  await ari("POST", `/channels/${chan.id}/answer`);

  let cfg;
  try {
    cfg = await resolveCall(dialed);
  } catch (e) {
    warn("resolve failed:", e.message);
    try { await ari("POST", `/channels/${chan.id}/play`, { media: "sound:vm-goodbye" }); } catch {}
    await ari("DELETE", `/channels/${chan.id}`);
    return;
  }

  const uuid = crypto.randomUUID();
  const sess = new Session(uuid, chan.id);
  sessions.set(uuid, sess);

  if (cfg.engine === "vapi") {
    try { await bridgeToVapi(sess, cfg); } catch (e) { warn("vapi bridge failed:", e.message); await sess.close("vapi failed"); }
    return;
  }

  // xAI path: bridge caller ↔ externalMedia (AudioSocket) ↔ xAI realtime.
  try {
    const bridge = await ari("POST", "/bridges", { type: "mixing" });
    sess.bridgeId = bridge.id;
    await ari("POST", `/bridges/${bridge.id}/addChannel`, { channel: chan.id });
    const media = await ari("POST", "/channels/externalMedia", {
      app: CFG.stasisApp,
      external_host: `${CFG.asHost}:${CFG.asPort}`,
      format: "slin",
      encapsulation: "audiosocket",
      transport: "tcp",
      connection_type: "client",
      direction: "both",
      data: uuid,
    });
    sess.mediaChannelId = media.id;
    await ari("POST", `/bridges/${bridge.id}/addChannel`, { channel: media.id });
    startXaiBridge(sess, cfg);
  } catch (e) {
    warn("xai bridge setup failed:", e.message);
    await sess.close("setup failed");
  }
}

async function onStasisEnd(ev) {
  const id = ev.channel?.id;
  for (const s of sessions.values()) {
    if (s.channelId === id || s.mediaChannelId === id) { await s.close("stasis end"); return; }
  }
}

function connectAriEvents() {
  const wsUrl = CFG.ariUrl.replace(/^http/, "ws") + `/ari/events?app=${encodeURIComponent(CFG.stasisApp)}&api_key=${encodeURIComponent(`${CFG.ariUser}:${CFG.ariSecret}`)}`;
  const ws = new WebSocket(wsUrl);
  ws.on("open", () => log(`ARI events connected (app=${CFG.stasisApp})`));
  ws.on("message", async (raw) => {
    let ev;
    try { ev = JSON.parse(raw.toString()); } catch { return; }
    try {
      if (ev.type === "StasisStart") await onStasisStart(ev);
      else if (ev.type === "StasisEnd") await onStasisEnd(ev);
    } catch (e) { warn("event handler error:", e.message); }
  });
  ws.on("close", () => { warn("ARI events closed — reconnecting in 3s"); setTimeout(connectAriEvents, 3000); });
  ws.on("error", (e) => { warn("ARI events error:", e.message); });
}

// ── boot ──────────────────────────────────────────────────────────────────────
function requireCfg() {
  const missing = [];
  if (!CFG.ariSecret) missing.push("ARI_SECRET");
  if (!CFG.connectorToken) missing.push("PYDENT_CONNECTOR_TOKEN");
  if (!CFG.ws) missing.push("PYDENT_WS");
  if (missing.length) { console.error("Missing required env:", missing.join(", ")); process.exit(1); }
}

requireCfg();
log(`Pydent ARI connector starting — ARI ${CFG.ariUrl}, app ${CFG.stasisApp}, Pydent ${CFG.pydentBase}`);
startAudioSocketServer();
connectAriEvents();

process.on("SIGINT", async () => { for (const s of sessions.values()) await s.close("shutdown"); process.exit(0); });
process.on("SIGTERM", async () => { for (const s of sessions.values()) await s.close("shutdown"); process.exit(0); });
