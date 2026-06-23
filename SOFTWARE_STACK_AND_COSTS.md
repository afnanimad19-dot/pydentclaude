# Pydent — Full Software Stack, Costs & Business Model

A plain-language guide to **everything** we use to build Pydent (the dental software +
the enrichlabs-style AI marketing agent), what each piece costs, and **how the money
works** when other clinics use it. Written for a non-deeply-technical owner. Prices are
USD and were estimated **June 2026** — always confirm on each vendor's pricing page
before quoting, because usage prices change.

---

## 1. What we're building (the vision)

Two products fused into one:

1. **Pydent (the dental side)** — inbox (WhatsApp/Instagram/SMS/email), AI chat + voice
   agents, calendar, booking, Open Dental connection.
2. **An "AI marketing agent" (the enrichlabs.ai style)** — a chat agent (like "Helena")
   that the clinic talks to in plain English and it *does work*: writes blogs, saves them
   as documents, drafts them into WordPress, generates images and sets featured images,
   and pulls Google Analytics / Search Console reports — all from a chat box, using a
   knowledge base of the clinic's brand docs.

The goal: **one dashboard** where a clinic runs its front desk AND its marketing.

---

## 2. How the AI actually works (the part that confuses everyone)

### 2.1 Do clinics use their own key, or your one key?
**You use ONE key (yours), and ALL clinics run through it.** This is what you asked for,
and it's how almost every AI SaaS works. The clinic **never** sees or enters an API key —
they just use the app. You (the owner) hold one key in the server settings (Netlify env),
and every clinic's chats/blogs/voice run through it.

> The "each clinic brings their own key" idea (BYOK) is the *opposite* model — good for
> developer tools, bad for selling to non-technical clinics. We are **not** doing that.

### 2.2 How do they always use the latest models (Claude, GPT, Gemini)?
Use **OpenRouter** as the single gateway. One OpenRouter key gives you **every** model
(Claude, GPT-4o/5, Gemini, Llama…) by just naming it. When a newer model ships, you
change one line — no new account. (You *can* also use OpenAI or Anthropic directly with
their own keys; OpenRouter just keeps it to one bill and the newest models.)

### 2.3 Who pays, and how "credits / top-ups" work
- **You pay the providers first.** Your card is on file at OpenRouter/ElevenLabs/Vapi.
  As clinics use the app, those providers charge **you** (per token, per minute, per
  character). This is normal — it's the cost of goods.
- **You charge the clinics through subscriptions (+ optional top-ups).** You sell a plan,
  e.g. "$X/month includes 5,000 AI messages, 200 call minutes, 20 blog posts." That
  allowance is the clinic's "credits." If they go over, they **top up** (buy more credits)
  or upgrade. You set those prices **above your cost**, so the difference is your profit.
- **So yes — you spend your own money on the APIs, and recover it (plus margin) in the
  subscription.** That is exactly how enrichlabs and everyone else does it. The customer
  pays you; you pay the AI providers.

### 2.4 How do platforms like enrichlabs do it (and charge credits)?
Identical model: one set of provider keys on their side, a **credits/usage meter** per
customer, monthly plans with an included allowance, and **top-ups** when exceeded. The
"credit" is just a friendly unit hiding the real token/minute cost. Example: 1 credit =
1 AI message, or 1 blog = 50 credits, 1 minute of call = 10 credits — you decide the map
so that the credit price comfortably covers the underlying API cost + margin.

### 2.5 Protecting yourself from runaway cost
Three guardrails (we should build these):
1. **Usage meter per clinic** (count messages/minutes/blogs/images in the DB).
2. **Monthly caps** per plan — when a clinic hits the cap, they must upgrade or top up.
3. **Cheap-by-default models** for routine chat (e.g. GPT-4o-mini / Claude Haiku) and the
   expensive ones only when needed. This keeps your cost per action tiny.

**Bottom line:** one key (yours), bill via subscription + credits, always price the
credit above the raw API cost. You are never out of pocket if the caps are set right.

---

## 3. The "sell different agent types" feature (what you described)

Like enrichlabs selling a Digital-Marketing agent, an SEO agent, a Website agent — we
give each clinic the agent type(s) they bought. Mechanically this is small for us because
we already have agents with a knowledge base; we add:
- **Agent templates** (Digital Marketing, SEO, Receptionist, etc.) — preset
  instructions/behavior/tools per type.
- **Per-clinic entitlement** — which agent types a workspace is allowed (tied to their
  plan). Owner can grant/revoke.
- **Tools the marketing agent can run**: write-to-WordPress, generate-image, pull-Google-
  report. Each is a small server action the agent calls.

This is a real build (a few features) — flagged in the roadmap at the end.

---

## 4. Tools we run LOCALLY (at the clinic)

| Tool | What it's for | Cost |
|---|---|---|
| **Open Dental** (their PMS) | Patients, schedule, clinical records — stays on-site. | US **$199/mo per location** first year → **$149/mo**; **+$20/mo per provider** beyond 3. |
| **Open Dental API** | Lets our connector read slots & book. | **$30/mo per location** (only when the key is enabled). |
| **Pydent Connector** (our Node app) | Runs beside Open Dental; exposes only booking. | **Free** (our software). |
| **Host machine** | A PC/server already at the clinic running the connector. | Usually **$0** (existing); optional mini-PC ~$150–400 one-time. **No GPU.** |
| **Node.js + Cloudflare Tunnel** | Runs the connector + secure outbound link. | **Free**. |

**Plain version:** the only *new* recurring local cost is the **$30/mo Open Dental API**.
No GPU, no new server.

---

## 5. Tools we run in the CLOUD (with per-unit costs)

These are the ones **you** pay for and recover through subscriptions.

| Tool | What it's for | How it's priced | Rough cost |
|---|---|---|---|
| **Netlify** | Hosts the app + serverless API. | Per member + bandwidth/build minutes | Free to start; **Pro ~$19/mo per member** |
| **Supabase** | Database + login + file storage. | Per project + usage | Free to start; **Pro $25/mo per project** |
| **OpenRouter** (LLM gateway) | All chat/blog/agent text (Claude/GPT/Gemini). | **Per token** (pass-through) | GPT-4o-mini ≈ **$0.15 / $0.60 per 1M** in/out → a chat reply is a fraction of a cent; a 1,500-word blog ≈ **$0.02–0.20** depending on model |
| **OpenAI Images / Flux** | The marketing agent's images. | **Per image** | DALL·E-3 / gpt-image ≈ **$0.04–0.12 per image**; Flux via Replicate ≈ **$0.003–0.04** |
| **ElevenLabs** | Voices, previews, cloning (and optionally calls). | **Per character** (+ per-minute for Agents) | **Creator $22/mo** (100k chars) → Pro $99 → Scale $330 → Business $1,320; Agents calling ≈ **$0.08–0.10/min** |
| **Vapi** | Phone calls (telephony + STT/LLM/TTS glue). | **Per minute** + numbers | ≈ **$0.07–0.15/min**; numbers ≈ **$2/mo** each |
| **Deepgram** | Call transcription. | Per minute (usually via Vapi) | ≈ **$0.0043/min** |
| **Meta WhatsApp Cloud API** | WhatsApp / IG / Messenger inbox. | **Per conversation** (region) | Free API; Meta charges ≈ **$0.005–0.08+/conversation** |
| **Google APIs** (Analytics, Search Console, Business, Ads, Drive, Calendar) | Reports & connections. | **Free** within quotas | **$0** (Google Ads needs a free developer token) |
| **WordPress REST API** | Draft blogs, upload images, set featured image. | Free (uses the clinic's WP login) | **$0** |
| **Domain name** | Your app's web address. | Per year | ≈ **$12/yr** |
| **Stripe** | To bill the clinics (subscriptions/top-ups). | Per charge | **2.9% + $0.30** per payment |

**Plain version:** your fixed cloud cost to *run* the platform is small (~**$44/mo**:
Netlify + Supabase). Everything else is **pay-as-used** and scales with how much clinics
use — which you cover with their subscription.

---

## 6. New tools just for the marketing-agent features

| Capability | Tool | Cost |
|---|---|---|
| Write blogs / chat / reports | OpenRouter (LLM) | per token (see above) |
| Generate images / featured images | OpenAI Images **or** Flux (Replicate) | ≈ $0.003–0.12 per image |
| Draft into WordPress | WordPress REST API + an "application password" the clinic pastes once | Free |
| Google Analytics / Search Console reports | Google APIs (already in our Connections) | Free |
| Store brand docs / assets (knowledge base) | Supabase storage | included in Supabase (storage overage ~$0.021/GB) |

No GPU is ever required — image and text generation are all **API calls** to providers.

---

## 7. ElevenLabs — which plan to buy

"11 Creative / 11 Agents / 11 API" are **three faces of ONE account**, not three
purchases. One paid subscription unlocks all of them:
- **Creative** = voices / cloning (our preview, voice notes, custom voice).
- **Agents** = full voice agents that can even take **phone calls**.
- **API** = the developer access our backend uses.

**Buy:** **Creator (~$22/mo)** to start (includes API + cloning, ~100k characters ≈ ~2 hrs
speech). Upgrade to **Pro (~$99/mo)** as volume grows. There's **no separate "11 API"
purchase** — the API comes with any paid plan, and it **tops up automatically** if you
enable overage billing, so you don't run dry mid-month.
- For **calling**, you can keep **Vapi** (built, working) **or** later move to **ElevenLabs
  Agents** (one vendor, ~$0.08–0.10/min, but it's a rebuild). Recommendation: keep Vapi
  now, use ElevenLabs API for voices, revisit Agents later.

---

## 8. Supabase — what it is and what it costs

**What it is:** our cloud **database + login system + file storage**, all in one. It holds
every clinic's leads, bookings, agents, connections and brand documents — each separated
by `workspace_id` so clinics never see each other's data. (Clinical records stay in Open
Dental; Supabase only holds scheduling + marketing data.)

**Cost:**
- **Free tier** — fine for building/testing (small DB, limited users).
- **Pro — $25/mo per project** — what you go live on: 8 GB database, 100k monthly active
  users, daily backups, more storage.
- **Usage overages** if you exceed: database size, file storage (~$0.021/GB), and data
  transfer. For dozens of clinics, expect **$25–75/mo** total at first.
- One Supabase project can serve **all** clinics (multi-tenant) — you don't pay per clinic.

---

## 9. Netlify — is it good? Will it "run out of credits"?

**Short answer: it's good, and it does NOT charge "credits per redeploy."** Netlify bills
on two things: **bandwidth** (how much the app is loaded) and **build minutes** (time
spent deploying). Redeploys use **build minutes**, and the **Pro plan (~$19/mo/member)**
includes **25,000 build minutes** + **1 TB bandwidth** — far more than you'll use, so
normal redeploys won't run you dry. You only pay more if you blow past those (overage), or
add team members.

- **Free tier**: 300 build min + 100 GB bandwidth/month — enough to build and demo.
- **Pro ~$19/mo/member**: go-live tier.
- If you ever outgrow it or want it cheaper at scale, **Vercel** (made by Next.js's team)
  is the main alternative; **Hostinger shared hosting won't run this app** (only their VPS
  can, with manual setup — more work). Recommendation: **stay on Netlify (or Vercel).**

**How many "credits" to buy:** none — it's a **monthly plan**, not prepaid credits. Start
on **Pro (~$19/mo)**; that's it until you have lots of traffic.

---

## 10. Worked example — what one active clinic costs YOU per month

Assume a busy clinic: 4,000 AI chat messages, 300 call minutes, 30 blogs, 60 images,
2,000 WhatsApp conversations.

| Item | Math | ~Cost to you |
|---|---|---|
| AI chat (mini model) | 4,000 × ~$0.002 | **$8** |
| Blogs (better model) | 30 × ~$0.15 | **$4.50** |
| Images | 60 × ~$0.06 | **$3.60** |
| Voice calls (Vapi) | 300 × ~$0.10 | **$30** |
| ElevenLabs voices | within Creator/Pro plan | **$22–99 shared** |
| WhatsApp | 2,000 × ~$0.02 (varies a lot) | **~$40** |
| Phone number | 1 × $2 | **$2** |
| **Per-clinic variable** | | **≈ $90–130** |
| Shared platform (Netlify+Supabase) | spread across all clinics | **~$50/mo total** |

So if you **sell that clinic a plan at, say, $299–499/mo**, your gross margin is healthy
even before you add top-ups for heavy users. (Light clinics cost you far less.) **Always
set the plan price so the heaviest expected usage still leaves margin**, and add **top-ups
+ caps** for outliers.

---

## 11. Quick answers to your exact questions

- **"I want my one key everyone uses, not each clinic's key."** ✅ That's the plan — one
  key (yours) in the server; clinics never enter a key.
- **"Do we get charged / use our own money for API?"** Yes — you pay the providers as
  usage happens, and recover it (plus profit) through the clinic's subscription + top-ups.
- **"Do we charge them beforehand?"** Yes — monthly subscription (prepaid allowance), and
  top-ups when they exceed it. Use caps so you're never underwater.
- **"How do others (enrichlabs) do it?"** Exactly this: one provider key, a credits meter,
  plans with allowances, top-ups, cheap models for routine work.
- **"Which ElevenLabs?"** One account; buy **Creator → Pro**; the **API tops up
  automatically**; no separate "11 API" purchase.
- **"Netlify credits / redeploys?"** No prepaid credits; Pro plan's build minutes cover
  redeploys easily.

---

## 12. What's built vs. what to build next

**Built:** inbox, chat + voice agents, voice library/cloning/notes, calendar + views,
booking (+Open Dental forward), website knowledge import, Google connections (per clinic),
sample-data toggle.

**To build for the enrichlabs-style marketing agent:**
1. **Usage metering + credits + plan caps** (so one shared key is safe and billable).
2. **Agent templates + per-clinic entitlements** (sell "Digital Marketing", "SEO", etc.).
3. **Agent tools:** write-to-WordPress (draft + featured image), generate-image,
   pull-Google-Analytics/Search-Console report.
4. **Stripe billing** (subscriptions + top-ups).

> None of these need a GPU or local hardware — they're all API calls plus our own code.
