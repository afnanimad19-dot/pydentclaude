# Pydental — Go-Live Checklist (demo → real product)

This is the list of everything needed to turn the demo into a live product you can
sell to dental clinics, with where to get each API key. Items marked **DONE** are
already wired in the app; the rest are what's left.

---

## 1. Already connected (DONE)

| Service | What it does | Where it's set |
|---|---|---|
| **Supabase** | Database + login | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| **OpenRouter** | Chat-agent AI replies (GPT / Claude) | `OPENROUTER_API_KEY` |
| **Vapi** | Voice agents (calls, voices) | `VAPI_API_KEY` |
| **Google Calendar** | Mirror appointments | `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` |
| **Netlify** | Hosting / deploys | — |

> For Vapi to take real calls you still need to **buy a phone number** inside the
> Vapi dashboard and assign it to an assistant.

---

## 2. Messaging channels — the core of the product

These are what make the inbox, agents and broadcasts real instead of demo. Each
clinic connects their own accounts (multi-tenant), but **you** need a Meta app,
a Twilio account, etc. as the platform owner first.

### 2a. Meta — WhatsApp + Instagram + Facebook Messenger
All three live under **one** Meta app. "Meta" and "Facebook" are the same login.

1. Create a Meta app: https://developers.facebook.com/apps
2. Add **WhatsApp**, **Instagram**, and **Messenger** products to the app.
3. Set up a Meta Business account: https://business.facebook.com
4. WhatsApp Cloud API docs: https://developers.facebook.com/docs/whatsapp/cloud-api
5. Instagram messaging: https://developers.facebook.com/docs/messenger-platform/instagram
6. Messenger (Facebook Page): https://developers.facebook.com/docs/messenger-platform
7. You'll need **App Review** for `whatsapp_business_messaging`,
   `instagram_manage_messages`, `pages_messaging` permissions before going live.

Keys/values to collect: `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`
(you choose this), plus each clinic's `WABA_ID` / page tokens (collected in-app
during their onboarding).

**In-app:** clinics now enter their WhatsApp credentials at
**Settings → WhatsApp Business → Set up** (`/dashboard/settings/whatsapp`):
Phone Number ID, WABA ID, Access Token, a Verify Token they choose, and the
two-step PIN. That page also shows the **Webhook Callback URL** to paste into
Meta — it points at the live endpoint `/api/whatsapp/webhook`, which already
answers Meta's verification handshake. (Inbound message → Inbox routing is the
next build; the endpoint currently 200-acks and has a TODO for HMAC + parsing.)

**WhatsApp template approval**: marketing/broadcast templates must be approved by
Meta before sending — already tracked in the WhatsApp → Templates screen.

### 2b. SMS — Twilio
- Sign up: https://www.twilio.com/try-twilio
- Console (get keys): https://console.twilio.com → `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`
- Buy a number / A2P 10DLC registration (required for US business SMS):
  https://www.twilio.com/docs/messaging/compliance/a2p-10dlc

### 2c. Email
- **Sending campaigns (Resend):** https://resend.com → `RESEND_API_KEY`,
  then verify your sending domain (SPF/DKIM): https://resend.com/docs/dashboard/domains
- **Gmail / Google Workspace (per-clinic inbox sync):** reuse the existing Google
  Cloud project. Enable the Gmail API and add the scope
  `https://www.googleapis.com/auth/gmail.modify`:
  https://console.cloud.google.com/apis/library/gmail.googleapis.com

### 2d. Website chat widget
- The Settings → Website card shows the embed snippet. To make it real you need to
  host `widget.js` on a CDN/your domain and have it open a conversation via the
  same inbox API the channels use. A **WordPress plugin** wrapper can come later.

---

## 3. Payments / billing (to actually charge clinics)

- **Stripe** (subscriptions for clinics, optional patient payments):
  https://dashboard.stripe.com/register → `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`,
  `STRIPE_WEBHOOK_SECRET`
- Requires a registered business + bank details. This was intentionally left out
  until you have the business account. Stripe Billing for SaaS plans:
  https://stripe.com/billing

---

## 4. Compliance (important for dental / patient data)

Dental clinics handle PHI, so in the US this means **HIPAA**. Before selling:
- Sign a **BAA (Business Associate Agreement)** with each subprocessor that touches
  patient data:
  - Supabase (Team plan+): https://supabase.com/docs/guides/security/hipaa-compliance
  - Twilio: https://www.twilio.com/docs/glossary/what-is-hipaa
  - Meta WhatsApp: review healthcare/PHI restrictions in their terms
  - Resend / Google Workspace: both offer BAAs on paid plans
- Add a privacy policy + terms, patient opt-in/opt-out (STOP keyword), and audit logging.

---

## 5. Suggested order to go live

1. **Meta app** (WhatsApp first — highest value) → connect one real clinic number,
   build the webhook so inbound messages hit the inbox.
2. **Twilio SMS** → reminders + 2-way texting.
3. **Resend + Gmail** → email campaigns and inbox sync.
4. **Website widget** → capture leads from clinic sites.
5. **Stripe Billing** → start charging subscriptions.
6. **HIPAA/BAAs + legal** → required before handling real patient data at scale.
7. **OpenDental import** (later) → unlock the Patient-chart clinical modules
   (currently hidden behind a feature flag).

---

## 6. Env vars summary (set in Netlify → Site configuration → Environment variables)

```
# Already set
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
OPENROUTER_API_KEY=
VAPI_API_KEY=
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=

# To add as you connect each channel
META_APP_ID=
META_APP_SECRET=
META_VERIFY_TOKEN=
WHATSAPP_VERIFY_TOKEN=   # optional platform-wide override; otherwise the per-clinic token from Settings is used
ENCRYPTION_KEY=          # 64 hex chars — encrypt stored WhatsApp access tokens (AES-256-GCM) before real launch
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
RESEND_API_KEY=
STRIPE_SECRET_KEY=
STRIPE_PUBLISHABLE_KEY=
STRIPE_WEBHOOK_SECRET=
SUPABASE_SERVICE_ROLE_KEY=   # needed to store per-clinic OAuth connections server-side
```
