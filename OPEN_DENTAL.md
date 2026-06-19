# Open Dental Integration — Architecture & Plan (DHA/MOH-safe)

This captures the goal and the secure design for connecting Pydental to a clinic's
**Open Dental** without putting patient clinical data on the cloud. (Our stack is
Next.js + Supabase + Netlify, driven from Claude — wherever the source doc says
"Lovable", read "Pydental".)

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

**May be stored in the cloud (Pydental / Supabase) — minimum necessary only:**
lead name, phone, email, marketing source/campaign, appointment **request status**,
and for a confirmed booking: booking id, doctor id, service id, slot date/time,
status, created-at. **Nothing clinical.**

## 3. Secure architecture (outbound-only, no exposed DB)

```
Pydental (cloud)                         Clinic (local network)
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

## 5. What we must build in Pydental (this app) — requirements

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
2. Gateway API routes in Pydental that forward to the clinic middleware. *(small)*
3. The local middleware starter (separate repo/folder, Node + Open Dental API). *(medium)*
4. Wire the agent + website widget to call slots/book; mirror booking → Calendar +
   pipeline status. *(medium)*
5. Testing against an Open Dental **test database** before any live clinic.

Until a clinic enables this, Pydental runs fully standalone (our own Calendar +
patients). When they're ready, only this connector is added — no patient data ever
leaves their building.
