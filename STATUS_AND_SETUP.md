# Pydent — Status, Setup & Next Steps

_Last updated: this session. Branch: `claude/vigilant-heisenberg-o5g281`._

This is the single source of truth for: **what's built, what works end-to-end, what's
only UI so far, what's left, the subscriptions/keys you need, where each key goes
(Pydent vs Netlify), and how Open Dental works locally.**

---

## 1. What we've built (this project)

A multi-tenant SaaS for dental clinics:
- **AI chat agents** (WhatsApp / Instagram / Messenger) that answer + book appointments
- **AI voice agents** (phone) with advanced call settings, live booking, call logs, campaigns
- **CRM** — contacts, pipeline, calendar, workflows automation, reports
- **AI Team** (Helena = marketing, Sam = SEO, Kai = reputation, Angela = email/WhatsApp)
- **Email + SMS** sending, **broadcasts**, **integrations** (Google, Meta, etc.)
- **Open Dental** integration design (clinical data stays on the clinic's local server)

---

## 2. Status legend

- ✅ **Done & wired** — the backend actually works; only needs the relevant key/connection to go live.
- 🟡 **Built, key/approval blocked** — code is complete; waiting on an API key or provider approval.
- 🟠 **UI only / partial** — you can fill it in and save, but the real backend action isn't wired yet.
- ❌ **Not built**.

---

## 3. ✅ Done & working end-to-end (backend wired)

| Area | What works | Needs to go live |
|---|---|---|
| **Chat agents** | Create/edit (Prompt Config: Identity/Tasks/Style Guardrails + KB uploads + website import), auto-reply with booking tools, Learning agent | `OPENROUTER_API_KEY` ✅ in |
| **Voice agents** | Editor + Advanced Settings (VAD, turn detection, noise, AMD, limits, privacy, post-call extraction) → synced to Vapi; test call | `VAPI_API_KEY` ✅ in |
| **Voice-call booking** | Live call books/reschedules/cancels → Calendar (+ Open Dental forward); captures name/phone/email/treatment/fee + source | `VAPI_API_KEY` ✅ |
| **Call Logs** | Paginated list (From/To/Direction/Duration/Status/Campaign/Agent/Recording/Summary) + detail page (timeline + tool-call cards + recording) | populated by real calls |
| **Campaigns** | Agent + number + contact list; calls auto-tagged; Call Logs Campaign column/filter | — |
| **Contacts** | List + detail modal, bulk select/import/export, country-flag phone picker, voice-only filter | — |
| **Workflows runner** | Executes message / wait / condition / handoff / action; triggers from new WhatsApp conversation + on booking + Test-run | cron for "wait" steps; channel connected for sends |
| **Email** | Real composer "Send now" → sends via clinic's **Gmail** (or Brevo) | Connect Gmail (or `BREVO_API_KEY`) |
| **SMS** | Real composer send + inbound webhook → inbox | `TWILIO_*` + Twilio webhook |
| **AI Team** | All four agents with real tools (blogs→WordPress, GA4/Search Console, reviews, email/WhatsApp); each stays in its lane | per-tool keys (see §6) |
| **Pipeline** | Live WhatsApp leads by lifecycle stage; drag between stages; stage→agent handover (money figures removed) | — |
| **Calendar & booking** | Week/15/30-day views; bookings from chat/voice/manual land here; no double-book | — |
| **WhatsApp inbox** | Inbound + outbound, auto-reply, assign to human, broadcasts (template submit/sync) | clinic WhatsApp number + tokens (in Pydent) |
| **Multi-tenant connections** | Per-clinic Google / Gmail OAuth (popup), stored per workspace | `GOOGLE_OAUTH_CLIENT_ID/SECRET` ✅ in |

---

## 4. 🟠 Built but the real functionality is NOT fully wired yet

> These let you fill in / save options, but the backend doesn't yet perform the
> real-world action. **This is the honest "looks done but isn't fully connected" list.**

1. **Phone-number provider forms (Ziwo / Maqsam / Go Auto Dial / Vocalcom)** — the form
   **saves the credentials/config** to the database, but there is **no live API integration**
   that actually provisions or routes calls through those providers. Today the live phone
   handshake is completed in **Vapi** (SIP/BYO). Real Ziwo/Maqsam/etc. provisioning = TODO.
2. **Instagram publishing** — the content calendar **saves posts to the DB**, but it does
   **not actually publish to Instagram** on schedule. (Helena can post via the Meta tool once
   the Meta app is Live; scheduled auto-publish is not wired.)
3. **Google Calendar push** — the Google Calendar connection exists, but **bookings are not
   yet pushed to Google Calendar** (they go to our Calendar + Open Dental only).
4. **WhatsApp voice-note / audio delivery** — voice notes **play in the dashboard** but are
   **not delivered to WhatsApp** via Meta's media API.
5. **Workflow "Add to pipeline" action** — currently logs/minimal; it does not yet create a
   full pipeline deal record (message / wait / condition / handoff / set-status DO work).
6. **Campaign outbound dialer** — campaigns organise + tag calls, but do **not place outbound
   calls** automatically (no auto-dialer yet).
7. **A few advanced voice VAD micro-params** (activation threshold, prefix padding, min-speech)
   are saved + shown, but Vapi only applies the subset it exposes (timeouts, turn detection,
   limits, privacy, extraction all apply).
8. **Mailchimp** — connection card only; **no campaign send**.
9. **Reports** — patient/appointment numbers are real; **ad/SEO charts need their data keys**.
10. **Test-call inline booking** — booking works on the **saved/synced** Vapi assistant; the
    in-browser quick "Test call" (unsynced fallback) doesn't carry the booking tools.

---

## 5. ❌ Not built yet (remaining roadmap)

1. **Open Dental local connector** (the on-prem app) + live test — see §8. _Doing this last on purpose._
2. **SMS auto-reply** (AI answers inbound texts like it does WhatsApp).
3. **Connectors:** X/Twitter (PKCE), Shopify (shop domain), TikTok Ads, Stripe Connect, Notion — catalog cards only.
4. **Billing / credits / Admin panel / packages-entitlements** (lock features per plan) — _deliberately last._
5. **Video generation** (MuAPI/Higgsfield).
6. **Strict RLS hardening** (isolation is app-level today).

---

## 6. Subscriptions & tools — what you need and why

> "Have it" = you already have a subscription/key. Most of these are **pay-as-you-go**, not fixed monthly.

### Required platforms (the SaaS itself runs on these)
| Service | What it's for | Plan & rough cost | Have? |
|---|---|---|---|
| **Netlify** | Hosting the web app + serverless API routes | **Free** to start; **Pro ≈ $19/mo per member** when you need more build minutes / function calls / bandwidth. (There's no $9 Netlify tier — $19 Pro is the one.) | applying now |
| **Supabase** | Postgres database + Auth | **Free** (500 MB DB, 50k monthly users — fine to launch); **Pro ≈ $25/mo** for production (daily backups, no auto-pause, more storage) | have |
| **Domain name** | e.g. `pydent.app` | ~$10–15/yr (optional; Netlify gives a free `*.netlify.app`) | optional |

### AI / channel services (pay-as-you-go)
| Service | What it's for | Cost | Have? |
|---|---|---|---|
| **OpenRouter** | All AI text (chat agents, AI Team) **and now image generation** | pay per token; add ~$10–20 credit to start | have ✅ |
| **Vapi** | Voice calls (runs the phone agent) | ~$0.05–0.10 / minute | have ✅ |
| **ElevenLabs** | Realistic voices + voice cloning | your existing subscription | have ✅ |
| **Twilio** | SMS (and optionally phone numbers) | number ~$1–15/mo + ~$0.01–0.08 per SMS | needed for SMS |
| **Meta (WhatsApp/IG/FB)** | WhatsApp Business, Instagram/Messenger DMs, posting, ads data | API is free; WhatsApp has per-conversation pricing | app exists, must be **Live** |
| **Google Cloud** | Google + Gmail OAuth (Calendar, Analytics, Gmail send, etc.) | free within quota | have ✅ |
| **Brevo** (optional) | Higher-volume email if you don't use Gmail | Free 300 emails/day | not needed if Gmail |
| **DataForSEO** (optional) | Full SEO data for Sam (free fallback works without it) | pay-as-you-go | optional |
| **Firecrawl** (optional) | Whole-site crawling for KB import | pay-as-you-go | adding |
| **OpenAI** (optional) | Image gen — **not needed**, OpenRouter covers it | — | skip |
| **Google Ads developer token** (optional) | Pull Google **Ads** spend into reports | free but needs Ads MCC approval (1–2 days) | skip for now |

**Bottom line to launch:** Netlify (Free→Pro) + Supabase (Free→Pro) + OpenRouter credit +
Vapi + ElevenLabs (have) + Twilio (for SMS) + Meta app Live. Everything else is optional.

---

## 7. Where each API key goes — Netlify vs Pydent (step-by-step)

There are **two places** keys live. The rule:

- **Netlify environment variables** = the **developer's ONE app credentials**, shared by all
  clinics (like Calendly having one Google app everyone connects to). New clinics never touch Netlify.
- **Inside Pydent (Settings), per clinic** = each clinic's own accounts/numbers.

### A) Put these in **Netlify** → Site configuration → Environment variables → Add
(After adding/changing any, click **Deploys → Trigger deploy → Deploy site**.)

```
# Core (required)
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...         # OAuth tokens, reports, cron, workflow waits
OPENROUTER_API_KEY=...                # all AI text + image generation

# Voice
VAPI_API_KEY=...                      # private key from Vapi → Organization → API Keys
ELEVENLABS_API_KEY=...
# optional: VAPI_WEBHOOK_SECRET=..., NEXT_PUBLIC_VAPI_PUBLIC_KEY=...

# Google / Gmail (one app for all clinics)
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...

# Meta (WhatsApp/IG/FB/Ads — one app for all clinics)
FACEBOOK_CLIENT_ID=...
FACEBOOK_CLIENT_SECRET=...
META_APP_SECRET=...

# Email (optional — Gmail works without these)
BREVO_API_KEY=...
BREVO_FROM_EMAIL=verified@yourclinic.com

# SMS (for SMS to work)
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+1...              # or TWILIO_MESSAGING_SERVICE_SID=...

# Automation
CRON_SECRET=some-long-random-string   # protects /api/cron/run

# Optional / nice-to-have
OPENROUTER_IMAGE_MODEL=google/gemini-2.5-flash-image-preview
TEAM_AI_MODEL=anthropic/claude-sonnet-4
DATAFORSEO_API_KEY=...
FIRECRAWL_API_KEY=...
NEXT_PUBLIC_SITE_URL=https://pydentai.netlify.app
```

### B) Put these **inside Pydent** (each clinic enters their own — no redeploy needed)
- **Settings → WhatsApp:** the clinic's WhatsApp **Phone Number ID** + **access token**, **verify token**.
- **Settings → Connections:** click **Connect** on Google / **Gmail** / Meta etc. (OAuth popup, stored per clinic).
- **Settings → Open Dental:** the clinic's **connector URL** + **API key** (see §8).
- **Voice Agents → Phone Numbers:** provider credentials (SIP / Ziwo / Maqsam / etc.).
- **Settings → Connections:** clinic **website URL** (for KB import).

### C) Scheduler for automation (so "wait" steps + autopilot fire)
Point any scheduler (cron-job.org, Netlify Scheduled Function, or Supabase cron) at:
```
https://<your-site>/api/cron/run?key=<CRON_SECRET>     every ~15 minutes
```

### D) Run the database migrations (Supabase → SQL Editor, in order)
You've run `0035`–`0037`. Then run:
```
0038_voice_call_detail.sql
0039_campaigns.sql
0040_workflow_runs.sql
```
Each is idempotent (safe to re-run). The app degrades gracefully until they're run.

---

## 8. Open Dental — why local, what you need, and step-by-step

### Why local (this is the regulation point)
Patient clinical data (treatment, ledger, x-rays, etc.) **cannot be stored online** for
privacy/HIPAA-style reasons. So Open Dental and its data **stay on the clinic's own Windows
server**. Pydent never stores clinical data — it only **sends scheduling requests** (find slots,
book, reschedule, cancel) to a small **local connector** at the clinic, which talks to Open
Dental locally. Only appointment scheduling crosses the line; the chart never leaves the clinic.

### Software the clinic needs (on their server)
| Software | What it is | Cost |
|---|---|---|
| **Open Dental** | The dental practice-management software + its MySQL database (most clinics already run this) | ~**$179/mo** support, or perpetual license; **MySQL is free** and bundled |
| **Open Dental API** | Built into Open Dental — enable it and create a **Developer/Customer API key** (Setup → Advanced → API) | included |
| **Pydent local connector** | A small app **we will build** (Node service / Windows service) that receives Pydent's scheduling calls and uses the Open Dental API locally. ❌ not built yet | free (we ship it) |
| **Cloudflare Tunnel** (`cloudflared`) | Free tool that gives the local connector a secure HTTPS URL **without opening any ports** — so Pydent's gateway can reach it safely | **free** |

### Step-by-step (when you're ready to connect — we said this is last)
1. **Enable the API in Open Dental** (Setup → Advanced → API) and generate a **Developer Key** + **Customer Key**.
2. **Install the Pydent connector** on the clinic's server (the app we'll build). It listens locally and calls the Open Dental API with those keys.
3. **Install `cloudflared`** and run a tunnel to the connector. Cloudflare gives you a URL like `https://clinic-name.trycloudflare.com` (or a named tunnel on your domain).
4. In **Pydent → Settings → Open Dental**, paste that **tunnel URL** + a shared **API key**, and toggle **Enable**.
5. **Test:** book a test appointment from a chat/voice agent → it should appear in Open Dental's schedule, and Open Dental's open slots should show up when the agent offers times.
6. Clinical data (payments, x-rays, ledger) is intentionally **never** shown in Pydent — only appointments.

> Status today: the Pydent side (gateway routes `/api/opendental/*`, the Settings card, booking
> forward, external-id mirror) is **code-ready**. The **local connector app is the remaining build.**

---

## 9. What's next (recommended order)

1. **Run migrations 0038–0040** + connect **Gmail** (email) and **Twilio** (SMS) → those tabs go fully live.
2. Get the **Meta app to Live** (App Review) → Instagram/Messenger DMs + WhatsApp broadcasts go live.
3. **SMS auto-reply** (AI answers inbound texts like WhatsApp) — small build.
4. **Google Calendar push** + **Workflow add-to-pipeline** + **WhatsApp audio delivery** — finish the 🟠 items.
5. **Open Dental local connector** (the on-prem app) — the big one, done last.
6. **Billing / Admin / packages** — when the product is otherwise complete.

---

_Questions answered in this doc: what's done, what's left, what's only-UI, subscriptions
(Netlify $19 Pro, Supabase $25 Pro, pay-as-you-go AI), where each key goes (Netlify vs Pydent),
and the Open Dental local setup. Update this file as features land._
