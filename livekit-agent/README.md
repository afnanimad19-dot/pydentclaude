# Pydent LiveKit Worker

The single agent deployment that runs **every** Pydent voice agent on LiveKit.

```
Caller (browser test call, or phone via SIP)
   → LiveKit room  → dispatches "pydent-agent" with {pydentAgentId, ws}
   → this worker fetches that agent's LIVE config from Pydent
   → STT → LLM → TTS with the agent's models/voice/instructions
   → tools (slots / book / reschedule / cancel / email) via Pydent
   → transcript posted to Pydent Call Logs (tagged "LiveKit")
```

**Why one worker instead of one LiveKit agent per Pydent agent?** LiveKit's
no-code Agent Builder has no management API, so Pydent can't push agent copies
into it. Reading the config from Pydent on every call is strictly better: edit
an agent in Pydent (instructions, greeting, knowledge base, STT/LLM/TTS, voice)
and the very next call uses it. Nothing to sync, nothing to drift.

---

## Deploy (one time, ~5 minutes)

1. **Install the LiveKit CLI** and log in:
   ```bash
   brew install livekit-cli        # or: curl -sSL https://get.livekit.io/cli | bash
   lk cloud auth
   ```
2. **Secrets** — copy `.env.example` → `.env` and fill it in:
   - `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` — from LiveKit Cloud → Settings → API keys
   - `PYDENT_BASE` — your Pydent URL
   - `LIVEKIT_WORKER_TOKEN` — generated in Pydent → Settings → Connections →
     LiveKit → **Generate worker token** (copy it here; nothing to set on Netlify)
   - `AGENT_NAME` — `pydent-agent` (must match Pydent → Settings → LiveKit → Agent name)
3. **Create + deploy** from this folder:
   ```bash
   cd livekit-agent
   lk agent create --secrets-file .env
   ```
   This registers the agent, writes `livekit.toml`, builds the Docker image and
   rolls it out on LiveKit Cloud. Later code changes: `lk agent deploy`.
   Check it: `lk agent status` · logs: `lk agent logs`.

4. **In Pydent** → Settings → Connections → **LiveKit**: paste the same URL /
   API key / secret, keep Agent name `pydent-agent`, click **Test connection**.
   Then Settings → **Voice engine** → select **LiveKit**.

5. **Webhook (for live Call Logs)** — LiveKit Cloud → Settings → Webhooks → add
   `https://<your-pydent>/api/livekit/webhook`.

That's it — open any voice agent in Pydent → **Test call**.

## Phone numbers

LiveKit takes calls over SIP. In Pydent → Phone Numbers → **Add → LiveKit
(SIP)**, enter the number and the trunk auth; Pydent creates the inbound trunk
+ dispatch rule and shows the SIP address to point your carrier / PBX at
(`sip:<number>@<project>.sip.livekit.cloud`). The clinic's on-prem Asterisk box
can dial that address directly — no custom audio bridge needed.

## Notes

- Models are LiveKit Inference strings chosen per agent in Pydent (e.g.
  `deepgram/nova-3`, `openai/gpt-4.1-mini`, `inworld/inworld-tts-2` + voice).
  Arabic works with Nova-3 STT + Inworld / Cartesia sonic-3.6 / xai TTS voices.
- Knowledge base is inlined into the instructions (capped at 48k chars).
- Local run for debugging: `python agent.py dev` (uses `.env`).
