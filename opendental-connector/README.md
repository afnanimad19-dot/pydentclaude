# Pydental Connector (local middleware)

Runs **inside the clinic**, next to Open Dental. It exposes ONLY doctor slots and
appointment booking to the Pydental gateway. **No patient/clinical data leaves the
clinic** — this server never returns diagnoses, notes, x-rays, insurance, etc.

```
Pydental (cloud) → /api/opendental/* gateway → Cloudflare Tunnel → THIS middleware → Open Dental API → Open Dental DB
```

## Test it now — NO Open Dental, NO keys needed (mock mode)
The connector ships with an in-memory **mock** so you can verify the whole booking chain before any
clinic is involved:
```
npm install
npm run smoke           # boots in mock mode + checks health→auth→doctors→slots→book→reschedule→cancel
npm run start:mock      # or run it as a live server in mock mode (CLINIC_API_KEY=test npm run start:mock)
```
Mock mode is on when `OPEN_DENTAL_MOCK=1` **or** when the Open Dental keys are unset. Nothing is
persisted — it's purely for safe end-to-end testing.

## Setup (real clinic)
1. Install Node.js 18+ on the clinic server.
2. `cp .env.example .env` and fill in:
   - `CLINIC_API_KEY` — a long random string (put the SAME value in Pydent → Settings → Open Dental).
   - Set `OPEN_DENTAL_MOCK=0` and fill `OPEN_DENTAL_BASE_URL`, `OPEN_DENTAL_DEVELOPER_KEY`, `OPEN_DENTAL_CUSTOMER_KEY`.
3. Edit `src/mappings.js` with your real provider numbers, operatory numbers and CDT codes.
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
