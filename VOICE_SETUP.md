# Voice, phone numbers & a few "how do I…" answers

## 1. Getting a phone number for the voice agent (incl. UAE +971)

The voice agent runs on **Vapi**. A call works like: caller → your phone number →
Vapi → your agent. So you need a number that points to Vapi.

**Option A — buy a number inside Vapi (easiest):**
1. Vapi dashboard → **Phone Numbers** → **Buy Number**.
2. Pick a country/area. (Vapi resells **Twilio** numbers — US/UK/etc. are instant.)
3. Assign your assistant to it. Done — calls to that number hit the agent.

**Option B — bring a Twilio number:**
1. Create a **Twilio** account → buy a number (Twilio sells many countries).
2. In Vapi → Phone Numbers → **Import from Twilio** (paste your Twilio Account SID +
   Auth Token + the number).
3. Assign the agent.

**Option C — UAE +971 local number (your case):**
UAE numbers usually **aren't sold self-serve** by Twilio/Vapi (regulated). Two ways:
- **SIP trunk** — get a +971 number from a UAE provider/carrier (or a SIP provider that
  offers UAE DIDs), then connect it to Vapi as a **SIP trunk** (Vapi → Phone Numbers →
  **SIP/BYO**). You enter the SIP termination URI, username/password, etc. (this is the
  SIP-trunk form you saw on Callab) — Vapi then routes that number to the agent.
- **Use an existing clinic +971 number** — point/forward it to the Vapi SIP trunk via your
  telecom provider.

**In Pydent:** once the number exists in Vapi, go to **Voice Agents → Phone Numbers → Add
phone number**, paste it (E.164, e.g. `+9714…`), and assign the voice agent. (Full SIP-trunk
creation from inside Pydent — the multi-field form like Callab — is on the build list; for
now the number is created in Vapi and registered here.)

> You said the Vapi + ElevenLabs keys are already set — so once a number is in Vapi and added
> here, calling it will talk to your agent.

## 2. Meta App "Live" + permissions (for Instagram/Facebook posting & DMs)

1. developers.facebook.com → your app → top toggle **Development → Live**.
2. **App Review → Permissions and Features** → request the ones you use:
   - `pages_show_list`, `pages_manage_posts`, `pages_read_engagement` (Facebook posting)
   - `instagram_basic`, `instagram_content_publish` (Instagram posting — needs a Business
     IG account linked to the Page)
   - `ads_read` (Meta Ads reporting)
3. Provide the review info Meta asks (screencast, privacy policy, use-case description).
4. While in Development mode, only **app roles/test users** can use it — add yourself as a
   tester to try before approval.

## 3. "What is autopilot firing?"

Autopilot = the scheduled tasks you set on an agent ("every Monday, draft a blog"). Saving a
task just stores it. **"Firing" = it actually running on the timer.** For that, something has
to wake the app on schedule and call `/api/cron/run`. Set it up once:
- Add `CRON_SECRET` in Netlify.
- Point a scheduler at `https://<your-site>/api/cron/run?key=<CRON_SECRET>` every ~15 min —
  via **Netlify Scheduled Functions**, **Supabase cron**, or a free service like
  **cron-job.org**.
Until that's set, tasks are saved but won't run automatically (the UI says so).

## 4. Email connectors (Brevo / Mailchimp)

They now appear as cards in **Settings → Connections**. Brevo is recommended (free tier,
simple). Click Connect for the steps:
- **Brevo:** create an API key (Brevo → Settings → SMTP & API → API Keys), add
  `BREVO_API_KEY` + `BREVO_FROM_EMAIL` (a verified sender) in Netlify → Angela can send.
- **Mailchimp:** key stored; campaign send is the next wiring step.

## 5. Crawling/SEO repos (firecrawl, crawl4ai) — my opinion

- **Firecrawl** — a hosted **API** that turns a whole website into clean text/markdown for
  LLMs (crawl all pages, not just one). **Useful** for: deep website knowledge import (whole
  site → brand knowledge) and Sam crawling a competitor site for analysis. Easiest to adopt
  (an API key + a call). Paid per crawl.
- **crawl4ai** — open-source crawler (self-host). Same idea, free, but you host it. More
  setup/ops; good if you want zero per-crawl cost at scale.

**Firecrawl is now wired ✅.** Add `FIRECRAWL_API_KEY` (from firecrawl.dev) in Netlify and:
- The agent **"Import from your website"** crawls the **whole site** (up to ~20 pages) into
  knowledge instead of one page.
- **Sam** has a `crawl_url` tool (read a competitor page, or `whole_site` to crawl it) for SEO/
  competitor analysis; **Helena** has `research_url` for content research.
Without the key, both fall back to a basic single-page fetch. (crawl4ai can be self-hosted
later to avoid per-crawl cost.)

## 6. Open Dental

Understood — you have the API key but won't connect it yet so the **live clinic isn't
disturbed**. Good call. Nothing we've built touches Open Dental until you enable it in
Settings → Open Dental. When you're ready (in a day or two), we test against it carefully.
