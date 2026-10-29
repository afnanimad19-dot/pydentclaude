# Pydental Connector (local middleware)

Runs **inside the clinic**, next to Open Dental. It exposes ONLY doctor slots and
appointment booking to the Pydental gateway. **No patient/clinical data leaves the
clinic** — this server never returns diagnoses, notes, x-rays, insurance, etc.

```
Pydental (cloud) → /api/opendental/* gateway → Cloudflare Tunnel → THIS middleware → Open Dental API → Open Dental DB
```

## Safety model
- **Explicit mock mode:** the in-memory mock runs ONLY with `OPEN_DENTAL_MOCK=1`. In live
  mode, missing Open Dental credentials are a **startup failure** — there is no silent
  fall-back to mock data, before or after an API failure.
- **Read-only by default:** `OPEN_DENTAL_READ_ONLY` defaults to on; `/create-appointment`,
  `/reschedule-appointment` and `/cancel-appointment` return 403 without touching Open
  Dental until the clinic explicitly sets `OPEN_DENTAL_READ_ONLY=0`.
- **Strict ids:** unknown doctor/service ids are rejected (400) — the first doctor or
  service is never silently selected.
- `CLINIC_API_KEY` (16+ chars) is required in every mode; the `x-api-key` check is
  timing-safe; credentials and patient details never appear in logs, health, or errors.

## Test it now — NO Open Dental, NO keys needed (mock mode)
```
npm install
npm test                # security + validation test suite (no network, no Open Dental)
npm run smoke           # mock-mode end-to-end: health→auth→doctors→slots→book→reschedule→cancel
npm run start:mock      # run it as a server in mock mode (CLINIC_API_KEY=<16+ chars> required)
```
Nothing is persisted in mock mode — it's purely for safe end-to-end testing.

## Setup (clinic TEST database first — never straight to production)
1. Install Node.js 18+ on the clinic server.
2. `cp .env.example .env` and fill in:
   - `CLINIC_API_KEY` — a long random string (put the SAME value in Pydent → Settings → Open Dental).
   - Set `OPEN_DENTAL_MOCK=0` and fill `OPEN_DENTAL_BASE_URL`, `OPEN_DENTAL_DEVELOPER_KEY`, `OPEN_DENTAL_CUSTOMER_KEY`.
   - Leave `OPEN_DENTAL_READ_ONLY=1` until read-only verification against the TEST database passes.
3. Edit `src/mappings.js` with your real provider numbers, operatory numbers and CDT codes
   (verify them with `GET /providers` and `GET /operatories` on your Open Dental API first).
4. `npm install && npm start` → listens on `http://localhost:4000`.

## Expose it safely (outbound-only, no open ports)
Install Cloudflare Tunnel (`cloudflared`) on the clinic server and map a hostname
to `localhost:4000`:
```
cloudflared tunnel create pydental
cloudflared tunnel route dns pydental clinic-api.yourdomain.com
cloudflared tunnel run --url http://localhost:4000 pydental
```
Then in **Pydental → Settings → Open Dental**, set the URL to
`https://clinic-api.yourdomain.com` and the key to your `CLINIC_API_KEY`.

## Endpoints
```
GET  /health                  (no auth) → { ok, mode: "mock"|"live" }
GET  /doctors
GET  /services
POST /available-slots         { doctorId, serviceId, date }
POST /create-appointment      { name, phone, email, doctorId, serviceId, datetime, consent }
POST /reschedule-appointment  { appointmentId, datetime }
POST /cancel-appointment      { appointmentId }
```

## Before going live
- Test against an **Open Dental test database** first (or stay in mock mode until you're ready).
- ✅ Find-or-create patient (by phone, else create minimal name+phone) is implemented in `opendental.js`.
- Verify the Slots/Appointments/patient-search paths/params match **your** Open Dental version.

See **`../OPEN_DENTAL_AND_COMPLIANCE.md`** for the UAE health-data residency rules (DHA/DoH/MOHAP) and
the full deploy guide.
