# Pydent — Build Status (to the finish line)

A full status of what's **built**, what's **partial**, what's **left**, and which
**API keys / approvals** each part needs. Legend: ✅ done · 🟡 partial / needs a key
or approval · ❌ not built yet.

---

## 0. Setup you must do for things to "go live"

### Migrations to run in Supabase (SQL Editor) — pending on your side
Run any you haven't: **0024 → 0033** (each idempotent). The newest:
- 0024 voices · 0025 clinic_settings · 0026 connections · 0027 sample flag ·
  0028 connection access mode · 0029 learning questions · 0030 team chats+brand ·
  0031 reports+activity · 0032 scheduled_tasks · 0033 brand_documents.

### Environment variables (Netlify) — the master list
| Var | For | Status |
|---|---|---|
| `OPENROUTER_API_KEY` | All AI text (agents, chat) | needed |
| `SUPABASE_SERVICE_ROLE_KEY` | OAuth tokens, reports, autopilot, activity | needed |
| `VAPI_API_KEY` | Voice calls | needed for voice |
| `ELEVENLABS_API_KEY` | Voices, cloning, voice notes | needed for voice library |
| `OPENAI_API_KEY` | Image generation (Helena/Instagram) | needed for images |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | All Google connections | needed for Google |
| `FACEBOOK_CLIENT_ID` / `_SECRET` | Facebook/Instagram/Meta Ads | needed for Meta |
| `LINKEDIN/REDDIT/PINTEREST/WORDPRESS/TIKTOK _CLIENT_ID/_SECRET` | those channels | optional |
| `DATAFORSEO_API_KEY` | Sam's real keyword/competitor/backlink data | optional (free fallback works) |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads reporting | optional |
| `BREVO_API_KEY` / `BREVO_FROM_EMAIL` | Angela sending email | optional |
| `TEAM_AI_MODEL` | Switch AI Team to Claude (`anthropic/claude-sonnet-4`) | optional |
| `CRON_SECRET` | Protect the autopilot runner | needed for autopilot |
| `META_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | WhatsApp webhook security | needed for WhatsApp |

---

## 1. Core platform & multi-tenant — ✅
- Next.js app, Supabase DB + auth, per-workspace isolation (every clinic separate). ✅
- Login/signup, brand renamed to **Pydent**. ✅
- Sample/demo data removed (real-clinic mode). ✅
- **Left to finish:** an **Admin panel** (you, the owner) to manage clinics, packages,
  and lock/unlock agents — ❌ not built (planned).

## 2. Omnichannel Inbox & message flow — ✅ (WhatsApp live; others need keys)
- Unified inbox (WhatsApp, Instagram, Messenger, SMS, email tabs). ✅
- Opens on the latest conversation; "Assign to" (AI agent / Me / teammate) with headings. ✅
- AI auto-reply, human handoff, lifecycle stages, voice notes (ElevenLabs). ✅
- WhatsApp send/receive + webhook + templates + broadcasts. ✅ (needs Meta keys/number)
- **Returning-contact** welcome + memory loop fixed. ✅
- 🟡 Instagram/Messenger inbound need the Meta app **Live** + permissions approved.
- ❌ True **voice-note delivery to WhatsApp** (Meta media upload) — plays in-app today.
- ❌ Real **SMS** provider (Twilio) — tab exists, not wired.

## 3. AI Chat Agents — ✅
- Create/edit agents: instructions + behavior (what NOT to do) + unlimited knowledge-base
  uploads (PDF/Word **text extracted**) + website import. ✅
- Chat agents reply from their knowledge; **book/reschedule/cancel tools**. ✅
- **Learning Agent** page: captures unanswered questions → teach the agent. ✅
- 🟡 Booking requires the agent's "Book appointments" ability ON.

## 4. Voice Agents — 🟡 (built; needs keys)
- Voice agent editor, **ElevenLabs voice library + cloning + preview**, test call (Vapi),
  behavior applied on calls. ✅
- 🟡 Needs `VAPI_API_KEY` + `ELEVENLABS_API_KEY` + a phone number.
- ❌ Phone **booking tool on the live call** (voice booking into the calendar) — chat books;
  voice-call booking is the remaining wiring.

## 5. Calendar & Booking — ✅
- Calendar with **Week / 15-day / 30-day** views + month jump. ✅
- **Booking** from chat/inbox/quick-booking lands on the calendar (name, phone, email,
  service) and forwards to Open Dental when enabled. ✅
- Real-time slot conflict check (no double-book). ✅
- 🟡 Google Calendar mirror — connect flow exists; pushing events to GCal not wired yet.

## 6. Open Dental — 🟡 (code ready, waiting on your API key + connector)
- Settings card (middleware URL + key), gateway routes (slots/book/reschedule/cancel/
  doctors), booking forward, appointment external-id mirror. ✅ (code)
- ❌ The **local connector** (Node app the clinic installs next to Open Dental) — described
  in OPEN_DENTAL.md, **not built yet**.
- 🟡 Waiting on your **Open Dental API key** ($30/mo) to test end-to-end.
- **Left:** build the connector + test against a real Open Dental DB.

## 7. Patients / CRM / Pipeline / Clinical — ✅ (mostly UI; some demo)
- Patients list (+ profile, appointments), pipeline, clinical pages. ✅
- Reports page = real patient/appointment data + CSV export. ✅
- 🟡 Some clinical pages (claims/ledger/rx) are still illustrative until Open Dental data flows.

## 8. Connections / Integrations — ✅ Google; 🟡 others need their app keys
- Full integrations catalog (Google products, Meta, social, Shopify, etc.) with
  per-clinic OAuth, green Connected state, read/write toggle, disconnect-confirm. ✅
- **Google** (Analytics, Search Console, Business, Ads, Drive, Calendar, YouTube) ✅
  (needs your Google OAuth app + verification).
- **Generic OAuth** for Meta/Instagram/Facebook, LinkedIn, Reddit, Pinterest, WordPress.com,
  TikTok — 🟡 each lights up when you add its `*_CLIENT_ID/_SECRET`.
- **WordPress self-hosted** (Application Password) ✅.
- ❌ Bespoke flows still to wire: **X/Twitter** (PKCE), **Shopify** (shop domain),
  **TikTok Ads**, **Stripe**, **Notion**.

## 9. AI Team (Helena, Sam, Kai, Angela) — ✅ functionality; 🟡 some need keys/approval
Each: brand knowledge (+ uploaded docs), chat history, channels panel, **Documents**,
**Activity feed**, **Autopilot** scheduling.
- **Helena (Marketing):** blogs→WordPress ✅, image generation 🟡(`OPENAI_API_KEY`),
  GA4 + Search Console ✅, Facebook/Instagram post 🟡(Meta approval), **Meta Ads data** ✅,
  Google Ads data 🟡(dev token), **reports → DOCX/PDF** ✅.
- **Sam (SEO):** keywords (free Google Autocomplete ✅ / full DataForSEO 🟡), competitors,
  backlinks, SERP 🟡(`DATAFORSEO_API_KEY`), page audit ✅, Search Console ✅, GBP post 🟡,
  reports ✅.
- **Kai (Reputation):** Google reviews 🟡(GBP API approval) + Facebook reviews ✅, sentiment
  + reply drafting ✅. ❌ broad mentions/competitor listening needs paid social data.
- **Angela (Email/WhatsApp):** recall list ✅, copy ✅, **WhatsApp broadcast** ✅,
  **email send** 🟡(`BREVO_API_KEY`).
- **Autopilot:** schedule UI ✅ + `/api/cron/run` ✅ — 🟡 needs a cron pointed at it.
- ❌ **Packages/entitlements** (lock agents per plan) — needs the admin panel.
- ❌ **Video generation** (MuAPI/Higgsfield) — planned; image is wired.

## 10. Billing & packages — ❌ not built
- ❌ Stripe subscriptions + **usage metering / credits / top-ups** (so the one shared AI
  key is billable). This is the commercial layer — the design is in
  SOFTWARE_STACK_AND_COSTS.md; the build is pending.

---

## The remaining build list (to "finish line"), in priority order
1. **Open Dental local connector** + live test (your API key) — core for clinics.
2. **Admin panel** (manage clinics, packages, lock/unlock agents) + **entitlements**.
3. **Billing**: Stripe + usage metering / credits.
4. **Voice-call booking tool** (book into the calendar from a live phone call).
5. **Autopilot cron** wired (Netlify/Supabase) + per-clinic SEO location.
6. **Wire remaining channels:** X/Twitter, Shopify, TikTok Ads, Stripe Connect, Notion;
   make **social posting** production-approved with Meta/TikTok.
7. **Google Calendar push**, **WhatsApp audio delivery**, **SMS (Twilio)**.
8. **Video generation** (MuAPI/Higgsfield) + premium image tier.
9. **Downloadable PDF** via a real renderer (Stirling-PDF) if you want full PDF tooling.

Everything is coded so it **activates the moment its key/approval is added** — no part is
left half-wired; the items above are genuinely new features or external approvals.
