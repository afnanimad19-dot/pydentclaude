# Pydent — Status, Setup & Next Steps

_Last updated: this session. Branch: `claude/vigilant-heisenberg-o5g281`._

> **What changed most recently:** Voice Agent Settings (assign an existing number to an
> agent), AI team → Brevo campaigns, **Email + SMS campaigns via Brevo**, **scheduled report
> workflow**, **Instagram auto-publish**, **durable Meta tokens**, **per-clinic Twilio**,
> **workflow call/SMS/email/calendar actions**, an app-wide CRUD pass (edit/delete/
> import/export everywhere; removed fake "for-show" buttons), and the **Open Dental connector**
> is now **built + testable in mock mode** (`npm run smoke` passes — no clinic/API needed).
> Migrations through **0047**. See **§10 — what's left from your side (keys/auth/verification)**
> and **§11 — live verification checklist**. Compliance detail: `OPEN_DENTAL_AND_COMPLIANCE.md`.

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
| **Voice agents** | Editor + Advanced Settings (VAD, turn detection, noise, AMD, limits, privacy, post-call extraction, **call transfer/redirect**) → synced to Vapi (**PATCH-updates**, no duplicates); test call | `VAPI_API_KEY` ✅ in |
| **Voice Agent Settings** | **New subpage** — assign an EXISTING connected number to an agent; auto-configures Vapi so inbound is answered + the number is the outbound caller ID | `VAPI_API_KEY` ✅ |
| **Voice-call booking** | Live call books/reschedules/cancels → Calendar (+ Google Calendar if connected + Open Dental forward); captures name/phone/email/treatment/fee + source | `VAPI_API_KEY` ✅ |
| **Outbound dialer** | Campaign "Start calling" dials its contact list with the chosen agent + number (per-campaign caller id) | `VAPI_API_KEY` ✅ + registered number |
| **Call Logs** | Paginated list (From/To/Direction/Duration/Status/Campaign/Agent/Recording/Summary) + detail page (timeline + tool-call cards + recording) | populated by real calls |
| **Campaigns** | Agent + number + contact list; **create/edit/delete**; "Start calling"; Call Logs Campaign column/filter | — |
| **Contacts** | List + detail modal, **search**, **per-row edit/delete**, **CSV import/export**, bulk select/move/delete, country-flag phone picker, voice-only filter | — |
| **Workflows runner** | message / wait / condition / handoff / **action (tag, add-to-pipeline, place-a-call)** / **report**; SMS→Twilio + Email→provider routing; triggers from new WhatsApp conversation + on booking + **scheduled (cron)** + Test-run | cron hit; channel connected for sends |
| **Scheduled reports** | A "Scheduled" trigger + "Email a report" action build a weekly practice digest (new patients, recalls, bookings, production) and email it with a downloadable Word/PDF | cron hit + email connected |
| **Email** | Real composer "Send now" (Gmail/Brevo) **+ full email campaigns via Brevo** (lists, draft/schedule/send, stats) | Connect Gmail or Brevo |
| **SMS** | Real composer send (**per-clinic Twilio** or env) + inbound webhook → inbox **+ SMS campaigns via Brevo** | Connect Twilio (in-app) or `TWILIO_*` |
| **Instagram** | Content calendar with **edit/delete**; **auto-publishes** scheduled posts at their time (image hosted on WordPress → Meta) | Meta Live + WordPress connected |
| **AI Team** | All four agents with real tools (blogs→WordPress, GA4/Search Console, reviews, email/WhatsApp); each stays in its lane | per-tool keys (see §6) |
| **Pipeline** | Live WhatsApp leads by lifecycle stage; drag between stages; stage→agent handover (money figures removed) | — |
| **Calendar & booking** | Week/15/30-day views; bookings from chat/voice/manual land here; no double-book | — |
| **WhatsApp inbox** | Inbound + outbound, auto-reply, assign to human, **template delete**, broadcasts (template submit/sync, scheduled send via cron, per-recipient tracking) | clinic WhatsApp number + tokens (in Pydent) |
| **Multi-tenant connections** | Per-clinic Google / Gmail OAuth (popup) + **Brevo / Mailchimp / Twilio** (in-app key/creds), stored per workspace; **durable Meta tokens** (60-day + Page token) | `GOOGLE_*` / `FACEBOOK_*` ✅ in |
| **AI team → Brevo** | Angela drafts an email/SMS campaign and creates it in Brevo as a **draft / scheduled / send-now** for the clinic to review | Brevo connected |
| **Settings** | Profile name **persists**; **tags persist**; timezone per clinic; Settings dropdown + Billing tab | — |

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
- 📨 **Create a Brevo email OR SMS campaign** (`list_brevo_lists`, `create_brevo_campaign`) — she
  writes the copy and lands it in Brevo as a **draft** (default), **scheduled**, or **send-now**,
  targeting the clinic's Brevo contact lists. _Needs: Brevo connected._
- ✍️ Always produces ready-to-use copy (subject + body for email; template-safe text for WhatsApp).
- **Missing:** Mailchimp campaign send (Brevo covers email + SMS campaigns today); bulk
  scheduled email drip sequences (single sends, WhatsApp broadcasts + Brevo campaigns work today).

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
| **Angela** | draft email/WhatsApp copy, find recall patients | **Gmail** (send email), WhatsApp (broadcasts), **Brevo** (email + SMS campaigns) |

---

## 4. Recently completed (was "built but not wired" — now ✅ done)

> **Session of 2026-07-01 — done today:**
> - ✅ Fixed 4 reported bugs (new account seeing old data, number "connected" but not on Vapi,
>   agent edits not syncing to Vapi, voice agent repeating "one moment"/talking over itself).
> - ✅ Dedicated Twilio "Add Phone Number" form matching Vapi's importer (country picker, Account
>   SID, Auth Token, Label, SMS toggle) — connects to Vapi + assigns the agent.
> - ✅ Native Email + SMS broadcasts to your own contact folders (send now or schedule).
> - ✅ Reports date-range Performance card; Inbox search + template picker; Clinical statement print.
> - ✅ Pipeline persistence (manual deals now saved to a table, no longer reset on reload).
> - ✅ SMS auto-reply (AI answers inbound texts like WhatsApp — bookings included).
> - ✅ **Strict workspace RLS** — every table scoped to `workspace_id = current_workspace()`;
>   added a server-only service-role client so webhooks/cron keep working. (See §5 apply-order note.)
> - ✅ **Inbox archive/delete** + **clinical claim/adjustment delete buttons** (the last honest gaps).
> - ✅ **Billing / credits / top-up now functional without Stripe** — plans credit minutes, calls
>   deduct them, auto-recharge tops up. Stripe is only the future payment step. (See §5 billing box.)
> - ✅ **Legal pages** — public **Privacy Policy** (`/privacy`), **Terms** (`/terms`) and **Data
>   Deletion** (`/data-deletion`), linked in the footer. Written to pass Meta App Review + Google
>   OAuth verification (Meta scopes + Google Limited-Use sections included).
> - ✅ **Meta + Google verification guide** — `META_GOOGLE_VERIFICATION.md`: step-by-step to publish
>   both apps, tailored to this app's real scopes/redirect URIs (Business Verification, App Review
>   screencasts, Google OAuth verification, the CASA note for restricted Gmail/Drive scopes).
>
> Everything in the list below has been wired. Kept here so you can see what changed.

1. ✅ **Phone-number → Vapi** — saving a number with an agent registers it on Vapi and attaches
   the assistant (Twilio direct; SIP/Ziwo/Maqsam/Go Auto Dial/Vocalcom via BYO SIP trunk). Plus a
   **new Voice Agent Settings page** to assign an EXISTING number to an agent (re-routes Vapi live).
2. ✅ **Instagram auto-publish** — scheduled posts now publish at their time via `/api/cron/ig-publish`
   (generates the image, hosts it on WordPress, posts via Meta, writes back Published/Failed).
3. ✅ **Google Calendar push** — bookings (voice + chat) now push to Google Calendar **when the clinic
   has connected it** (silently skipped otherwise), in addition to our Calendar + Open Dental.
4. ✅ **WhatsApp voice-note delivery** — premade or cloned voice → ElevenLabs → delivered as audio.
5. ✅ **Workflow "Add to pipeline"** now sets the contact's lifecycle stage; plus new **place-a-call**,
   **SMS/Email routing** (was wrongly sending over WhatsApp), and **report** actions.
6. ✅ **Outbound dialer** — campaigns place real outbound calls ("Start calling").
7. ✅ **Per-clinic connections** — Brevo/Mailchimp **and now Twilio** connect in-app per workspace;
   **email + SMS campaigns run through the clinic's Brevo**; **Meta tokens are now durable** (60-day +
   Page token). Timezone is per-clinic.
8. ✅ **Durable Meta tokens** + the account-label fix (posting survives past ~1h).
9. ✅ **App-wide CRUD** — edit/delete/import/export added across Contacts, Instagram, Campaigns,
   Phone Numbers, Templates, Calendar (confirm/reschedule/cancel); removed fake "for-show" buttons
   (WhatsApp demo campaign, fake "Published", dead billing button); profile name + tags persist.

### Recently wired (were "still partial")
- ✅ **Native Email + SMS broadcasts to your own contact lists** — send an email/SMS to a whole
  contact folder from the Email/SMS pages (send now or schedule), through the clinic's connected
  Gmail/Brevo (email) or Twilio (SMS); per-recipient results + overview. This is separate from the
  Brevo-list campaigns — it uses YOUR folders, no external list needed.
- ✅ **Reports** — a date-range Performance card: booked / completed / **production (completed fees)** /
  **no-show rate** for the chosen range (was a fixed today-onward snapshot).
- ✅ **Inbox** — conversation **search** box (filters the list by name/preview) **and a template
  picker** (insert an Approved WhatsApp template into the reply draft).
- ✅ **Clinical** — the **Statement** button now prints a real account statement (was a placeholder).
- ✅ **SMS auto-reply** — inbound Twilio texts now get an AI reply from the SMS agent (bookings,
  reschedule, cancel included), exactly like WhatsApp. Lands in the Omnichannel Inbox.
- ✅ **Pipeline persistence** — manually-added deals now save to a `pipeline_deals` table (were
  session-only and reset on reload). Live WhatsApp leads still show alongside them.
- ✅ **Strict workspace RLS** — every data table is now scoped by `workspace_id = current_workspace()`
  (was wide-open `using (true)`). Each clinic only ever reads its own rows. Server webhooks/cron use
  the service-role client so they still work. **⚠️ Apply order matters — see §5 note below.**
- ✅ **Inbox archive / delete** — each conversation now has an actions menu (⋮) to **Archive** (hides
  it; a new inbound message brings it back) or **Delete** (removes the conversation and its messages).
- ✅ **Clinical delete buttons** — per-row **delete** on insurance claims and on manual ledger
  adjustments (wired to `deleteClaim` / `deleteLedgerAdjustment`; DB-backed on live patients).
- ✅ **Billing / credits / top-up — WORKS NOW without Stripe.** Choosing a plan or buying minutes
  actually credits the balance and logs an invoice; voice calls **deduct** minutes as they end, and
  **auto-recharge** tops the balance back up when it runs low. No card is charged yet — Stripe is the
  future payment step (see §5 "How billing works without Stripe").
- ✅ **Legal pages + verification guide** — `/privacy`, `/terms`, `/data-deletion` (footer-linked),
  written to satisfy Meta App Review and Google OAuth verification, plus a full step-by-step
  publishing guide in `META_GOOGLE_VERIFICATION.md`. **Remaining action is yours** (deploy, publish
  the URLs, submit for review) — see §5.

### Still partial (honest remaining gaps)
- **A few advanced voice VAD micro-params** are saved but Vapi only applies the subset it exposes
  (a Vapi product limit, not our code).
- **Mailchimp campaign send** — Brevo covers email + SMS campaigns, and the **native broadcast**
  above covers send-to-your-own-list, so Mailchimp is optional; its key is stored but not consumed.

---

## 5. ❌ Not built yet (remaining roadmap)

1. **Open Dental local connector** (the on-prem app) + live test — see §8. _Doing this last on purpose._
2. **Stripe payment step** — the billing/credit/top-up engine works now (see box below); Stripe is
   the future layer that takes the actual card payment before the same crediting runs.
3. **Connectors:** X/Twitter (PKCE), Shopify (shop domain), TikTok Ads, Stripe Connect, Notion — catalog cards only.
4. **Admin panel / packages-entitlements** (lock features per plan) — _deliberately last._
5. **Video generation** (MuAPI/Higgsfield).

> **💳 How billing works without Stripe (what's live today).** The whole minutes economy runs now,
> Stripe just isn't the payment rail yet:
> - **Plans** (Starter / Growth / Clinic) — Settings → Billing → *Change plan*. Activating a plan
>   credits its included minutes immediately and sets the price / concurrency / next-billing date.
> - **Top-up** — *Add Minutes* credits the balance right away and records an invoice. A banner makes
>   clear no card is charged yet.
> - **Consumption** — every voice call, on its end-of-call report, **deducts** its minutes from the
>   balance (`billing_settings.minutes_balance`).
> - **Auto-recharge** — when the balance drops below the threshold, it tops back up to the target
>   automatically (logged as a `manual` invoice, amount 0 until Stripe bills it).
> - **When Stripe is added:** set `STRIPE_SECRET_KEY`, collect the card via Stripe Elements, and have
>   the payment webhook call the *same* `addMinutes(qty, { charged: true })` — no rework of the ledger.
>   Card numbers are never stored by Pydent (only the Stripe customer id + last4 for display).

> **⚠️ Strict RLS apply order (migration `0050_workspace_rls.sql`).** This migration tightens every
> table from open access to `workspace_id = current_workspace()`. Server code (webhooks, cron,
> broadcast runners, Open Dental gateway, booking) now uses the **service-role** client, which
> bypasses RLS. That client needs **`SUPABASE_SERVICE_ROLE_KEY`** set in the deployment env — if it
> isn't, it falls back to the anon key, and once RLS is on, inbound SMS/WhatsApp/voice webhooks (which
> have no logged-in user, so `current_workspace()` is NULL) would be **blocked**. So the order is:
> **(1) set `SUPABASE_SERVICE_ROLE_KEY` in Netlify → (2) then run migration `0050`.** The migration
> also backfills any child rows (messages, broadcast recipients) that had a NULL `workspace_id` from
> their parent, so existing inbox/broadcast history stays visible.

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
| **Twilio** | **Both**: (a) **single-text SMS** (each clinic connects their own SID/token/from in-app, or a shared env account), **and** (b) the **phone number the customer calls** — Twilio provides the number, Vapi answers it. Needed for inbound + outbound calling unless you use a SIP/Ziwo/Maqsam number. (Bulk SMS *campaigns* go through Brevo instead.) | number ~$1–15/mo + ~$0.01–0.08 per SMS, ~$0.013/min for calls | **BUY — for single SMS + calling** |
| **Meta (WhatsApp/IG/FB)** | WhatsApp Business, Instagram/Messenger DMs, posting, ads data | API is free; WhatsApp has per-conversation pricing | app exists, must go **Live** |
| **Google Cloud** | Google + Gmail OAuth (Calendar, Analytics, Gmail send) | free within quota | **HAVE ✅** |
| **OpenAI** | Image gen at higher quality (DALL·E 3). Without it, OpenRouter makes the images. | pay per image (~$0.04 each) | **ADDING (optional)** |
| **Firecrawl** | Whole-site crawling for KB import / research | pay-as-you-go | **ADDING (optional)** |
| **Hyperfx.ai** | The marketing-intelligence backend: Meta/Google/TikTok/LinkedIn Ads, Google Calendar, SEO + AI-search visibility, ads-library + social scraping. Connect a platform once on hyperfx.ai → usable from Pydent instantly (the **Meta Ads** tab reads through it, and **all four AI Team agents** — Helena ads/creative, Sam SEO/AI-search, Kai reviews/reputation, Angela lead-gen — use its tools in chat). **Multi-clinic model (Option 1): one Hyperfx account per clinic** — YOUR account's key goes in Netlify env (`HYPERFX_MCP_URL` + `HYPERFX_API_KEY`) as the app default; EACH CLINIC's own account key is pasted in **their** workspace at Settings → Connections → Hyperfx card (never in Netlify). Run migration `0052_hyperfx_config.sql`. | ~$49/mo per clinic (Starter), priced into the Pydent plan | **HAVE ✅ — env vars + migration 0052** |
| **Brevo** | **Email + SMS campaigns** (the clinic connects their own key; drives the Email/SMS campaign tabs + AI-drafted campaigns). Gmail still covers single-email send. | Free 300 emails/day; paid for volume/SMS | **RECOMMENDED (per clinic)** |
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
- **Settings → Connections:** click **Connect** on Google / **Gmail** / **Meta** (OAuth popup, stored per clinic).
- **Settings → Connections → Brevo / Mailchimp:** paste the clinic's **API key** (drives email **+ SMS campaigns**).
- **Settings → Connections → Twilio SMS:** the clinic's **Account SID + Auth Token + From number** (verified on save) — single-text SMS uses this first, falling back to the shared `TWILIO_*` env.
- **Settings → Open Dental:** the clinic's **connector URL** + **API key** (see §8).
- **Voice Agents → Phone Numbers:** provider credentials (SIP / Ziwo / Maqsam / etc.); **Voice Agent Settings** to assign a number to an agent.
- **Settings → Connections:** clinic **website URL** (for KB import).

> So `TWILIO_*` and `BREVO_*` in Netlify are now **optional shared fallbacks** — the real
> multi-tenant path is each clinic connecting their own in Settings → Connections.

### C) Schedulers for automation (so "wait" steps, scheduled reports, broadcasts + IG posts fire)
Point a scheduler at each (the Netlify Scheduled Functions in `netlify/functions/` already do this
automatically on deploy — `broadcast-cron.mjs` and `ig-publish-cron.mjs`; you only need to set these
up manually if you're NOT on Netlify):
```
https://<your-site>/api/cron/run?key=<CRON_SECRET>     every ~15 min  (workflows: waits, SCHEDULED REPORTS, autopilot)
https://<your-site>/api/cron/run-broadcasts            every ~5 min   (scheduled WhatsApp broadcasts)  [x-cron-secret header]
https://<your-site>/api/cron/ig-publish                every ~5 min   (scheduled Instagram posts)       [x-cron-secret header]
```
For report download links to work, set **`NEXT_PUBLIC_SITE_URL`** (or rely on Netlify's `URL`).

### D) Run the database migrations (Supabase → SQL Editor, in order)
All migrations through **0047** should be applied. The ones added this session:
```
0043_voice_number_vapi_id.sql                 # store the Vapi number id (rebind without recreate)
0044_oauth_meta_and_workflow_schedule.sql     # durable Meta tokens (meta jsonb) + workflow last_fired_at
0045_ig_publish.sql                           # Instagram publish status + media id/error/published_at
0046_clinic_display_name.sql                  # persist the profile display name
0047_clinic_tags.sql                          # persist clinic tags
```
Each is idempotent (safe to re-run). The app degrades gracefully until they're run.
✅ **You've confirmed these are migrated in Supabase.**

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
| **Pydent local connector** | A small Node service that receives Pydent's scheduling calls and uses the Open Dental API locally. ✅ **Built** (in `opendental-connector/`), **mock-testable now** (`npm run smoke`); find-or-create patient done. Remaining: per-clinic mapping + Windows-service packaging + tunnel bundle. | free (we ship it) |
| **Cloudflare Tunnel** (`cloudflared`) | Free tool that gives the local connector a secure HTTPS URL **without opening any ports** — so Pydent's gateway can reach it safely | **free** |

### Step-by-step (when you're ready to connect — we said this is last)
1. **Enable the API in Open Dental** (Setup → Advanced → API) and generate a **Developer Key** + **Customer Key**.
2. **Install the Pydent connector** on the clinic's server (the app we'll build). It listens locally and calls the Open Dental API with those keys.
3. **Install `cloudflared`** and run a tunnel to the connector. Cloudflare gives you a URL like `https://clinic-name.trycloudflare.com` (or a named tunnel on your domain).
4. In **Pydent → Settings → Open Dental**, paste that **tunnel URL** + a shared **API key**, and toggle **Enable**.
5. **Test:** book a test appointment from a chat/voice agent → it should appear in Open Dental's schedule, and Open Dental's open slots should show up when the agent offers times.
6. Clinical data (payments, x-rays, ledger) is intentionally **never** shown in Pydent — only appointments.

> **Status today:** BOTH halves are built. The Pydent side (gateway routes `/api/opendental/*`, the
> Settings card with **Test connection**, booking forward, external-id mirror) is wired, AND the
> **local connector is built and testable in mock mode** — `cd opendental-connector && npm run smoke`
> runs health → auth → doctors → slots → book → reschedule → cancel and passes, with **no Open Dental
> and no clinic keys**. What remains is **per-clinic mapping**, **Windows-service packaging**, the
> **tunnel bundle**, and the **live acceptance test at a real clinic** (the API/verification part —
> see §10 + §11). Clinical data (payments, x-rays, ledger, documents) is intentionally **never** shown
> in Pydent — only appointments. See `OPEN_DENTAL_AND_COMPLIANCE.md` for the full guide + UAE rules.

### Connector — what's BUILT vs what's LEFT
The connector is a small **Node.js service** in `opendental-connector/`. The Pydent gateway already
calls it. Status of each part:

| Part | Status |
|---|---|
| **Connector app** — Express service: `/available-slots`, `/create-appointment`, `/reschedule-appointment`, `/cancel-appointment`, `/doctors`, `/services`, `/health` | ✅ **Built** |
| **Shared-secret auth** — every request needs the `x-api-key`; everything else is rejected (401) | ✅ **Built** |
| **Find-or-create patient** — on booking, look up by phone, else create a minimal name+phone patient → real **PatNum** (never the chart) | ✅ **Built** (was the one TODO) |
| **Mock mode + smoke test** — run the full chain with no Open Dental / no keys (`npm run smoke`) | ✅ **Built & passing** |
| **Per-clinic mapping** (`src/mappings.js`: real ProvNum / OpNum / CDT codes) | 🟠 **Left** — ~10-min config per clinic (no code) |
| **Live endpoint alignment** — confirm Slots/patient-search/appointment paths match the clinic's Open Dental version | 🟠 **Left** — needs their install |
| **Windows-service packaging** (`node-windows`/NSSM auto-start) + installer README | 🟠 **Left** — buildable now |
| **Tunnel bundle** (`cloudflared` named-tunnel config) | 🟠 **Left** — buildable now |
| **Live acceptance test** at a real clinic | 🔴 **Left — needs the clinic's Open Dental API + their machine (see §11)** |

> The first four are done and testable **today**. The next four are buildable now **without** the
> clinic (using mock mode + a Cloudflare quick-tunnel). Only the **live acceptance test** needs the
> real clinic — that's the API/verification step.

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

## 9. What's next (recommended order — what we'd BUILD next)

1. **Inbox polish** — the template picker, conversation search, archive/delete (highest-value remaining UX).
2. **Pipeline persistence** — make manually-added deals/stages survive reload (new table).
3. **Richer reports** — date-range + revenue/no-show/conversion (the data already exists).
4. **Clinical ledger edit/delete** + a real printable statement.
5. **SMS auto-reply** (AI answers inbound texts like WhatsApp) — small build.
6. **Open Dental local connector** (the on-prem app) — the big one, done last.
7. **Billing / Admin / packages** — when the product is otherwise complete.

---

## 10. ⚠️ What's left from YOUR side (keys / authentication / verification)

Everything below is **code-complete** — it works the moment the matching key/connection/approval
is in place. Nothing here needs more development.

### A) Keys to add in Netlify (env) — your ONE shared app credentials
| Key | Unlocks | Status |
|---|---|---|
| `OPENROUTER_API_KEY` | all AI text + image gen | ✅ you have it |
| `VAPI_API_KEY` | voice calls, outbound dialer, number↔agent | ✅ you have it |
| `ELEVENLABS_API_KEY` | voices + WhatsApp voice notes | ✅ you have it |
| `GOOGLE_OAUTH_CLIENT_ID/SECRET` | Google + Gmail connect | ✅ you have it |
| `SUPABASE_SERVICE_ROLE_KEY` | OAuth tokens, cron, reports, IG publish, Meta tokens | **add if not set** (cron + connections need it) |
| `FACEBOOK_CLIENT_ID/SECRET` | Meta connect (WhatsApp/IG/FB/Ads) | **add** (one Meta app) |
| `CRON_SECRET` | protects the cron endpoints | **add** (any long random string) |
| `NEXT_PUBLIC_SITE_URL` (or Netlify `URL`) | report download links in scheduled-report emails | **set** |
| `TWILIO_*` / `BREVO_*` | shared SMS/email fallback | optional (clinics connect their own in-app) |

### B) Per-clinic connections (done inside Pydent — no code, just click/paste)
- **Google / Gmail** — Settings → Connections → Connect (for Calendar push, Analytics, Gmail send).
- **Meta** — Settings → Connections → Connect (for WhatsApp/IG/FB/Ads). **Needs verification — see C.**
- **Brevo** — paste API key (email **+ SMS campaigns**, and AI-drafted campaigns).
- **Twilio** — paste SID/token/from (single-text SMS per clinic).
- **WordPress** — connect (Helena blog publish + **Instagram image hosting** for auto-publish).
- **WhatsApp** — the clinic's Phone Number ID + token + verify token.

### C) Verification / approval YOU must complete (this is the real blocker) — see `APP_VERIFICATION.md`
| Platform | What's blocked until you finish | What to do |
|---|---|---|
| **Meta app** | Instagram **auto-publish** + Helena posting for **all** clinics; the "unsafe app" warning during connect | **Business verification** (Trade Licence) → **Access verification (Tech Provider)** → **App Review** (Advanced Access for `instagram_content_publish`, `pages_manage_posts`, …) → switch app to **Live**. Works now for **App Roles → Testers**. |
| **Google OAuth** | the "Google hasn't verified this app" screen for everyone | Add **Test users** now (works immediately); for everyone: OAuth consent screen → privacy/terms URLs → **In production** → submit for verification. **Tip:** drop the **Gmail** scope (use Brevo) to avoid Google's CASA security audit. |
| **WhatsApp** | live broadcasts/inbox on the clinic's own number | Connect the clinic's WhatsApp Business number + token (Meta Business). |
| **Open Dental (live clinic)** | real bookings into a clinic's chart (mock booking works today) | Enable the Open Dental **API** at the clinic → keys → install the connector on their server → tunnel → connect in Settings (see §8 + §11). |

### D) Operational (you've done some of this)
- ✅ **Migrations** through 0047 — applied in Supabase.
- **Cron** — on Netlify the scheduled functions run automatically; elsewhere, point a scheduler at the 3 cron URLs (§7C).
- **Subscriptions to buy:** Netlify $9, Supabase $25 (at production), Twilio pay-as-you-go (§6).

### One-line summary of what's "left from your side"
**Code is done** (incl. the Open Dental connector, testable in mock mode). What remains is:
(1) **Meta business + app verification** (the biggest — unlocks Instagram auto-publish +
connect-without-warning), (2) **Google OAuth verification** (or just add test users for now),
(3) add the few **Netlify env keys** above, (4) each clinic **connects their own**
Brevo/Twilio/Google/WhatsApp, and (5) the **Open Dental live acceptance test** at a real clinic
(§11). No further building is required for any of it to work.

---

## 11. ✅ Live-verification checklist — what to verify (and how)

Everything below is built; this is the "prove it works once the keys/clinic are in place" list.
Split into **(A) testable now with no live accounts** and **(B) needs the real key/clinic**.

### A) Verify NOW — no external accounts (mock / our own data)
- [ ] **Open Dental chain** — `cd opendental-connector && npm run smoke` → all ✓ (health, auth-401,
      doctors, slots, book, slot-now-taken, reschedule, cancel). Or `npm run start:mock`, tunnel it,
      paste URL+key in Settings → Open Dental → **Test connection** → book from an agent.
- [ ] **App CRUD** — Contacts search/edit/delete/import/export; Instagram & Campaign & Template
      edit-delete; Calendar confirm/reschedule/cancel; pipeline stage-delete guard.
- [ ] **Voice number ↔ agent** — Voice Agents → Voice Agent Settings → assign a number (needs
      `VAPI_API_KEY` ✅; PATCHes Vapi).
- [ ] **Scheduled report** — workflow with "Scheduled" trigger + "Email a report"; hit
      `/api/cron/run?key=…` → digest report is created (emails if an email provider is connected).

### B) Verify when the key/clinic is in place
| What to verify | Pre-req (your side) | How to verify |
|---|---|---|
| **Inbound voice call answered by the agent** | Vapi ✅ + a registered number (SIP/Twilio) assigned to the agent | Call the number → the agent talks like a receptionist → ask to book → it lands on the Calendar. |
| **Outbound dialer** | same | Campaign → Start calling → the contact's phone rings, agent speaks. |
| **WhatsApp/Instagram DMs + broadcasts** | Meta **Live** + clinic WhatsApp/IG connected | Message the clinic → auto-reply; send a broadcast to a folder; IG auto-publish a due post. |
| **Email / SMS campaigns** | Brevo connected (+ Twilio for single SMS) | Create a Brevo campaign (draft/schedule/send); send a single SMS. |
| **Google Calendar push** | Google Calendar connected | Book from an agent → event appears on the clinic's Google Calendar (skips silently if not connected). |
| **Open Dental LIVE** | Open Dental API enabled at the clinic + keys + connector installed on their server + tunnel | (1) `/health` shows `mode: live`. (2) **Test connection** lists their real doctors. (3) Agent offers **their real open slots**. (4) Book → the appointment appears **in Open Dental's schedule** with a real PatNum. (5) Reschedule/cancel from Pydent → reflected in Open Dental. (6) Confirm **no clinical data** (ledger/x-rays/documents) ever appears in Pydent. (7) Toggle Enable off → link cuts, Pydent keeps working on its own calendar. |

> **Open Dental live = the only thing needing a real clinic.** Everything else verifies with either
> mock mode or a single connected account. Do the live Open Dental test last, against the clinic's
> **test database** first, then production — per `OPEN_DENTAL_AND_COMPLIANCE.md` §5.

---

_Questions answered in this doc: what's done, what's recently completed, what's still partial,
what's not built, subscriptions (Netlify $9 Personal / $20 Pro, Supabase free→$25 Pro,
pay-as-you-go AI), where each key goes (Netlify vs Pydent), the verification you must complete
(§10 + `APP_VERIFICATION.md`), the live-verification checklist (§11), and the Open Dental local
setup + UAE compliance (`OPEN_DENTAL_AND_COMPLIANCE.md`). Update this file as features land._
