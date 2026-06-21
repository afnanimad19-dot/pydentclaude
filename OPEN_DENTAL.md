# Open Dental Integration — Architecture & Plan (DHA/MOH-safe)

This captures the goal and the secure design for connecting Pydent to a clinic's
**Open Dental** without putting patient clinical data on the cloud. (Our stack is
Next.js + Supabase + Netlify, driven from Claude — wherever the source doc says
"Lovable", read "Pydent".)

## 1. Declared objective

Let the AI chat/voice agents and the website **see live doctor time-slots and
book/reschedule/cancel appointments in Open Dental in real time** — while **all
patient clinical data stays on the clinic's local server**, per DHA/MOH rules.
Open Dental is the **single source of truth** for patients, schedules and clinical
records. The cloud only ever sees scheduling + lead/marketing data.

## 2. The rule: what may leave the clinic vs what must stay local

**Stays LOCAL (never in our cloud / Supabase):**
diagnosis, medical history, treatment plans, insurance details, clinical notes,
X-rays, full patient profile, the Open Dental SQL database.

**May be stored in the cloud (Pydent / Supabase) — minimum necessary only:**
lead name, phone, email, marketing source/campaign, appointment **request status**,
and for a confirmed booking: booking id, doctor id, service id, slot date/time,
status, created-at. **Nothing clinical.**

## 3. Secure architecture (outbound-only, no exposed DB)

```
Pydent (cloud)                         Clinic (local network)
  AI agent / website / inbox
        │  HTTPS
        ▼
  Gateway  (Supabase Edge Function OR a Next /api route)
   - checks API key / allowed origin
   - validates booking input, rate-limits, logs status only
        │  HTTPS (Cloudflare Tunnel — outbound only)
        ▼
  Local Middleware  (Node.js on the clinic server, localhost:4000)
   - maps service → CDT procedure code, doctor → providerId/operatory
        │
        ▼
  Open Dental REST API  →  Open Dental local DB
```

Key safety properties:
- **Cloudflare Tunnel** (or VPN): the clinic server dials **out**; no inbound ports,
  no public IP, Open Dental never exposed to the internet.
- The cloud **never** touches the Open Dental DB directly — only the gateway, which
  only forwards to the local middleware.
- We persist **only booking metadata**, never clinical data.

If local access is impossible, the competitor's **Option A** (a dedicated on-prem
connector, one-time fee) or **Option B** (dedicated deployment inside the clinic)
apply — both are just richer versions of "the middleware runs inside the clinic."

## 4. The endpoint contract (gateway ↔ middleware)

```
GET  /doctors                      → [{ providerId, name, services[] }]
GET  /services                     → [{ serviceId, name, durationMin }]
POST /available-slots  { doctorId, serviceId, date }      → { slots: ["10:00", ...] }
POST /create-appointment { name, phone, email, doctorId, serviceId, datetime, consent }
                                                          → { ok, appointmentId }
POST /reschedule-appointment { appointmentId, datetime }  → { ok }
POST /cancel-appointment { appointmentId }                → { ok }
```

Open Dental provides the matching APIs (Appointments **GET Slots**, **POST
Appointments**, reschedule/cancel) — the middleware translates our calls to those.

## 5. What we must build in Pydent (this app) — requirements

1. **Open Dental connection settings (per workspace):** `clinic_api_url`,
   `clinic_api_key` (the Cloudflare Tunnel URL of the clinic's middleware + a shared
   secret). Stored per-clinic, like the WhatsApp config. Empty by default → feature off.
2. **Booking gateway** in our app: `/api/opendental/slots`, `/api/opendental/book`,
   `/reschedule`, `/cancel` — these validate + forward to the clinic middleware using
   that workspace's URL/key. (Or deploy them as Supabase Edge Functions; same logic.)
3. **Agent booking action:** when a chat/voice agent (or the website widget) takes a
   booking, it calls the gateway, offers real slots, creates the appointment in Open
   Dental, then **mirrors only the booking metadata** into our Calendar + marks the
   lead's pipeline status. The contact is already auto-captured as a patient/lead.
4. **Calendar reflects Open Dental bookings** (read-back of slot/status), so booked /
   rescheduled / cancelled all show on our Calendar — without pulling clinical data.
5. **The local middleware** is delivered separately (a small Node.js app the clinic
   installs) with `mappings.js` (service→CDT code, doctor→providerId/operatory). It is
   NOT part of the cloud app and never ships clinical data out.

## 6. Build order

1. OpenDental connection settings card + per-workspace storage. *(small)*
2. Gateway API routes in Pydent that forward to the clinic middleware. *(small)*
3. The local middleware starter (separate repo/folder, Node + Open Dental API). *(medium)*
4. Wire the agent + website widget to call slots/book; mirror booking → Calendar +
   pipeline status. *(medium)*
5. Testing against an Open Dental **test database** before any live clinic.

Until a clinic enables this, Pydent runs fully standalone (our own Calendar +
patients). When they're ready, only this connector is added — no patient data ever
leaves their building.

---

## 7. Tools, services & pricing (everything Pydent runs on)

This is the full list of external tools/APIs Pydent uses, what each is for, and what
it costs. **All AI/voice/messaging prices are usage-based — verify the current rate
on each vendor's pricing page before quoting a client, as they change.** Prices below
were last checked **June 2026** (USD).

### A. The clinic's dental system

| Tool | What it's for | Cost |
|---|---|---|
| **Open Dental** (PMS) | The clinic's source of truth — patients, schedule, clinical records. Stays on their local server. | **US: $199/mo per location** (first 12 months), then **$149/mo**. **+$20/mo per provider** beyond the first 3. Canada $164→$137; other countries $89/mo; developing countries free. |
| **Open Dental API** | The interface our local middleware uses to read slots and book/reschedule/cancel. | **$30/mo per location** — covers all API permissions except Payments, PayPlans and Special. Billed only once a key is assigned **and enabled**; stops automatically if the key is disabled. Requires Developer Portal access (email `vendor.relations@opendental.com`, 1–3 business days). |
| **Open Dental one-time / optional** | Setup, training, eServices. | Post-conversion setup $160 (2-hr); online training $80/hr; on-site training $4,325/day; eServices (texting, web sched, etc.) $5–$165/mo per location — **all optional**, not required for our integration. |

> So a typical single-location clinic already on Open Dental adds **just the $30/mo API
> fee** to use our booking integration. The $149–199/mo support fee is their existing
> Open Dental bill, not something we add.

### B. Our cloud platform (what *we* run Pydent on)

| Tool | What it's for | Cost |
|---|---|---|
| **Netlify** | Hosting the Next.js app. | Free tier works to start; **Pro ~$19/mo per member** for production. |
| **Supabase** | Our cloud database + auth (leads, bookings metadata, agents — **no clinical data**). | Free tier to start; **Pro $25/mo per project** once live. |
| **Cloudflare Tunnel** | Secure outbound-only link from the clinic middleware to us (no exposed DB/ports). | **Free.** |

### B2. On the clinic's premises (the local setup — required for booking)

To read live slots and write appointments into Open Dental **without exposing the
clinic's database**, a small piece runs **locally at the clinic**. This is the
"middleware" — it's the only thing that has to be installed on-site, and it never
ships clinical data to the cloud (it only answers slot/book/reschedule/cancel calls).

| Tool / requirement | What it's for | Cost |
|---|---|---|
| **Pydent Connector (local middleware)** | The Node.js app we build and the clinic installs next to Open Dental. Holds `mappings.js` (service→CDT code, doctor→providerId/operatory), talks to the Open Dental API locally, and exposes only the booking actions over the tunnel. | **No license fee — it's our software, included.** Delivered as a separate small install. |
| **Host machine** | A PC/server on the clinic's network that stays on, running the connector beside Open Dental (often the existing Open Dental server or a small always-on PC). | **Usually $0** — runs on hardware the clinic already has. Only a cost if they choose to add a dedicated mini-PC (~$150–400 one-time). **No GPU needed.** |
| **Node.js runtime** | Runs the connector. | **Free** (open source). |
| **Cloudflare Tunnel agent** (`cloudflared`) | The outbound-only connector that links the local middleware to our gateway — no open ports, no static IP needed. | **Free.** |
| **Open Dental API key** | Enables the connector to call Open Dental locally (see section A). | **$30/mo per location** (listed above — this is the one recurring fee for the local link). |

> **In plain terms:** the only *required* on-site setup is installing our free
> connector + free Cloudflare Tunnel on a machine the clinic already has, and enabling
> the **$30/mo** Open Dental API key. No new server, no GPU, no extra monthly software
> license for the middleware itself.

### C. AI, voice & messaging (usage-based)

| Tool | What it's for | Cost |
|---|---|---|
| **OpenRouter** | Chat-agent replies (routes to GPT-4o / Claude, etc.). | **No base fee — pay per token**, passed through at model price (e.g. GPT-4o-mini ≈ $0.15 / $0.60 per 1M input/output tokens). A typical chat reply is a fraction of a cent. |
| **Vapi** | Runs the live phone calls (telephony + STT + LLM + TTS orchestration). | **~$0.05/min platform fee** + pass-through of the STT/LLM/TTS it uses → roughly **$0.07–0.15/min all-in**. Phone numbers ≈ **$2/mo** each. |
| **ElevenLabs** | Voice library + custom voice cloning, and the TTS voice on live calls (`provider: 11labs`). | Free tier 10k chars/mo; **Creator $22/mo** (100k chars ≈ ~2 hrs speech); Pro $99/mo; Business $330/mo. Instant voice cloning included from the $5 Starter plan up. Billed per character of speech generated. |
| **Deepgram** | Speech-to-text transcription on calls. | Pay-as-you-go ≈ **$0.0043/min** (Nova-2). Usually **billed through Vapi**, not separately. |
| **Meta WhatsApp Cloud API** | WhatsApp (and Instagram/Messenger) inbox channels. | The API itself is **free**; Meta charges **per conversation** by country and category (service vs. marketing/utility templates) — varies a lot by region. |

#### ElevenLabs — which plan, and "Creative vs Agents vs API"

These are **not three separate products you buy** — they're three surfaces of **one
ElevenLabs account**. A single paid subscription unlocks all of them:
- **Creative** = text-to-speech, voice library, voice cloning (what our preview /
  voice-note / custom-voice features use).
- **Agents** (Conversational AI) = full voice agents that can hold a real conversation
  and even **take phone calls** (via a Twilio number or SIP).
- **API** = developer access to both of the above (this is what our backend calls).

**Which subscription to buy:** start on **Creator (~$22/mo)** — it includes API access +
instant/professional voice cloning (~100k characters ≈ ~2 hrs of speech). Move to
**Pro (~$99/mo)** as call/voice volume grows; **Scale/Business** lower the per-unit cost
at high volume. The **Agents/calling** usage is billed **per minute (~$0.08–0.10/min**,
verify current rate) on top, and you can plug in your own LLM key to cut that.

**Vapi vs ElevenLabs Agents (the "say bye to Vapi?" question):**
- **Keep Vapi (today's setup):** Vapi handles the phone line and already speaks with our
  ElevenLabs voices. Least work — it's built and working.
- **Switch calling to ElevenLabs Agents:** one vendor for voices *and* calls, often nicer
  voice quality on the call. But it's a **rebuild** of the calling layer (new API, phone
  numbers move to Twilio/SIP under ElevenLabs).
- **Recommendation:** keep Vapi for now + ElevenLabs **API** for voices; revisit moving
  calls to ElevenLabs Agents later once volume justifies the migration.

**For other customers (multi-tenant):** same as everything else — either *we* hold one
ElevenLabs account and create each clinic's voices/agents under it via the API, or a
clinic brings its own ElevenLabs key. No clinic ever touches Netlify.

### D. What this means in practice (rough monthly, 1 location)

- **Fixed/ours:** Netlify ~$19 + Supabase ~$25 = **~$44/mo** (can start on free tiers).
- **Local setup (theirs):** our free connector + free Cloudflare Tunnel on an existing
  machine — **$0/mo** (optional one-time mini-PC ~$150–400 if they want dedicated hardware).
- **Open Dental side (theirs):** existing support fee + **$30/mo API** to enable booking.
- **Voice add-on:** ElevenLabs ~$22/mo + Vapi call minutes (~$0.10/min) + ~$2/mo number.
- **Chat AI:** cents per conversation via OpenRouter.
- **WhatsApp:** Meta's per-conversation fee (region-dependent).

There is **no GPU/CPU server cost** — voice cloning and TTS are fully managed by
ElevenLabs/Vapi, so we never host or rent a GPU.

Sources: [Open Dental fees](https://www.opendental.com/site/fees.html) ·
[Open Dental API permissions](https://www.opendental.com/site/apipermissions.html) ·
[Open Dental API setup](https://www.opendental.com/site/apisetup.html). Verify
ElevenLabs / Vapi / Supabase / Netlify / OpenRouter / Meta pricing on each vendor's
own pricing page before quoting — these are usage-based and change.

### E. Optional / situational tools (only if you turn the feature on)

| Tool | When you need it | Cost |
|---|---|---|
| **Domain + DNS** (e.g. Namecheap, Cloudflare, Hostinger) | A custom domain for the app + website (e.g. `app.yourclinic.com`). | ~$10–15/yr per domain. |
| **Email sender** (Resend / SendGrid / Postmark) | The email automations (welcome series, follow-ups) if you send from your own domain. | Free tiers ~3k emails/mo; paid from ~$15–20/mo. |
| **Twilio** (or another SMS provider) | Native SMS as a channel, or the phone number behind Vapi calls. | Number ~$1–2/mo + ~$0.0075 per SMS segment (US). |
| **Stripe** | If *you* bill clinics for the software (subscriptions). | No monthly fee; ~2.9% + 30¢ per charge. |

### F. Hosting — where to deploy (and can we use Hostinger?)

**The Pydent app is a Next.js app with server routes** (`/api/*`), so it needs a host
that runs Node server-side rendering + serverless functions — not plain static/shared
hosting.

- **Recommended: Netlify or Vercel.** Both natively support Next.js, give serverless
  functions for our `/api` routes, env-var management (where the `ELEVENLABS_API_KEY`,
  `VAPI_API_KEY`, etc. go), HTTPS and CI from Git out of the box. This is the smoothest
  path and what the project is wired for. Vercel is made by the Next.js team; Netlify is
  what we currently target — either is fine.
- **Hostinger:** their **shared/“web hosting”** plans are built for PHP/WordPress and
  are **not suitable** for a Next.js SSR app. Their **VPS or Cloud** plans *can* run it,
  but you’d manage Node, a process manager (PM2), Nginx, SSL and deploys **manually** —
  more work and more to maintain. So: use Hostinger only if you specifically want a VPS
  you control; otherwise **Netlify/Vercel is the professional, lower-effort choice**.
  Hostinger is, however, perfectly good for a **separate marketing site/domain** or to
  host the **local connector** on a clinic-side VPS if a clinic has no on-site machine.
- **The local connector** (section B2) does **not** go on Netlify/Hostinger cloud — it
  runs **inside the clinic** next to Open Dental, reached only via Cloudflare Tunnel.

> Rule of thumb: **app → Netlify/Vercel**, **clinic connector → on-site (or a small
> clinic-side VPS)**, **clinical data → never leaves the clinic.**

---

## 8. What you can do with it — scenarios

Once the pieces above are connected, here are the main things the system can do:

1. **Inbound call → booked appointment.** A patient calls the clinic number → Vapi
   answers in your chosen ElevenLabs voice → the agent reads live Open Dental slots
   through the connector → books the appointment → it appears on the Calendar. No staff
   needed for routine bookings.
2. **WhatsApp/Instagram lead → AI books or qualifies.** A lead messages on WhatsApp →
   the assigned chat agent answers from the knowledge base, offers real open slots, and
   books — or hands off to a human if it’s unsure.
3. **Staff voice note in your own voice.** When a teammate takes over a chat (Assign to
   me), they can type a reply and send it as a **voice note** spoken in a **cloned clinic
   voice** (e.g. the dentist’s) — personal, on-brand, without recording each time.
4. **Custom clinic brand voice everywhere.** Record ~30s once → that voice is used for
   phone calls *and* voice notes, so every patient touchpoint sounds like your clinic.
5. **Missed-call / after-hours text-back.** Out-of-hours calls or missed calls trigger a
   WhatsApp/SMS follow-up so leads aren’t lost overnight.
6. **Reschedule / cancel self-service.** Patients message or call to move an appointment;
   the agent updates Open Dental and the Calendar reflects it — no double-booking.
7. **Lifecycle + routing.** Every conversation gets a stage (New → Hot → Payment →
   Customer) and is routed to the right AI agent or teammate from one “Assign to” menu.
8. **Reactivation / recall campaigns.** Outbound voice or message campaigns to patients
   due for a checkup, using the same agents and voices.

All of the above keep clinical data on the clinic’s server — only scheduling and
lead/marketing metadata is ever stored in the cloud.
