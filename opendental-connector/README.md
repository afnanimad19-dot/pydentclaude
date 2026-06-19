# Pydental Connector (local middleware)

Runs **inside the clinic**, next to Open Dental. It exposes ONLY doctor slots and
appointment booking to the Pydental gateway. **No patient/clinical data leaves the
clinic** — this server never returns diagnoses, notes, x-rays, insurance, etc.

```
Pydental (cloud) → /api/opendental/* gateway → Cloudflare Tunnel → THIS middleware → Open Dental API → Open Dental DB
```

## Setup
1. Install Node.js 18+ on the clinic server.
2. `cp .env.example .env` and fill in:
   - `CLINIC_API_KEY` — a long random string (put the SAME value in Pydental → Settings → Open Dental).
   - `OPEN_DENTAL_BASE_URL`, `OPEN_DENTAL_DEVELOPER_KEY`, `OPEN_DENTAL_CUSTOMER_KEY`.
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
GET  /doctors
GET  /services
POST /available-slots         { doctorId, serviceId, date }
POST /create-appointment      { name, phone, email, doctorId, serviceId, datetime, consent }
POST /reschedule-appointment  { appointmentId, datetime }
POST /cancel-appointment      { appointmentId }
```

## Before going live
- Test against an **Open Dental test database** first.
- Implement find-or-create patient (by name+phone) in `createAppointment` to get a real PatNum.
- Verify the Slots/Appointments endpoint paths/params match your Open Dental version.
