# Pydent ARI Connector

The on-prem service that makes a clinic's **existing landline** answer with a
Pydent AI voice agent. It runs on the same small box as Asterisk (Raspberry Pi /
mini-PC) and bridges calls between Asterisk and the AI engine.

```
Landline → clinic PBX (D-Link) → SIP → Asterisk → Stasis(pydent-agent)
      → THIS connector → audio ↔ AI engine (xAI Grok / Vapi)
```

The connector talks to Asterisk over **local ARI** (REST + WebSocket events) and
takes call audio over **AudioSocket** (external media). It makes only **outbound**
connections to Pydent — the cloud never reaches into the clinic network, no
inbound ports are opened, and the ARI credentials never leave the Pi. It does
**not** register as a SIP phone — Asterisk owns the telephony, this connector
owns the AI logic.

**Pairing:** in Pydent → Phone Numbers → *Clinic Landline (on-prem)*, save the
profile. Pydent shows a one-time **device token** — that pairs this box to the
clinic account. Put it in `.env` as `PYDENT_DEVICE_TOKEN`. The connector then
authenticates every outbound call with it, and a **heartbeat** every 15s makes
the landline show **Box online** in the dashboard (no cloud→Pi test needed).

The engine is chosen per workspace by your **Settings → voice engine** switch
(xAI Grok or Vapi); the connector asks Pydent which one to use on each call, so
you flip engines in the dashboard, not here.

---

## 1. Prerequisites on the box

- Asterisk 18+ with ARI enabled and the `chan_audiosocket` / `res_audiosocket`
  modules (bundled in modern Asterisk).
- Node.js 18 or newer.
- The clinic's PBX (e.g. D-Link DVX-2005F) already trunking the landline into
  Asterisk as a SIP peer that lands in the `[from-dlink]` context.

## 2. Enable ARI (`/etc/asterisk/ari.conf`)

```ini
[general]
enabled = yes

[pydent]
type = user
password = <a-strong-secret>          ; this is ARI_SECRET
```

And make sure the HTTP server is on (`/etc/asterisk/http.conf`):

```ini
[general]
enabled = yes
bindaddr = 127.0.0.1
bindport = 8088
```

Reload: `asterisk -rx "core reload"`.

## 3. Dialplan handoff (`/etc/asterisk/extensions.conf`)

Send inbound landline calls into the Stasis app (replace `123` / the pattern
with the DID or extension your D-Link delivers):

```asterisk
[from-dlink]
exten => _X.,1,Answer()
 same => n,Stasis(pydent-agent)
 same => n,Hangup()
```

Reload: `asterisk -rx "dialplan reload"`.

## 4. Install & run the connector

```bash
sudo mkdir -p /opt/pydent-ari-connector
sudo cp -r ari-connector/* /opt/pydent-ari-connector/
cd /opt/pydent-ari-connector
npm install
cp .env.example .env      # then edit .env (see below)
node index.mjs            # test in the foreground first
```

`.env` values:

| var | what |
|-----|------|
| `ARI_URL` | local, usually `http://127.0.0.1:8088` |
| `ARI_USER` / `ARI_SECRET` | the `ari.conf` user above (stays on the Pi) |
| `STASIS_APP` | must match `Stasis(pydent-agent)` and the name in the Pydent form |
| `PYDENT_BASE` | your Pydent URL, e.g. `https://pydent.ai` |
| `PYDENT_DEVICE_TOKEN` | the device token Pydent showed when you saved the landline profile |
| `AUDIOSOCKET_HOST` / `AUDIOSOCKET_PORT` | where Asterisk reaches this process (127.0.0.1:9092 when co-located) |

Nothing needs setting on the Pydent side — the device token is created when you
save the landline profile and is all the box needs to authenticate outbound.

## 5. Run as a service

```bash
sudo cp pydent-ari-connector.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pydent-ari-connector
journalctl -u pydent-ari-connector -f
```

## 6. Verify from the dashboard

In Pydent → **Phone Numbers**, the clinic landline card shows **Box online** once
this connector starts sending heartbeats (within ~15s). If it stays **Box
offline**, check `journalctl -u pydent-ari-connector -f` — usually the device
token or `PYDENT_BASE` is wrong, or the box has no internet.

Then call the landline. The assigned agent answers.

---

## How a call reaches the engine (LiveKit or Vapi)

Both engines take calls over **SIP**, so the box never touches audio: on each
call the connector asks Pydent which engine/agent applies and dials a SIP leg
to it, bridging the caller. Define one PJSIP endpoint per engine on the box
(`/etc/asterisk/pjsip.conf`):

```ini
[livekit]
type=endpoint
context=from-dlink
disallow=all
allow=ulaw,alaw,opus
aors=livekit
[livekit]
type=aor
contact=sip:<project>.sip.livekit.cloud        ; Pydent → Settings → LiveKit → Test connection shows this
[livekit]
type=identify
endpoint=livekit
match=<project>.sip.livekit.cloud

[vapi]
type=endpoint
context=from-dlink
disallow=all
allow=ulaw,alaw
aors=vapi
[vapi]
type=aor
contact=sip:sip.vapi.ai
```

Then in Pydent → Phone Numbers → Add → **LiveKit (SIP)**, add the clinic's
landline number: Pydent creates the LiveKit inbound trunk + dispatch rule for the
chosen agent, and shows the SIP address. Put the box's public IP in *Allowed
source IPs* (or set the SIP auth username/password and mirror them in the
`[livekit]` endpoint's `outbound_auth`) so LiveKit accepts the box's calls.

Switch the engine in Pydent → Settings → Voice engine; the box follows.

## Notes

- Bookings/reschedules/cancels and email run through Pydent's
  `/api/agents/tool-exec` inside the engine agent — so a phone booking lands on
  the Pydent calendar + Google Calendar just like chat.
- Call logs: LiveKit calls appear in Pydent → Call Logs tagged **LiveKit**
  (worker transcript + LiveKit webhook); Vapi calls via the Vapi server URL.
