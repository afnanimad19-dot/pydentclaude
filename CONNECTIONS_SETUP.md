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
