# Publishing & Verifying the Meta and Google apps

This is the exact, step-by-step process to take **your** Meta app and **your** Google
app from "development / testing" (only works for you) to **Live / In production**
(works for real clinics). It's written against the scopes this codebase actually
requests, so follow it literally.

> **First, fill in your production origin once and reuse it everywhere below.**
> It's your deployed site URL, e.g. `https://pydent.netlify.app`. Every redirect URI
> and policy URL below uses `<ORIGIN>` — replace it with that exact value (no trailing
> slash, `https://` only). If Meta/Google ever show `redirect_uri_mismatch`, it's
> because this didn't match character-for-character.

---

# PART A — META (Facebook Pages + Instagram + WhatsApp + Meta Ads)

### What your app asks for (so you know what needs review)
| Product | Permissions this app requests |
|---|---|
| Facebook Pages | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` |
| Instagram | `instagram_basic`, `instagram_content_publish`, `pages_show_list` |
| Meta Ads | `ads_read`, `ads_management`, `business_management` |
| WhatsApp | `whatsapp_business_management`, `whatsapp_business_messaging` |

Everything except `public_profile`/`email` is an **Advanced Access** permission →
it needs **App Review** + **Business Verification** before the public can use it.

### Why it "won't publish" right now (the two real reasons)
1. **The Live toggle is greyed out** → you're missing required Basic Settings
   (Privacy Policy URL, and usually a Data Deletion URL, app icon, category). Fix in A1.
2. **It flipped to Live but Instagram/Pages/WhatsApp don't work for other people** →
   the app is Live but the permissions are still **Standard Access** (works only for
   people with a *role* on the app — admins/developers/testers). You must get
   **Advanced Access** via App Review (A4). Until then, add each clinic as a **Tester**
   (A6) so they can use it immediately while review is pending.

---

## A1. Basic Settings — this unblocks the "Live" switch
developers.facebook.com → **My Apps** → your app → **App settings → Basic**:
- **Display name**, **App icon** (1024×1024 PNG), **Category** (e.g. "Business").
- **Privacy Policy URL** → `<ORIGIN>/privacy` (must be a real, reachable page).
- **User Data Deletion** → either a **Data Deletion Instructions URL**
  (`<ORIGIN>/data-deletion`) or a callback. A page explaining how a user deletes
  their data is enough for the URL option.
- **App Domains** → your domain (e.g. `pydent.netlify.app`).
- **Business Account** → connect the app to your **Meta Business** (needed for A3).
- Click **Save Changes**. The **App Mode** toggle (top bar) becomes usable once the
  required fields are filled.

## A2. Products & redirect URIs (must match this codebase)
Add the products you use (left sidebar → **Add Product**): **Facebook Login**,
**Instagram** (Instagram Graph API), **WhatsApp**, **Marketing API** (for ads).

**Facebook Login → Settings → Valid OAuth Redirect URIs** — add ALL of these:
```
<ORIGIN>/api/oauth/facebook/callback
<ORIGIN>/api/oauth/instagram/callback
<ORIGIN>/api/oauth/meta_ads/callback
```
**WhatsApp → Configuration → Webhook:**
```
Callback URL:  <ORIGIN>/api/whatsapp/webhook
Verify token:  (the value of your WHATSAPP_VERIFY_TOKEN env var)
```
Then **Subscribe** the webhook to the `messages` field.

> Env vars this needs in Netlify: `FACEBOOK_CLIENT_ID`, `FACEBOOK_CLIENT_SECRET`,
> `WHATSAPP_VERIFY_TOKEN` (+ your WhatsApp phone-number/token config).

## A3. Business Verification (do this early — it takes the longest)
**Meta Business Suite → Business Settings → Security Center → Business Verification.**
- Provide legal business name, address, phone, website, and a document (trade
  licence / incorporation). For UAE: your DED/free-zone trade licence works.
- Meta verifies by calling/emailing/mailing a code. This can take **2–14 days**.
- App Review for advanced permissions **cannot be approved until this passes.**

## A4. App Review — request Advanced Access per permission
App → **App Review → Permissions and Features**. For each permission in the table
above, click **Request Advanced Access**. Meta will ask you to submit a use case:
- **How your app uses it** — write plainly, e.g.:
  - `instagram_content_publish` → "The clinic schedules and publishes its own
    Instagram posts from the Pydent calendar."
  - `pages_manage_posts` → "Publishes the clinic's own Facebook Page posts."
  - `ads_management` → "Creates/manages the clinic's own ad campaigns."
- **Screencast** — record a screen video showing: a user logs into Pydent →
  clicks Connect → the Facebook login dialog with that permission → the feature
  working (e.g. a post publishing). This is mandatory; most rejections are a
  missing or unclear screencast.
- **Test credentials** — give Meta a Pydent login so a reviewer can reproduce it.
- Submit. Review typically takes **a few days to ~2 weeks**.

> WhatsApp is slightly different: `whatsapp_business_messaging` becomes usable once
> your WhatsApp Business Account is set up and (for production volume) your business
> is verified; the same Business Verification in A3 covers it.

## A5. Flip the app to Live
Once A1 is complete: toggle **App Mode → Live** (top of the dashboard). Approved
permissions now work for everyone; not-yet-approved ones still only work for roles/testers.

## A6. Let clinics use it BEFORE review finishes (do this now)
App → **Roles → Roles** (and **Instagram Testers** under the Instagram product) →
add each clinic's Facebook account as a **Tester** → they accept the invite at
`facebook.com/settings` → *Business Integrations/Requests*. Testers get Advanced
Access immediately, so you can onboard clinics while App Review is pending.

---

# PART B — GOOGLE (Calendar, Gmail send, Analytics, Search Console, Drive, Ads, GBP, YouTube)

### What your app asks for (this decides the review tier)
| Scope | Google's tier | Review needed |
|---|---|---|
| `calendar.events` | **Sensitive** | OAuth verification |
| `analytics.readonly` | **Sensitive** | OAuth verification |
| `webmasters.readonly` (Search Console) | **Sensitive** | OAuth verification |
| `business.manage` (Google Business Profile) | **Sensitive** | OAuth verification |
| `adwords` (Google Ads) | **Sensitive** | OAuth verification |
| `youtube.readonly` | **Sensitive** | OAuth verification |
| `drive.readonly` | **RESTRICTED** | Verification **+ CASA security assessment** |
| `gmail.send` | **RESTRICTED** | Verification **+ CASA security assessment** |

The **Restricted** scopes (`gmail.send`, `drive.readonly`) are the "safety thing" —
they require Google's **CASA (Cloud Application Security Assessment)**, an annual
third-party security review. That's the slow, expensive part.

> **Recommendation to unblock fast:** if you don't strictly need Gmail-send and
> Drive right now (Pydent already sends email via Brevo, not Gmail), **remove those
> two scopes** from the verification submission. Then you only need standard OAuth
> verification for the Sensitive scopes — no CASA. You can add Gmail/Drive back later
> in a separate submission when you're ready to do CASA. (In code they live in
> `src/app/api/google/oauth/route.ts` → the `SCOPES` map — leaving a product
> unlisted in the consent screen simply means it won't be part of this review.)

## B1. OAuth consent screen
console.cloud.google.com → your project → **APIs & Services → OAuth consent screen**:
- **User type: External.**
- **App name**, **User support email**, **App logo**.
- **App domain** → `<ORIGIN>`; **Authorized domains** → `pydent.netlify.app`
  (your bare deployed domain, no `https://`, no path).
- **Developer contact email.**
- **Privacy Policy URL** → `<ORIGIN>/privacy`; **Terms of Service URL** →
  `<ORIGIN>/terms`. Both must be live pages on that domain (a verification blocker).

## B2. Authorized redirect URI (must match this codebase exactly)
**APIs & Services → Credentials → your OAuth 2.0 Client ID → Authorized redirect URIs:**
```
<ORIGIN>/api/google/oauth/callback
```
Also add each Google API you use under **APIs & Services → Enabled APIs**
(Calendar API, Analytics Data API, Search Console API, Business Profile API,
Google Ads API, plus Gmail/Drive only if you keep those scopes).

> Env vars in Netlify: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

## B3. Add scopes + submit for verification
On the consent screen **Scopes** step → **Add or Remove Scopes** → add exactly the
scopes you're keeping (see B2 recommendation). Then **Publishing status → Publish
app → Prepare for verification**, and submit. Google asks for:
- A **justification** per sensitive scope (why the app needs it, e.g. "write clinic
  appointments to the user's Google Calendar").
- A **demo video** (YouTube link) showing: the OAuth consent screen with your scopes
  → the granted feature working. Same idea as Meta's screencast.
- Confirmation your Privacy Policy states how you use Google user data.
Standard sensitive-scope verification usually takes **a few days to a few weeks**.

## B4. CASA security assessment (ONLY if you keep `gmail.send` / `drive.readonly`)
If you keep a Restricted scope, Google emails you to start **CASA** via an authorized
lab (e.g. TAC Security / others). You'll:
- Complete a **self-assessment questionnaire**, or a **Tier-2** assessment with a
  scan/pentest of `<ORIGIN>`.
- Fix any findings, submit evidence, and pass. It's an **annual** requirement and can
  take **several weeks**; some labs charge a fee.
- This is why the B2 recommendation matters — drop these two scopes now if you can,
  and you skip CASA entirely for launch.

## B5. Use it BEFORE verification finishes (do this now)
While in **Testing** publishing status, add each clinic's Google account under
**OAuth consent screen → Test users** (up to 100). Test users bypass the "unverified
app" warning and can grant all scopes immediately — so you can onboard while the
verification is in review. Once verified, switch **Publishing status → In production.**

---

# The fastest path to "live for real clinics"
1. **Now:** fill Basic Settings / consent screen (A1, B1), add redirect URIs (A2, B2),
   publish privacy + terms pages. Add clinics as **Testers/Test users** (A6, B5) so
   they work today.
2. **Start immediately (slow items):** Meta **Business Verification** (A3) and, if you
   keep Gmail/Drive, Google **CASA** (B4). These gate everything else.
3. **Then submit App Review (A4) / OAuth verification (B3)** with the screencasts.
4. **Flip to Live / In production** (A5, B5) once approved.

**Pages you must publish for BOTH** (verification blockers): a real **Privacy Policy**
(`<ORIGIN>/privacy`), **Terms** (`<ORIGIN>/terms`), and **Data Deletion** info
(`<ORIGIN>/data-deletion`). If these don't exist yet, that's the very first thing to
build — nothing else gets approved without them.
