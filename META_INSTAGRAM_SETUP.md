# Meta (Instagram + Facebook + Messenger) — Setup & the "this app isn't safe" warning

This is the step-by-step for connecting a clinic's **Instagram** (and Facebook Page / Messenger / Meta Ads) so Pydent's AI (Helena) can publish posts and reply to DMs — and how to get rid of the **"this app isn't safe / unverified app"** screen people see when connecting.

There are **two layers** and people confuse them:

1. **The Pydent platform setup (you, once)** — create ONE Meta app, put its `App ID` + `App Secret` into Netlify. This powers every clinic's "Connect" button.
2. **The clinic setup (each clinic, self-serve)** — the clinic clicks **Connect**, logs in with Facebook, and grants access. No keys to paste.

The "unsafe app" warning is about **App Review / verification** of *your* Meta app — covered in section 4.

---

## 1. What the clinic needs *before* connecting (prerequisites)

Instagram publishing through the API only works if **all** of these are true. If a clinic can't connect, it's almost always one of these:

- The clinic's Instagram is a **Business** or **Creator** account (not a personal account).
  - In the Instagram app: **Settings → Account type and tools → Switch to professional account → Business**.
- That Instagram account is **linked to a Facebook Page**.
  - Facebook Page → **Settings → Linked accounts → Instagram → Connect**.
- The person connecting is an **admin** of that Facebook Page.
- The clinic has a **Meta Business Portfolio** (Business Manager) — recommended, and required to pass verification.

> Why: our code reads the Page and its linked `instagram_business_account` to publish. No Page link = nothing to post to.

---

## 2. Platform setup — create the Meta app (you do this once)

1. Go to **https://developers.facebook.com/apps** → **Create app**.
2. App type: **Business**.
3. Add these **products** to the app:
   - **Facebook Login** (this is what the "Connect" popup uses).
   - **Instagram Graph API** (for publishing) — and **Instagram API / Instagram Basic Display** as prompted.
   - (Optional) **Marketing API** if the clinic will also connect Meta Ads.
4. In **Facebook Login → Settings**, add the exact **Valid OAuth Redirect URIs** (use your real domain):
   ```
   https://YOUR-DOMAIN/api/oauth/instagram/callback
   https://YOUR-DOMAIN/api/oauth/facebook/callback
   https://YOUR-DOMAIN/api/oauth/meta_ads/callback
   ```
   (For local testing: `http://localhost:3000/api/oauth/instagram/callback`, etc.)
5. Copy the app's **App ID** and **App Secret** (Settings → Basic).
6. In **Netlify → Site settings → Environment variables**, add:
   ```
   FACEBOOK_CLIENT_ID=<App ID>
   FACEBOOK_CLIENT_SECRET=<App Secret>
   ```
   The same app powers `instagram`, `facebook`, and `meta_ads` connections. Redeploy.

Once these env vars exist, the **Connect** buttons on the clinic's Settings → Connections become live popups (Pydent checks this via `/api/oauth/configured`).

### Permissions (scopes) the app requests
Pydent already requests the right scopes when connecting Instagram:
`instagram_basic`, `instagram_content_publish`, `pages_show_list`.
For full posting on Business accounts Meta also expects **`pages_read_engagement`** and **`pages_manage_posts`** on the Page, and **`business_management`**. These need **Advanced Access** (section 4).

---

## 3. The clinic's "Connect" flow (self-serve)

1. Clinic → **Settings → Connections** → find **Instagram** → **Connect**.
2. A Facebook login popup opens → they log in → **choose the Page + Instagram account** → **grant** the permissions.
3. Done — the token is stored per-clinic. Helena can now publish.

The clinic never pastes a token or ID. (Under the hood we capture the user token, then the Page token + the linked Instagram business id from `/me/accounts`.)

---

## 4. The "this app isn't safe" / "unverified app" warning — why, and how to remove it

### Why it shows
Meta shows it when **any** of these is true:
- Your Meta app is still in **Development mode**, OR
- The permissions you request (e.g. `instagram_content_publish`, `pages_manage_posts`) only have **Standard Access** (not yet approved for public use), AND
- The person connecting is **not** a listed role on the app (admin/developer/tester), AND
- Your **business isn't verified** / the app hasn't passed **App Review**.

### Permanent fix (do this to ship to real clinics)
1. **Business Verification** — Meta Business Settings → **Security Center / Business verification** → verify the clinic's (or your agency's) legal business. This unlocks Advanced Access.
2. **App Review** — App Dashboard → **App Review → Permissions and Features** → request **Advanced Access** for:
   - `instagram_basic`, `instagram_content_publish`
   - `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`
   - (`ads_read` / `ads_management` / `business_management` if using Meta Ads)
   - You'll record a short **screencast** of the connect + publish flow and explain the use case ("a dental clinic schedules/publishes its own Instagram posts via our dashboard").
3. **Switch the app to Live mode** (toggle at the top of the App Dashboard). After approval, **any** clinic can connect with **no warning**.

### Temporary bypass (for testing / your own clinics, before review)
- Keep the app in **Development mode** and add each tester as an **App Role**:
  - App Dashboard → **App roles → Roles → Add People** → add the clinic's Facebook user as **Administrator**, **Developer**, or **Tester** → they **accept** the invite (Notifications on facebook.com).
  - Listed users can use the **unverified** app fully, with no warning.
- Or, on the warning screen itself, click **Advanced / "See options" → "Continue to <App> (unsafe)"** to proceed for that one login. (Fine for your own testing; don't ask real clinics to do this.)

> TL;DR: **App Review + Business Verification + Live mode** = no warning for everyone. **Add the user as a Tester** = no warning for that user right now.

---

## 5. One gotcha we should finish for production

The current OAuth callback stores the **short-lived** user token, which expires in ~1–2 hours, so Helena's posting can stop working after a while. Production hardening (tracked):
- After the token exchange, call
  `GET /oauth/access_token?grant_type=fb_exchange_token&client_id=…&client_secret=…&fb_exchange_token=<short>`
  to get a **~60-day long-lived token**, and capture a **Page access token** (often non-expiring) via `/me/accounts`.
- Add token-refresh / re-prompt handling.

This doesn't change the clinic's steps above — it just makes the connection durable.

---

## 6. Quick checklist

**You (once):**
- [ ] Create Business app, add Facebook Login + Instagram Graph API
- [ ] Add the 3 redirect URIs
- [ ] Put `FACEBOOK_CLIENT_ID` + `FACEBOOK_CLIENT_SECRET` in Netlify, redeploy
- [ ] Business Verification + App Review (Advanced Access) + switch to Live

**Each clinic:**
- [ ] Instagram = Business/Creator, linked to a Facebook Page they admin
- [ ] Settings → Connections → Instagram → Connect → grant
