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

## 3.1 AI Team — what each agent can actually do right now

All four agents are **fully built and functional** — they think via OpenRouter (✅ you have
the key) and they have **real tools** (not just chat). Each tool either works immediately or
needs the matching clinic **connection** (made once in Settings → Connections / WordPress).
Each agent now **stays in its lane** (declines out-of-area asks and names the right teammate).

> **Direct answer to "can they publish a blog if we connect WordPress?" → YES.**
> Connect the clinic's WordPress (Settings → Connections → WordPress, app password) and
> **Helena writes a full SEO article herself and publishes it to that WordPress** — as a draft
> by default, or live if you say "publish". She can also generate a featured image and attach it.

### 🟣 Helena — Marketing Manager
**Capabilities (tools she can actually run):**
- ✍️ **Write + publish blog posts to WordPress** (`publish_blog_post`) — she writes the full
  600–1200-word HTML article, then posts it (draft by default). _Needs: WordPress connected._
- 🖼️ **Generate marketing images** (`generate_featured_image`) and upload to WordPress media.
  _Needs: `OPENROUTER_API_KEY` ✅ (or OpenAI for higher quality)._
- 📘 **Post to Facebook** (`post_to_facebook`) and 📸 **Instagram** (`post_to_instagram`, makes
  the image too). _Needs: Meta connected + app Live._
- 📊 **Pull Google Analytics** (`get_analytics_report`) and **Search Console** (`get_search_console_report`).
  _Needs: Google connected._
- 💰 **Pull Meta Ads** + **Google Ads** performance (`get_meta_ads_performance`, `get_google_ads_performance`).
  _Needs: those ad accounts connected (Google Ads also needs the developer token)._
- 🌐 **Research any URL** (`research_url`, Firecrawl) for content ideas. _Needs: Firecrawl (optional)._
- 📄 **Create a downloadable report** (`create_report`) — Word .docx + print-to-PDF.
- **Missing:** scheduled/auto-publishing of social posts (she posts on command, not on a calendar);
  video content; LinkedIn/TikTok posting.

### 🔵 Sam — SEO / Local Search Manager
**Capabilities:**
- 🔎 **Keyword research** (`keyword_research`) — **works WITHOUT any key** via free Google
  Autocomplete; richer volumes/competition with DataForSEO.
- 🏢 **Post to Google Business Profile** (`post_to_google_business`). _Needs: Google Business connected._
- 📈 **Search Console** top queries + pages (`get_top_queries`, `get_top_pages`). _Needs: Google connected._
- 🩺 **On-page SEO audit** of a URL (`audit_page_seo`) — works (fetches + analyses the page).
- 🥊 **Competitor analysis** (`find_competitors`, `ranked_keywords`), **backlinks** (`backlinks_summary`),
  **live SERP check** (`serp_check`). _Needs: `DATAFORSEO_API_KEY` (optional)._
- 🕷️ **Crawl a site** (`crawl_url`, Firecrawl) + **create reports**.
- **Missing:** automatic rank tracking over time; auto-applying on-page fixes (he recommends, you apply);
  schema/structured-data generation.

### 🟢 Kai — Reputation & Reviews Manager
**Capabilities:**
- ⭐ **Read Google reviews** (`get_google_reviews`) and **Facebook reviews** (`get_facebook_reviews`),
  summarise sentiment, surface the urgent/negative ones first. _Needs: Google Business / Facebook connected._
- 💬 **Draft + post replies to Google reviews** (`reply_to_google_review`) — only after you approve the wording.
- 🧠 **Sentiment analysis** — done by the model on the pulled reviews (no extra key).
- **Missing:** broad social-listening / brand-mention monitoring (needs a paid listening data source);
  replying to Facebook/other-platform reviews (only Google review replies are wired); review-request automation.

### 🟠 Angela — Patient Email & WhatsApp Manager
**Capabilities:**
- ✉️ **Write AND send patient email** (`send_email`) — recall reminders, newsletters, promos.
  _Sends via the clinic's connected **Gmail** (or Brevo)._ ✅ works once Gmail is connected.
- 📋 **Find recall-due patients** (`find_recall_patients`) from the live database — real data.
- 📱 **List approved WhatsApp templates** (`list_whatsapp_templates`) and **schedule a WhatsApp
  broadcast** (`schedule_whatsapp_broadcast`). _Needs: WhatsApp connected + an approved template._
- ✍️ Always produces ready-to-use copy (subject + body for email; template-safe text for WhatsApp).
- **Missing:** Mailchimp campaign send; SMS campaigns (separate SMS tab handles SMS); bulk
  scheduled email drip sequences (single sends + WhatsApp broadcasts work today).

### What ALL four can do regardless of connections
- Hold a real conversation, use the **clinic's brand knowledge** + uploaded brand docs, keep
  **chat history/sessions**, write to their **Activity feed**, produce **downloadable reports**,
  and run on **Autopilot** (a schedule) once a cron hits `/api/cron/run`.
- Switch the underlying model to Claude with `TEAM_AI_MODEL`.

### One-line summary
| Agent | Works now (no extra key) | Unlocks when you connect… |
|---|---|---|
| **Helena** | write blogs/social copy, generate images, write reports | **WordPress** (publish blogs), Google (analytics), Meta (post/ads) |
| **Sam** | keyword research (free), page audits, reports | Google (Search Console/GBP), DataForSEO (deep SEO) |
| **Kai** | analyse/sentiment + draft replies | Google Business / Facebook (read & post reviews) |
| **Angela** | draft email/WhatsApp copy, find recall patients | **Gmail** (send email), WhatsApp (broadcasts) |

---

## 4. 🟠 Built but the real functionality is NOT fully wired yet

> These let you fill in / save options, but the backend doesn't yet perform the
> real-world action. **This is the honest "looks done but isn't fully connected" list.**

1. ~~Phone-number provider forms only save config~~ ✅ **Now connects to Vapi automatically.**
   Saving a number with an assigned agent registers it on Vapi via `/api/vapi/phone-numbers`
   (Twilio = direct; SIP/Ziwo/Maqsam/Go Auto Dial/Vocalcom = a BYO SIP-trunk credential) and
   **attaches that specific agent's assistant**, so inbound calls route to the right agent —
   the clinic never opens Vapi. (The agent must be saved once so it has a Vapi assistant id.)
2. **Instagram publishing** — the content calendar **saves posts to the DB**, but it does
   **not actually publish to Instagram** on schedule. (Helena can post via the Meta tool once
   the Meta app is Live; scheduled auto-publish is not wired.)
3. **Google Calendar push** — the Google Calendar connection exists, but **bookings are not
   yet pushed to Google Calendar** (they go to our Calendar + Open Dental only).
4. ~~WhatsApp voice-note delivery~~ ✅ **Now delivered for real.** In the inbox, type a message,
   "Send as voice note", pick a voice (premade **or your cloned custom voice**) → it's generated
   with ElevenLabs, uploaded to WhatsApp (`/api/voice/send-wa`) and sent to the patient as an
   audio message (and still plays in-dashboard). Needs `ELEVENLABS_API_KEY` + WhatsApp connected.
5. **Workflow "Add to pipeline" action** — currently logs/minimal; it does not yet create a
   full pipeline deal record (message / wait / condition / handoff / set-status DO work).
6. **Campaign outbound dialer** — campaigns organise + tag calls, but do **not place outbound
   calls** automatically (no auto-dialer yet).
7. **A few advanced voice VAD micro-params** (activation threshold, prefix padding, min-speech)
   are saved + shown, but Vapi only applies the subset it exposes (timeouts, turn detection,
   limits, privacy, extraction all apply).
8. **Per-clinic connections** ✅ — Brevo/Mailchimp now connect **in-app** (paste the key in
   Settings → Connections; stored per workspace, not in Netlify). Email send uses the clinic's
   own Brevo key first, then a global key, then Gmail. (Mailchimp *campaign send* still TODO, but
   the key is now stored per clinic.) **Timezone** is now a per-clinic setting (Settings → Profile)
   used by Google Calendar push — no env needed.
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

> Column key: **HAVE** = you already have it · **BUY** = you need to subscribe/pay ·
> **ADDING** = optional, you're adding it · **SKIP** = optional, not needed now.

### Required platforms (the SaaS itself runs on these)
| Service | What it's for | Plan & rough cost | Status |
|---|---|---|---|
| **Netlify** | Hosting the web app + serverless API routes | **Personal $9/mo** ("ready for real traffic", 1,000 credits, Agent Runners) is the right one to start; **Pro $20/mo** adds private repos, shared env vars, 3+ concurrent builds, password-protected projects, 3,000 credits — go Pro only when you have a team | **BUY — $9 Personal** |
| **Supabase** | Postgres database + Auth | **Free** (500 MB DB, 50k monthly users — fine to launch); **Pro $25/mo** for production (daily backups, no auto-pause, more storage) | **BUY when live — $25 Pro** |
| **Domain name** | e.g. `pydent.app` | ~$10–15/yr (optional; Netlify gives a free `*.netlify.app`) | SKIP for now |

### AI / channel services (pay-as-you-go — pay only for what you use)
| Service | What it's for | Cost | Status |
|---|---|---|---|
| **OpenRouter** | All AI text (chat agents, AI Team) **and image generation** | pay per token; add ~$10–20 credit | **HAVE ✅** |
| **Vapi** | Runs the phone calls (the voice agent's brain on the call) | ~$0.05–0.10 / minute | **HAVE ✅** |
| **ElevenLabs** | Realistic voices + voice cloning | your existing subscription | **HAVE ✅** |
| **Twilio** | **Both**: (a) **SMS** send/receive, **and** (b) the **phone number the customer calls** — Twilio provides the number, Vapi answers it with the agent. Needed for inbound + outbound calling unless you use a SIP/Ziwo/Maqsam number instead. | number ~$1–15/mo + ~$0.01–0.08 per SMS, ~$0.013/min for calls | **BUY — for SMS + calling** |
| **Meta (WhatsApp/IG/FB)** | WhatsApp Business, Instagram/Messenger DMs, posting, ads data | API is free; WhatsApp has per-conversation pricing | app exists, must go **Live** |
| **Google Cloud** | Google + Gmail OAuth (Calendar, Analytics, Gmail send) | free within quota | **HAVE ✅** |
| **OpenAI** | Image gen at higher quality (DALL·E 3). Without it, OpenRouter makes the images. | pay per image (~$0.04 each) | **ADDING (optional)** |
| **Firecrawl** | Whole-site crawling for KB import / research | pay-as-you-go | **ADDING (optional)** |
| **Brevo** | Higher-volume email — **not needed**, Gmail covers sending | Free 300 emails/day | **SKIP (Gmail covers it)** |
| **DataForSEO** | Full SEO data for Sam — free fallback works without it | pay-as-you-go | **SKIP (optional)** |
| **Google Ads developer token** | Pull Google **Ads** spend into reports | free but needs Ads MCC approval (1–2 days) | **SKIP for now** |

**Bottom line — what you actually need to BUY to launch:**
1. **Netlify $9/mo** (Personal) — hosting.
2. **Supabase** — free now, **$25/mo** when you go to production.
3. **Twilio** — pay-as-you-go, for **SMS and the phone number customers call**.
4. (Already have: OpenRouter, Vapi, ElevenLabs, Google.) (Adding, optional: OpenAI, Firecrawl.)
Everything else is free or optional.

### "If I add an OpenAI key right now, what happens? What do we build after?"
- **Nothing else to build — it just works.** Image generation is already wired with a
  fallback: if `OPENAI_API_KEY` is present it uses **DALL·E 3** (sharper marketing images);
  if not, it uses **OpenRouter**. So adding the key simply **upgrades image quality** for
  Helena's blog featured images and Instagram post images. No redeploy of logic needed —
  just add the env var in Netlify and trigger a deploy.
- After that, the natural next image features (only if you want them) are: a "regenerate /
  pick from 3 options" button, and on-image text/branding overlays. These are optional polish,
  not required.

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

### How WE will build the Open Dental connector (our plan)
A small **Node.js service** that runs on the clinic's server. We already have the Pydent gateway
that calls it; the connector is the missing on-prem half. Build steps:

1. **Connector app** — a tiny Express service exposing only scheduling endpoints that mirror what
   the Pydent gateway already calls:
   - `POST /available-slots` → query Open Dental for open appointment times
   - `POST /create-appointment` → find-or-create the patient (real PatNum) + book
   - `POST /reschedule-appointment`, `POST /cancel-appointment`
   - `GET /doctors` → provider list
   It talks to Open Dental over the **local network only** (the Open Dental API on `localhost`),
   using the clinic's Developer + Customer keys.
2. **Shared-secret auth** — every request from Pydent carries an `x-api-key`; the connector
   rejects anything else. So only your dashboard can reach it.
3. **Find-or-create patient** — on booking, look up the caller by phone/name; if new, create a
   minimal patient in Open Dental and return the **PatNum** (we store only that id, never the chart).
4. **Packaging** — ship it as a Windows service (via `node-windows` or NSSM) so it auto-starts and
   stays running, plus a one-page installer/README for the clinic's IT.
5. **Secure tunnel** — bundle `cloudflared` config so the connector gets a stable HTTPS URL with
   **no open ports** on the clinic firewall.
6. **Test harness** — a mock Open Dental mode so we can verify booking end-to-end before touching
   a live clinic (you asked not to disturb the live clinic — this lets us test safely).

Estimated build: the connector itself is small (~1–2 days); most of the time is safe testing.

### Why NO patient data leaks (the privacy guarantee)
- **Clinical data never leaves the clinic.** The chart, x-rays, ledger, payments, insurance — all
  of it stays inside Open Dental on the clinic's own server. Pydent has **no database table** for
  any of it, and the UI **deliberately hides** payments/balance/insurance/treatment-plans.
- **Only appointment scheduling crosses the wire** — and only the few fields needed to book a slot
  (name, phone, the chosen time, the treatment label). No diagnoses, no history, no money.
- **The tunnel is outbound-only and encrypted.** `cloudflared` makes an outbound HTTPS connection
  from the clinic to Cloudflare; **no inbound ports are opened**, so the server isn't exposed to
  the internet. Traffic is TLS-encrypted end to end.
- **Shared-secret + per-clinic isolation.** Only your dashboard (with the secret key) can call the
  connector, and every Pydent record is scoped by `workspace_id` so clinics never see each other's data.
- **You hold the off switch.** Disabling the connection in Settings (or stopping the connector)
  instantly cuts the link; Pydent keeps working on its own calendar in the meantime.

---

## 8.5 Phone numbers & UAE calling — how it works (the "Azure" question)

**What Callab is doing with that Azure portal:** Azure (Azure Communication Services)
is one way to **buy/host the phone number and the SIP/PSTN line**. It is NOT what runs the
AI — the AI call itself runs on **Vapi/Retell**. So their chain is:

```
Phone number (carrier / Azure / SIP provider)  →  SIP trunk  →  Vapi/Retell (AI agent answers)  →  our app (/api/vapi/events: booking, logs)
```

Azure is just the "phone line" half. You don't strictly need Azure — any number source that
can hand Vapi a SIP trunk works. **For a UAE local number specifically, Twilio usually can't
sell you one**, so the realistic options are:

1. **A UAE / regional SIP provider or CPaaS** — e.g. **Ziwo**, **Maqsam**, or a SIP trunk from
   **Etisalat/du** (or an aggregator). You already have provider cards for these in
   Voice Agents → Phone Numbers.
2. **Azure Communication Services** — buy a number + PSTN there and expose a SIP trunk (works,
   but UAE local-number availability on Azure is limited; a regional provider is usually easier).
3. **Bring the clinic's existing number** — the clinic forwards their current landline to the
   SIP/Vapi number, so patients keep dialing the same number.

### How we do it in Pydent (already built)
- Go to **Voice Agents → Phone Numbers → Add Phone Number** → pick **Custom SIP Trunk** (or
  Ziwo / Maqsam / Go Auto Dial / Vocalcom / BYOT Twilio). Enter the trunk/credentials.
- That number is connected to the **Vapi** assistant (our app sets the assistant's server URL
  automatically). Vapi answers inbound calls with the voice agent; the agent books/reschedules
  via `/api/vapi/events` (already wired).
- **Nothing is installed at the clinic for voice** — the number lives in the cloud (provider →
  Vapi). The only on-prem install is the **Open Dental connector** (for clinical data), §8.

### Step-by-step to put a UAE number live
1. Get a UAE number + SIP trunk from a regional provider (Ziwo/Maqsam/Etisalat/du) — or buy one
   on Azure ACS and expose its SIP trunk.
2. In **Vapi → Phone Numbers**, add the number via **SIP/BYO** using the trunk's host, username,
   password (Vapi does the live SIP handshake).
3. In **Pydent → Phone Numbers**, add the same number (SIP Trunk form) and assign the voice agent.
4. Point the trunk's inbound route at Vapi. Test: call the number → the agent answers → book a
   test appointment → it lands on the Calendar (and Open Dental when connected).

> Summary: **Azure (or Ziwo/Maqsam/a SIP trunk) = the phone line; Vapi = the AI on the call;
> Pydent = the agent's brain, booking and logs.** We support this today via the Phone Numbers
> SIP/provider forms — no clinic-side install needed for voice.

## 9. What's next (recommended order)

1. **Run migrations 0038–0040** + connect **Gmail** (email) and **Twilio** (SMS) → those tabs go fully live.
2. Get the **Meta app to Live** (App Review) → Instagram/Messenger DMs + WhatsApp broadcasts go live.
3. **SMS auto-reply** (AI answers inbound texts like WhatsApp) — small build.
4. **Google Calendar push** + **Workflow add-to-pipeline** + **WhatsApp audio delivery** — finish the 🟠 items.
5. **Open Dental local connector** (the on-prem app) — the big one, done last.
6. **Billing / Admin / packages** — when the product is otherwise complete.

---

_Questions answered in this doc: what's done, what's left, what's only-UI, subscriptions
(Netlify $9 Personal / $20 Pro, Supabase free→$25 Pro, pay-as-you-go AI), where each key goes (Netlify vs Pydent),
and the Open Dental local setup. Update this file as features land._
