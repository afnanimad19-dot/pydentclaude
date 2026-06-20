# Voice Agents with Vapi — how it works & step-by-step

You're using a **Vapi** API key ("WEPI"). Some advanced voice features live inside
Vapi, so the model is: **build/host the voice assistant in Vapi, point its webhook
at Pydental**, and Pydental stores transcripts/recordings + books appointments.

## How it works (architecture)
```
Patient calls the clinic number (bought in Vapi)
        │
        ▼
   Vapi assistant  (voice, transcriber, model, your script)
        │  webhook (server URL on the assistant)
        ▼
   Pydental  /api/vapi/events
        │
        ├─ store the call: transcript, recording URL, summary, outcome → Call log
        ├─ auto-capture the caller as a patient (phone)
        └─ if the call books → create the appointment (Calendar + Open Dental)
```

Why split it this way: Vapi handles the hard real-time voice/telephony; Pydental
owns the CRM data (patients, calendar, transcripts) and the booking logic — the same
tools the chat agent uses.

## What's already in Pydental
- Creating a Vapi **assistant** from the app (voices Leah, Elliot, Savannah, Rohan,
  Tara are the confirmed-working set), first-message modes, system prompt.
- A **Call log / Voice** screen (currently sample data).

## What needs to be added (the build)
1. **`/api/vapi/events` webhook** — receives Vapi server events:
   - `status-update` (ringing/in-progress/ended) → live session state,
   - `transcript` (partial) → live transcript,
   - `end-of-call-report` → final **transcript**, **recording URL**, **summary**,
     **outcome**.
2. **`voice_calls` table** (per workspace): caller phone, patient_id, direction,
   started_at, duration, transcript, recording_url, summary, outcome.
3. **Call log UI**: list of calls per agent, click → transcript + audio player
   (recorded), plus a "live" indicator for in-progress calls.
4. **Voice preview**: a ▶ button next to each voice that plays the provider's sample
   audio (Vapi voices map to ElevenLabs/PlayHT/etc. sample URLs) so you hear it
   before selecting — not just the name.
5. **Booking from calls**: give the Vapi assistant the same booking tool (Vapi
   "functions") that calls Pydental's `/api/opendental/*` or the calendar booking,
   so a phone booking lands in the Calendar/Open Dental too.

## Step-by-step (operator)
1. **Vapi dashboard → Assistants → New.** Set the model, transcriber and a voice;
   paste the clinic script (same idea as the chat agent's Instructions + Behavior).
2. **Add a tool/function** to the assistant for booking (calls Pydental's booking
   endpoint with name/phone/service/datetime).
3. **Buy a phone number** in Vapi and assign it to the assistant.
4. **Set the assistant's Server URL (webhook)** to
   `https://<your-site>.netlify.app/api/vapi/events` and add a shared secret.
5. In Pydental, set **`VAPI_API_KEY`** (private) in Netlify, and add
   **`VAPI_WEBHOOK_SECRET`** matching step 4.
6. Call the number → after the call, the **Call log** shows the transcript +
   recording + summary, the caller appears in **Patients**, and any booking is on
   the **Calendar**.

## Telephony / cost note (from your spec)
To run AI calling the **client provides** Twilio number / SIP trunk / existing
telecom; all carrier/SIP/minute charges are the client's, billed on usage. Pydental
just configures Vapi against that telephony.

## Status — BUILT
- ✅ `/api/vapi/events` webhook receives `status-update` + `end-of-call-report`.
- ✅ `voice_calls` table (migration 0019) stores transcript, recording URL, summary,
  duration, outcome — scoped to the clinic whose assistant took the call.
- ✅ Caller is auto-captured as a patient (source = voice).
- ✅ **Voice** screen shows the live Call log: a **Live** badge for in-progress calls,
  and per call the **transcript**, **recording player** and **summary** + a link to
  the caller's chart. Polls every 8s.
- ✅ **Voice preview** button in the agent modal (browser TTS sample).

### To turn it on
1. Run migration `0019`. Set `VAPI_API_KEY` (private) in Netlify; optionally
   `VAPI_WEBHOOK_SECRET`.
2. In Vapi → your assistant → **Server URL** = `https://<your-site>.netlify.app/api/vapi/events`
   (and, if you set the secret, send it as header `x-vapi-secret`).
3. So Pydental can match the call to the right agent/clinic, the assistant must be
   the one created/linked from Pydental (we store its Vapi assistant id). Buy a number
   in Vapi and assign it. Call it → after the call the transcript/recording/summary
   appear on the Voice screen.

### Still optional/next
- True Vapi-voice preview (provider sample audio) instead of browser TTS.
- A booking **tool/function** on the Vapi assistant so phone bookings write to
  Calendar/Open Dental (same endpoints the chat agent uses).
