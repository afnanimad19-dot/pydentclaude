# Open Dental + UAE Health-Data Compliance — full build & deploy guide

_Branch: `claude/vigilant-heisenberg-o5g281`. This is the authoritative guide for the Open Dental
integration and how Pydent stays on the right side of UAE health-data residency rules (DHA / DoH /
MOHAP). It replaces scattered notes in `OPEN_DENTAL.md` / `OPEN_DENTAL_SETUP.md`._

> ⚖️ **Not legal advice.** The rules below are summarised as we understand them and the
> architecture is built to satisfy them, but a UAE healthcare-data lawyer should sign off before
> going live with a real clinic.

---

## 0. TL;DR

- **Clinical/medical data never touches the cloud.** It stays inside the clinic, in Open Dental, on
  the clinic's own server. Pydent's cloud has **no table** for charts, x-rays, ledger, documents,
  insurance or diagnoses, and the UI hides them.
- **Only appointment *scheduling* crosses the wire** — and only the minimum fields (name, phone,
  the chosen time, a treatment *label*). That goes to a **small connector you install at the clinic**,
  over an **outbound-only encrypted tunnel** — no inbound ports, no medical record.
- **It is fully built and testable today without a real Open Dental** — run the connector in **mock
  mode** (`npm run smoke`) and the whole booking chain works. Swapping to a live clinic is a config
  change, not new code.
- **What's left** is per-install field mapping (provider/operatory/procedure codes), packaging the
  connector as a Windows service, and bundling the tunnel — all doable now, none needs the clinic's API.

---

## 1. The UAE rules (what we must obey)

| Regulator / law | Who it covers | The rule that matters to us |
|---|---|---|
| **Federal Law No. 2 of 2019** (ICT in Health Fields) | All health data generated in the UAE | Health data **must be stored & processed inside the UAE**; it may **not be transferred/stored outside** the State without explicit authority approval. This is the big one. |
| **DHA** (Dubai Health Authority) | Clinics licensed in Dubai | Follow DHA health-data & info-security standards; patient records stay controlled by the licensed facility. |
| **DoH Abu Dhabi** + **ADHICS** | Clinics in Abu Dhabi | **ADHICS** = mandatory healthcare cyber-security controls; Malaffi is the Abu Dhabi HIE. |
| **MOHAP** | Northern Emirates clinics | Equivalent health-data controls. |
| **UAE PDPL** — Federal Decree-Law No. 45 of 2021 | All personal data | Lawful basis + consent for personal data (names, phone, email), data-subject rights, security. |
| **DHCC / DIFC / ADGM** (free zones) | Clinics inside those zones | Their own data-protection regimes (e.g. DHCC health-data regulation, DIFC DP Law) — same principles, stricter paperwork. |

**Plain-English takeaway:** the **medical record** (clinical data, x-rays, ledger, documents,
insurance, diagnoses) **must live in the UAE / on the clinic's own system** and must not be shipped to a
US/EU cloud. Names/phone/email used to *book an appointment or send marketing* are "personal data" (still
regulated, needs consent) but are **not** the medical record.

---

## 2. How Pydent complies (the architecture)

```
  PATIENT ─▶ (WhatsApp / call / web)
              │
        ┌─────▼─────────────────────────────┐         CLOUD (Netlify + Supabase)
        │  Pydent app                        │   stores: contacts (name/phone/email),
        │  /api/opendental/*  (gateway)      │   appointment time + treatment LABEL,
        └─────┬──────────────────────────────┘   conversations, marketing.  NO medical record.
              │  outbound HTTPS, x-api-key, only scheduling fields
              │  (Cloudflare Tunnel — no inbound ports opened)
        ┌─────▼─────────────────────────────┐         CLINIC SERVER (in the UAE)
        │  Pydent Connector (Node.js)        │   the ONLY thing that talks to Open Dental
        │  /available-slots /create-appt …   │
        └─────┬──────────────────────────────┘
              │  localhost only
        ┌─────▼─────────────────────────────┐
        │  Open Dental + MySQL (the chart)   │   ◀── clinical data NEVER leaves here
        └────────────────────────────────────┘
```

### Data classification — what lives where
| Data | Example | Where it lives | Crosses to cloud? |
|---|---|---|---|
| **Medical record** | diagnoses, perio charts, x-rays, treatment plans, ledger, insurance, signed forms / documents | Open Dental, clinic server (UAE) | ❌ **Never** |
| **Scheduling minimum** | name, phone, chosen time, treatment **label** ("Cleaning") | passes through to book; mirrored as an appointment row | ⚠️ only these fields, only to book |
| **Contact / CRM** | name, phone, email, conversation history, lifecycle, marketing consent | Supabase (cloud) | ✅ (personal data — needs consent, not the medical record) |
| **Documents/x-rays** | imaging, scanned forms | Open Dental, clinic server | ❌ **Never** (Pydent has no document store for clinical files) |

**Why this is compliant:** the health record stays in the UAE on the clinic's machine; only the few
fields needed to *book a slot* move, and they move to a connector **also inside the clinic**, not to our
cloud. The cloud only holds CRM/contact data, which is permitted under PDPL with consent.

> Hardening recommendations (for the lawyer/clinic sign-off): (a) host the Supabase project in the
> **closest compliant region** and sign a DPA; (b) capture **patient consent** for the contact data
> used in booking/marketing; (c) keep the treatment field a **label**, never clinical detail; (d) the
> clinic keeps full Open Dental backups locally.

---

## 3. What is BUILT today (verified)

**Pydent side (cloud) — done:**
- `src/lib/opendental-gateway.ts` — `getOdConfig()` + `odForward()` validate and forward scheduling
  calls to the clinic connector with the shared `x-api-key`. Never stores clinical data.
- Routes `src/app/api/opendental/{slots,book,reschedule,cancel,doctors}/route.ts`.
- `src/lib/booking-server.ts` — after a chat/voice booking, forwards to Open Dental **only when the
  clinic has it enabled** (`od?.enabled`), and stores the returned external id. Booking still succeeds
  on our calendar if the connector is down.
- **Settings → Open Dental** card (`opendental-config.tsx`): clinic middleware URL + API key + Enable +
  **Test connection**. The direct legacy client (`src/lib/opendental.ts`) is **not used anywhere** —
  there is no cloud path that pulls the clinical roster.

**Connector side (clinic) — done & testable now:**
- `opendental-connector/` — Express service exposing only `/available-slots`, `/create-appointment`,
  `/reschedule-appointment`, `/cancel-appointment`, `/doctors`, `/services`, `/health`. Shared-secret auth.
- ✅ **Find-or-create patient** implemented (was a TODO) — looks up by phone, else creates a minimal
  patient (name + phone only) to get a PatNum.
- ✅ **Mock mode** (`OPEN_DENTAL_MOCK=1`, or auto when keys are unset) — in-memory slots/appointments so
  the **whole chain is testable with no Open Dental and no clinic keys**.
- ✅ **Smoke test** (`npm run smoke`) — boots the connector and verifies health → auth → doctors →
  slots → book → reschedule → cancel. (Passes today.)

### Test it right now (no clinic, no API keys)
```bash
cd opendental-connector
npm install
npm run smoke          # full chain, mock mode — prints ✓ for each step
# or run it as a server:
CLINIC_API_KEY=test npm run start:mock     # listens on :4000 in mock mode
```
To test it **through the dashboard**: run the connector in mock mode, expose it (e.g. `cloudflared
tunnel --url http://localhost:4000`), paste that URL + the same `CLINIC_API_KEY` into **Settings →
Open Dental**, tick **Enable**, click **Test connection** → it should report the mock doctors. Then book
from a chat/voice agent and watch it succeed end to end.

---

## 4. What is LEFT to build for Open Dental (and none of it needs the clinic's live API)

1. **Per-install mapping** — `opendental-connector/src/mappings.js` currently has example doctors,
   operatories and CDT procedure codes. For a real clinic you replace these with their actual ProvNum /
   OpNum / procedure codes (a 10-minute config per clinic, not code).
2. **Confirm the live Open Dental endpoints** — the REST paths/params in `opendental.js` (Slots query,
   patient search, appointment create/update) vary slightly by Open Dental version; verify against the
   clinic's install and tweak. The mock proves the shape; this aligns it to their server.
3. **Windows-service packaging** — wrap the connector with `node-windows` / NSSM so it auto-starts and
   stays running, plus a one-page installer/README for clinic IT. (Buildable now.)
4. **Bundle the tunnel** — ship a `cloudflared` config (named tunnel) so the connector gets a stable
   HTTPS URL with no open ports. (Buildable now.)
5. **Optional**: container-status polling for long writes; a tiny local admin page to edit mappings.

> Everything in §4 can be built and tested **today** using mock mode + a Cloudflare quick-tunnel —
> we only need a real clinic for the final live acceptance test (§5 step 6), which you said is last.

---

## 5. Step-by-step: deploy to a real clinic (when you're ready)

1. **Enable the API in Open Dental** (Setup → Advanced → API) and generate a **Developer Key** +
   **Customer Key**.
2. **Install the connector** on the clinic server: copy `opendental-connector/`, `npm install`, fill
   `.env` (set `OPEN_DENTAL_MOCK=0`, the base URL, developer/customer keys, and a long random
   `CLINIC_API_KEY`).
3. **Map their clinic** in `src/mappings.js` (real ProvNum / OpNum / procedure codes).
4. **Run it as a Windows service** so it auto-starts (NSSM / `node-windows`).
5. **Install `cloudflared`** and run a named tunnel to `http://localhost:4000`; you get a stable HTTPS
   URL with no open ports.
6. **Connect in Pydent** → Settings → Open Dental: paste the tunnel URL + the same `CLINIC_API_KEY`,
   tick **Enable**, click **Test connection**. Then book a test appointment from a chat/voice agent →
   it appears in Open Dental's schedule, and Open Dental's open slots show when the agent offers times.
7. **Off switch:** unticking Enable (or stopping the connector) instantly cuts the link; Pydent keeps
   working on its own calendar.

---

## 6. The rest of the roadmap — what we can build NOW (no clinic API) vs what needs keys

### ✅ Buildable now without ANY clinic API/keys (so testing "just works")
- **Open Dental connector** completion (mappings, Windows service, tunnel bundle) — uses mock mode.
- **Inbox**: template picker, conversation search, archive/delete.
- **Pipeline persistence**: make manual deals/stages survive reload (new table).
- **Reports**: date-range filter + revenue/no-show/conversion (data already in Supabase).
- **Clinical ledger/claims edit-delete + printable statement** (operates on our own demo/data layer).
- **Billing/Admin/packages** scaffolding (entitlements), **RLS hardening**.
- These all run against Supabase + mock data, so a PR can be tested with no external accounts.

### 🔑 Needs a key/connection/verification to go live (code already done — see STATUS §10)
- Anything that actually *sends* or *reads* a third party: WhatsApp/IG (Meta verification), Gmail/Calendar
  (Google), Brevo (clinic key), Twilio (clinic creds), Vapi (✅ have). The **code** is built; these just
  need the account connected or the platform approved.

### Recommended next build order
1. Finish the **Open Dental connector** packaging (mock-testable end to end).
2. **Inbox polish** (template picker + search) — highest-value remaining UX.
3. **Pipeline persistence**, then **richer reports**, then **clinical edit/delete**.
4. **Open Dental live acceptance test** at one clinic (last, as agreed).
5. **Billing / Admin / packages**.

---

## 7. When the PR lands — how to verify each piece

| Feature | How to test without a real clinic |
|---|---|
| **Open Dental chain** | `cd opendental-connector && npm run smoke` → all ✓. Or run `npm run start:mock`, tunnel it, connect in Settings → Open Dental → Test connection → book from an agent. |
| **Scheduled report workflow** | Build a workflow with a "Scheduled" trigger + "Email a report" step, set Live, hit `/api/cron/run?key=…` → digest email is created/sent. |
| **Instagram auto-publish** | Schedule a post for a past time, hit `/api/cron/ig-publish` (needs Meta + WordPress connected to actually post; otherwise it records Failed with the reason). |
| **Per-clinic Twilio / Brevo** | Settings → Connections → connect → send a single SMS / create a Brevo campaign. |
| **Voice number↔agent** | Voice Agents → Voice Agent Settings → assign a number → it PATCHes Vapi (needs `VAPI_API_KEY`). |
| **CRUD everywhere** | Contacts search/edit/delete/import/export; Instagram/Campaign/Template edit-delete; Calendar confirm/reschedule/cancel — all work against Supabase. |

---

_Compliance summary: clinical data stays in the UAE on the clinic's server (Open Dental); only minimal
scheduling fields cross, to a connector that's also in the clinic, over an outbound-only encrypted
tunnel. The integration is built and testable today in mock mode; going live with a clinic is config +
the §5 steps, not new code. Get a UAE healthcare-data lawyer to sign off before the first live clinic._
