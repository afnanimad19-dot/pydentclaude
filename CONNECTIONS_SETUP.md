# Connecting the integrations — what each platform needs

For every platform a clinic connects, **you (the owner) register ONE developer app**
once and put its keys in Netlify. After that, each clinic just clicks **Connect → a
popup → Allow → green Connected** (their own account, stored per workspace). Clinics
never touch Netlify.

**The golden rule (fixes 90% of errors):** in each platform's developer settings, add the
**exact Redirect/Callback URL** shown below — character for character (no trailing slash).

Your app origin is your site URL, e.g. `https://pydent.netlify.app` (use your real
domain in production).

---

## ✅ Google products — DONE (Analytics, Search Console, Business Profile, Ads, Drive, Calendar, YouTube)

- **Where:** Google Cloud Console → APIs & Services.
- **Env vars (Netlify):** `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`.
- **Redirect URI:** `https://pydent.netlify.app/api/google/oauth/callback`
- **Note:** publish the app + add scopes on the OAuth consent screen (you've done this).
  Enable each API you use (Analytics Data API, Search Console API, Business Profile API,
  Google Ads API, Drive API, Calendar API, YouTube Data API) under "Enabled APIs".

---

## 🟦 Generic OAuth providers (wired — just add the keys)

Each of these works the moment you add its two env vars in Netlify and register the
redirect URI. The dashboard auto-detects when a provider is configured.

| Platform | Register an app at | Env vars (Netlify) | Redirect URI to register |
|---|---|---|---|
| **Facebook Pages** | developers.facebook.com (Meta app, "Facebook Login") | `FACEBOOK_CLIENT_ID`, `FACEBOOK_CLIENT_SECRET` | `…/api/oauth/facebook/callback` |
| **Instagram** | same Meta app (Instagram Graph) | `FACEBOOK_CLIENT_ID`, `FACEBOOK_CLIENT_SECRET` | `…/api/oauth/instagram/callback` |
| **Meta Ads** | same Meta app (Marketing API) | `FACEBOOK_CLIENT_ID`, `FACEBOOK_CLIENT_SECRET` | `…/api/oauth/meta_ads/callback` |
| **LinkedIn** | linkedin.com/developers | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | `…/api/oauth/linkedin/callback` |
| **Reddit** | reddit.com/prefs/apps (type: web app) | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | `…/api/oauth/reddit/callback` |
| **Pinterest** | developers.pinterest.com | `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET` | `…/api/oauth/pinterest/callback` |
| **WordPress.com** | developer.wordpress.com/apps | `WORDPRESS_CLIENT_ID`, `WORDPRESS_CLIENT_SECRET` | `…/api/oauth/wordpress/callback` |
| **TikTok** | developers.tiktok.com | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | `…/api/oauth/tiktok/callback` |

(Meta's three products — Pages, Instagram, Meta Ads — share **one** Meta app, so the same
`FACEBOOK_CLIENT_ID/SECRET` powers all three; you just request the right permissions in
the Meta app review.)

After adding the keys, **redeploy** and the cards switch from "setup needed" to a real
Connect popup.

---

## 🟧 Special cases (need a bespoke flow — tell me to wire when you're ready)

These don't fit the standard popup and need a little custom work:

- **X (Twitter)** — uses OAuth2 with PKCE. Register at developer.twitter.com; I'll add the
  PKCE flow. Env: `TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET`.
- **Shopify** — asks for the clinic's **store domain** (`yourstore.myshopify.com`) first,
  then OAuth. Register a Shopify app; env: `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`.
- **WordPress (Self-Hosted)** — no OAuth; the clinic pastes their **site URL + an
  Application Password** (WP Admin → Users → Profile → Application Passwords).
- **TikTok Ads** — separate from TikTok posting (TikTok Marketing API); different app.
- **Google Business Profile** — works via the Google flow, but its API needs special
  access approval from Google for write actions.
- **Stripe / Notion** — different connect model (Stripe Connect / Notion integration token).

---

## How the multi-tenant part works (recap)
- The env keys above are **your app's** keys (one set). 
- When a clinic connects, we store **their** token in `oauth_tokens` keyed by their
  `workspace_id`, and a green status in `connections`. Disconnect removes both.
- So every clinic connects its own accounts; nothing is shared, nothing is in Netlify
  except your one app per platform.

> Want a specific platform live next? Tell me which, register its app, send me the env var
> names you used, and I'll confirm the wiring + scopes.

---

# 📍 Step by step — WHERE to paste the redirect URL on each platform

The #1 confusion: most platforms have **two different fields**:
- an **"App Domain / Website"** field — that takes just the bare domain
  `pydent.netlify.app` (no `https://`, no `/path`).
- a **"Redirect URI / Callback URL"** field — that takes the **full** URL ending in
  `/callback`. **This is the important one.**

Use your real domain instead of `pydent.netlify.app` when you have one.

## Meta — Facebook Pages, Instagram, Meta Ads (one app for all three)
You asked about this one specifically — here's exactly where:
1. Go to **developers.facebook.com** → **My Apps** → **Create App** → choose **Business** → finish.
2. In the app, left sidebar → **Add Product** → find **Facebook Login** → **Set up**.
3. **Settings → Basic** (left sidebar):
   - Copy **App ID** → that's your `FACEBOOK_CLIENT_ID`.
   - Click **Show** on **App Secret** → that's your `FACEBOOK_CLIENT_SECRET`.
   - In **App Domains**, type just: `pydent.netlify.app`  ← (domain only — NOT the callback URL).
   - Add a **Privacy Policy URL** (required to go live). Click **Save changes**.
4. ⭐ **The redirect URL goes here:** left sidebar → **Facebook Login → Settings**
   (this is UNDER the Facebook Login product, not the Basic page). In the field
   **"Valid OAuth Redirect URIs"**, paste these three (one per line) and Save:
   ```
   https://pydent.netlify.app/api/oauth/facebook/callback
   https://pydent.netlify.app/api/oauth/instagram/callback
   https://pydent.netlify.app/api/oauth/meta_ads/callback
   ```
5. To let real clinics (not just you) connect: **App Review → Permissions and Features**,
   request the permissions (pages_show_list, instagram_basic, ads_read, etc.) and switch
   the app **Live** (top toggle). While in Development mode, only you/test users can connect.
6. Put the App ID/Secret in **Netlify → Environment variables**, redeploy.

> So: **App Domains** = `pydent.netlify.app`. **Valid OAuth Redirect URIs** (under Facebook
> Login → Settings) = the full `.../callback` links. Two different boxes.

## LinkedIn
1. **linkedin.com/developers** → **Create app** (link it to a company page).
2. Open the app → **Auth** tab.
3. Copy **Client ID** (`LINKEDIN_CLIENT_ID`) and **Client Secret** (`LINKEDIN_CLIENT_SECRET`).
4. ⭐ Under **OAuth 2.0 settings → "Authorized redirect URLs for your app"** → **Add redirect URL**:
   ```
   https://pydent.netlify.app/api/oauth/linkedin/callback
   ```
5. **Products** tab → add "Share on LinkedIn" / "Sign In with LinkedIn" to get the scopes.

## Reddit
1. **reddit.com/prefs/apps** → scroll down → **"create another app…"**.
2. Choose type **web app**.
3. ⭐ In the **"redirect uri"** field paste:
   ```
   https://pydent.netlify.app/api/oauth/reddit/callback
   ```
4. Create. The string **under the app name** is your `REDDIT_CLIENT_ID`; the **"secret"**
   field is `REDDIT_CLIENT_SECRET`.

## Pinterest
1. **developers.pinterest.com** → **My apps** → create/connect an app.
2. Copy **App ID** (`PINTEREST_CLIENT_ID`) and **App secret** (`PINTEREST_CLIENT_SECRET`).
3. ⭐ In the app's **Redirect URIs** field, add:
   ```
   https://pydent.netlify.app/api/oauth/pinterest/callback
   ```

## WordPress.com
1. **developer.wordpress.com/apps** → **Create New Application**.
2. ⭐ In **Redirect URLs**, paste:
   ```
   https://pydent.netlify.app/api/oauth/wordpress/callback
   ```
3. Type = **Web**. Save. Copy **Client ID** (`WORDPRESS_CLIENT_ID`) and
   **Client Secret** (`WORDPRESS_CLIENT_SECRET`).

## TikTok
1. **developers.tiktok.com** → **Manage apps** → create an app.
2. Add the **Login Kit** product.
3. ⭐ In **Login Kit → Redirect URI**, add:
   ```
   https://pydent.netlify.app/api/oauth/tiktok/callback
   ```
4. App credentials show a **Client key** (`TIKTOK_CLIENT_KEY`) and **Client secret**
   (`TIKTOK_CLIENT_SECRET`).

## Google (recap — where the box is)
Google Cloud Console → **APIs & Services → Credentials** → click your **OAuth 2.0 Client ID**
→ ⭐ **"Authorized redirect URIs" → ADD URI**:
```
https://pydent.netlify.app/api/google/oauth/callback
```

---

### After adding any platform
1. Put its two values in **Netlify → Site configuration → Environment variables**.
2. **Trigger a redeploy** (Netlify → Deploys → Trigger deploy) so the keys load.
3. In Pydent → Settings → Connections, the card flips from "setup needed" to a real
   **Connect** popup. Click it → Allow → green **Connected**.

If you get a "redirect_uri_mismatch" or "invalid redirect" error, it's always step ⭐:
the URL in the platform must match **exactly** (same `https://`, same domain, no extra
slash) — copy-paste it, don't type it.

