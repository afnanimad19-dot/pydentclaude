# Open Dental — Step-by-Step Connection Guide

How to connect a clinic's **local** Open Dental to Pydental so the AI agents can
read live doctor slots and book/reschedule/cancel — **without any patient data
leaving the clinic**. (Architecture & rationale: `OPEN_DENTAL.md`.)

```
Patient (WhatsApp / website)
        │
   Pydental (cloud)  ──►  /api/opendental/*  (gateway, validates + forwards)
        │                         │  HTTPS, outbound-only
        │                         ▼
        │                 Cloudflare Tunnel  (clinic dials OUT — no open ports)
        │                         │
        │                         ▼
        │                 Pydental Connector  (Node.js, localhost:4000, IN the clinic)
        │                         │
        │                         ▼
        └────────────────►  Open Dental API  ──►  Open Dental DB  (stays local)
```

## Part 1 — Get Open Dental ready (clinic IT)
1. Open Dental must be running on the clinic server/network.
2. Enable the **API / eConnector** in Open Dental:
   - Open Dental → **Setup → Advanced Setup → API** (or eConnector). Turn the API on.
   - Note the local API base URL (commonly `http://localhost:30222/api/v1`).
3. Get your **Developer Key** and generate a **Customer Key**:
   - Developer key: from Open Dental's developer portal (one per integrator).
   - Customer key: Open Dental → **Setup → Advanced Setup → API → Add** (per clinic).
   - The connector authenticates as: `Authorization: ODFHIR {DeveloperKey}/{CustomerKey}`.
4. Write down your **provider numbers**, **operatory numbers** and the **CDT procedure
   codes** for each service (cleaning, check-up, etc.). You'll put these in the connector.

## Part 2 — Install the Pydental Connector (on the clinic server)
The connector is in this repo under `opendental-connector/`.
1. Install **Node.js 18+** on the clinic server.
2. Copy the `opendental-connector/` folder onto that server.
3. In that folder: `cp .env.example .env` and fill in:
   - `CLINIC_API_KEY` = a long random string (you'll paste the same value into Pydental).
   - `OPEN_DENTAL_BASE_URL`, `OPEN_DENTAL_DEVELOPER_KEY`, `OPEN_DENTAL_CUSTOMER_KEY`.
4. Edit `src/mappings.js` — replace the demo doctors/services with your real
   provider numbers, operatory numbers and CDT codes.
5. Run it: `npm install && npm start` → it listens on `http://localhost:4000`.
   (Test locally: `curl -H "x-api-key: YOURKEY" http://localhost:4000/doctors`.)

## Part 3 — Expose it safely with Cloudflare Tunnel (no open ports)
1. On the clinic server, install **cloudflared** (Cloudflare Tunnel).
2. Authenticate and create a tunnel:
   ```
   cloudflared tunnel login
   cloudflared tunnel create pydental
   cloudflared tunnel route dns pydental clinic-api.yourdomain.com
   cloudflared tunnel run --url http://localhost:4000 pydental
   ```
3. Now `https://clinic-api.yourdomain.com` securely reaches the connector — the
   clinic only makes **outbound** connections; nothing is exposed to the internet.
   (A VPN instead of Cloudflare Tunnel works too.)

## Part 4 — Connect it in Pydental (cloud)
1. Run migration `0015_opendental_config.sql` and `0016_appointment_external_id.sql`
   in Supabase (once).
2. In Pydental → **Settings → Connections → Open Dental**:
   - **Clinic middleware URL** = `https://clinic-api.yourdomain.com`
   - **Middleware API key** = the same `CLINIC_API_KEY` from the connector's `.env`
   - Tick **Enable Open Dental booking** → **Save** → **Test connection**
     (a green toast with a doctor count means it's working end-to-end).

## Part 5 — Turn on agent booking
1. AI Agents → create/edit a chat agent → enable the abilities **Book / Reschedule /
   Cancel**.
2. Agent Hub → set that agent as the **WhatsApp default** (and Instagram/Messenger).
3. Done. Now when a patient chats:
   - The agent calls **get_available_slots** → offers only real open times.
   - On agreement it calls **book_appointment** → creates it in **Open Dental** and
     mirrors it to the Pydental **Calendar**, linked to the auto-captured contact.
   - "Reschedule"/"cancel" use **reschedule_appointment** / **cancel_appointment**.

## Connecting OTHER software (HubSpot / Zoho / website)
- **Website / booking widget:** point it at the Pydental gateway endpoints
  (`/api/opendental/slots`, `/api/opendental/book`) — never at Open Dental directly.
- **HubSpot / Zoho:** sync **only** marketing/lead data (name, phone, email, source,
  appointment status). Pydental already captures leads; push those statuses to the
  CRM. **Never** sync diagnoses, treatment plans, insurance or notes.

## What stays local vs what's stored
- **Local only (never in cloud):** patient records, treatment, x-rays, notes, insurance.
- **Stored in Pydental/Supabase:** lead name/phone/email/source, and booking metadata
  (doctor, service, date/time, status, the Open Dental appointment id). Nothing clinical.

## Safety checklist
- [ ] Test against an **Open Dental test database** before any live clinic.
- [ ] `mappings.js` has the clinic's real provider/operatory numbers + CDT codes.
- [ ] `CLINIC_API_KEY` matches on both sides and is long/random.
- [ ] Connector reachable only via the tunnel (no inbound ports opened).
