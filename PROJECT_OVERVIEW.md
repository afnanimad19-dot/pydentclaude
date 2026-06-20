# Pydental — Project Overview, Flows & Roadmap

A single planning doc: what's built, how the flows work, the Open Dental scope, and
what's left. (Companion docs: `AGENT_GUIDE.md`, `VOICE_AGENT_VAPI.md`,
`OPEN_DENTAL.md`, `OPEN_DENTAL_SETUP.md`, `GO_LIVE.md`.)

## Stack
- **App:** Next.js (App Router) on **Netlify**.
- **Data/Auth:** Supabase (Postgres + Auth). Multi-tenant — each clinic = a workspace.
- **Channels:** Meta (WhatsApp Cloud API, Instagram, Messenger), one webhook.
- **Chat AI:** OpenRouter (GPT/Claude/etc.) with tool-use for booking.
- **Voice AI:** Vapi (assistants/voices/numbers) — see `VOICE_AGENT_VAPI.md`.
- **Open Dental:** cloud gateway → Cloudflare Tunnel → local connector (clinic).

## What's DONE
- **Multi-tenant accounts:** signup creates an empty workspace; data is scoped per clinic.
- **Omnichannel inbox** (Respond.io-style): WhatsApp + Instagram + Messenger live,
  channel tabs, lifecycle rail, assign-to-me / hand-back, scroll-to-latest.
- **Live WhatsApp/IG/Messenger:** inbound stored, auto-reply via the channel's
  default agent, replies sent from the correct clinic's token.
- **Lead auto-capture:** every new contact becomes a patient (name, phone, source).
- **Chat agents:** name, type, language, model, **Instructions** + **Behavior** boxes,
  knowledge-base upload, abilities (book/reschedule/cancel), channels, status.
- **Agent booking tools:** `get_available_slots`, `book_appointment`,
  `reschedule_appointment`, `cancel_appointment` → write to Calendar (and Open
  Dental when connected).
- **Returning-session logic:** after ~15 min idle, the agent welcomes back and
  offers continue / follow-up / new booking.
- **Pipeline** on live leads (New Lead / Hot Lead / Payment / Customer), stage agents.
- **Broadcasts:** template approval (submit + sync to Meta), audience = patient
  folders, send now / schedule (cron), delivered/read tracking.
- **Reports** on live data; **Calendar**; **Settings** (Profile/Connections/Channels/
  WhatsApp/Tags) with a **Webhook activity** diagnostics panel.
- **Open Dental gateway** + **local connector** scaffold (`opendental-connector/`).

## Core flows
**1. Inbound message → reply → booking**
```
Patient sends WhatsApp/IG/Messenger message
  → Meta webhook → store conversation + message (per workspace)
  → auto-capture contact as a patient (lead)
  → if a channel default agent is set & not human-handled:
       agent replies (Instructions + Behavior + Knowledge base)
       if it agrees a time → get_available_slots → book_appointment
         → Calendar appointment created (+ Open Dental if connected)
  → reply sent from the clinic's own token; shows in Inbox + on the patient's phone
```

**2. Broadcast**
```
Templates → create → Submit to Meta → (wait) Sync status → Approved
New broadcast wizard: name → audience (folder) → approved template → send now / schedule
  → Cloud API sends to each patient → delivered/read tracked via status webhook
```

**3. Open Dental booking (when connected)**
```
Agent → /api/opendental/slots|book|reschedule|cancel (gateway)
  → Cloudflare Tunnel → clinic connector → Open Dental API (local) → Open Dental DB
Only scheduling + the appointment id come back; no clinical data leaves the clinic.
```

## Open Dental — scope mapping (your list)
| Scope item | Status |
|---|---|
| Open Dental (cloud-accessible) integration configuration | ✅ gateway + Settings connection card |
| Appointment workflow configuration | ✅ book/reschedule/cancel via agent + Calendar mirror |
| Lead routing workflows | ✅ auto-capture → pipeline; channel→agent routing |
| Scheduling logic configuration | ✅ live slots (Open Dental or local calendar fallback) |
| Testing & validation | ⏳ needs the clinic's API keys + test DB (your step) |
| **Local-server scenario** (data stays local) | ✅ connector + Cloudflare Tunnel design (`OPEN_DENTAL_SETUP.md`) |

> You don't have the Open Dental API/Customer key yet — that's fine. Everything works
> on the **local-calendar fallback** today; the moment the connector + keys are in,
> the same agent flow reads/writes real Open Dental with no app change.

## What's LEFT (prioritised)
1. **Voice agents (Vapi):** voice **preview** (hear before selecting), call
   **transcripts** + **recordings** (live + saved), and storing call outcomes to the
   patient/calendar. Needs a Vapi webhook in Pydental — see `VOICE_AGENT_VAPI.md`.
2. **Website chat widget** using the same booking gateway.
3. **HubSpot / Zoho sync** of lead/marketing data only (never clinical).
4. **PDF/Word knowledge-base extraction** (today: txt/md/csv/json fully read).
5. **Strict RLS hardening** (isolation is app-level now; tighten for scale).
6. **Open Dental connector productionising:** find-or-create patient → real PatNum,
   confirm slot endpoint params per Open Dental version.

## Run order for migrations (Supabase SQL editor)
`0001 → 0017` in order. If you ever hit an **ON CONFLICT (42P10)** error, you ran a
later migration before an earlier one — re-run from the missing one. The app no
longer depends on ON CONFLICT for config saves.
