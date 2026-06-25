# AI Team — how it works, images, ads, scheduling & billing

Plain-language answers to the questions about the four agents (Helena, Sam, Kai,
Angela), plus what's built and what's next.

## What's built now
- **4 agents with real tools** (publish to WordPress, generate images, pull Google
  Analytics/Search Console, post to Facebook/Instagram, read reviews, schedule WhatsApp
  broadcasts, find recall patients).
- **Brand knowledge** — each agent reads a per-clinic brand profile (clinic name,
  services, tone, key facts, colours). Edit it from any agent's left rail ("Brand
  knowledge → Edit"). This is how the agent **knows your clinic** instead of being generic.
- **Chat history / sessions** — every conversation is saved. "New chat" starts a fresh
  session; "History" lists past chats (with a count) to reopen and continue. (migration
  0030)

---

## 1. How does image generation work? (the backend, the API, the cost)

When you say "make an image for this", here's the actual flow:
1. The agent calls our `generate_featured_image` / `post_to_instagram` tool.
2. That calls an **image API** with a text prompt → gets back an image (PNG).
3. We upload it to your **WordPress media** (so it has a public URL) and use it as the
   blog's featured image or the Instagram photo.

**Which API today:** **OpenAI Images (DALL·E 3)** — needs `OPENAI_API_KEY` in Netlify.
Cost ≈ **$0.04 (standard) to $0.08–0.12 (HD) per image**.

**How enrichlabs (and others) do it:** exactly the same pattern — they call an image API
(OpenAI `gpt-image-1`/DALL·E, or Stability/Flux, or a video model) and pay **per image**.
They then **charge the customer** via the plan/credits (e.g. "1 image = 5 credits"), priced
**above** the API cost. So **you pay the provider; you recover it (plus margin) in the
subscription/top-ups** — same model as the chat tokens (see SOFTWARE_STACK_AND_COSTS.md).

**We can swap the image provider easily** — it's one file (`src/lib/image-gen.ts`).
Options and rough costs (verify current pricing):
- **OpenAI DALL·E 3 / gpt-image-1** — ~$0.04–0.12/image. (current)
- **Flux (via Replicate or fal.ai)** — ~$0.003–0.05/image, very high quality, cheapest.
- **Stability (SD3)** — ~$0.01–0.06/image.
- **Higgsfield** — see below.

### Higgsfield — can we use it?
Yes, in principle. **Higgsfield** is an AI **image + video** generation platform (great for
cinematic visuals, motion/Reels). They offer an **API** (and credit packs). To use it we'd
swap `image-gen.ts` to call the Higgsfield API with your key.
- **Cost:** Higgsfield is **credit-based** (you buy credits / a subscription, and each
  generation spends credits). It's generally **pricier per asset than DALL·E/Flux**,
  especially for video — but the quality/motion is higher. **Verify their current API
  pricing** on higgsfield's site before committing; treat it as a premium option.
- **Billing impact:** same as any provider — you'd pay Higgsfield, and price your image
  credits above that cost. For routine post images, Flux/DALL·E is cheaper; reserve
  Higgsfield for premium/video content. **Recommendation:** start on DALL·E/Flux (cheap,
  reliable); add Higgsfield later as a "premium image/video" option if clients want it.

---

## 2. Can Helena run Google Ads / Meta Ads?

**Today:** Helena can **review/analyse** ad performance (once Meta Ads / Google Ads are
connected and return data) and **draft ad copy + budget/targeting recommendations**. That
part is safe and useful.

**Actually launching/changing live ads** (spending real money) is a bigger, riskier step:
- **Meta Ads** → needs the **Marketing API** with `ads_management` (App Review) + an ad
  account id; creating campaigns/ad sets/ads is multi-step.
- **Google Ads** → needs the **Google Ads API** with a **developer token** (Google must
  approve it) + a customer id.
- Because these **spend money**, the right design is **draft → you approve → then publish**
  (never auto-spend). 

**Recommendation:** keep Helena at "read performance + draft campaigns you approve" first;
wire true campaign creation later, behind an explicit confirmation, once those API
approvals are in place. The plumbing pattern is the same as our other tools.

---

## 3. Scheduling & autopilot (e.g. "post a blog every Monday")

Not built yet — here's the plan. We add a **scheduled tasks** table (what, which agent,
which action, cadence) and a **cron** (Netlify Scheduled Functions or Supabase cron) that
wakes up and runs them — e.g. "every Monday: generate + draft a blog", "daily: draft a
social post", "weekly: email me a performance report". You'd set these in the agent's UI
and pause/resume any time. This is a clean next feature once you want autopilot.

---

## 4. Right-rail metrics & activity (blogs posted, captions, files)

Also a next step: we log every agent action (blog drafted → WordPress link, image made,
caption written, report pulled) into an **activity feed** and show it in the agent's
workspace — "what Helena did", how many posts, which blogs, with links. Pairs naturally
with the GA4/Search Console metrics Helena already pulls.

---

## Roadmap recap (in suggested order)
1. ✅ Brand knowledge + chat history (done).
2. **Activity feed** (what each agent did: blogs, posts, images, reports).
3. **Scheduling / autopilot** (recurring tasks; weekly report emails).
4. **Ad campaign creation** (Meta/Google) behind approval.
5. **Premium images/video** (Flux / Higgsfield option).
6. **Packages & entitlements** (lock/unlock agents per plan) + admin panel.
7. **Team assignment in chat** (@mention a teammate to review/forward a draft).

> Billing rule for all of it: you pay the providers (LLM tokens, images, etc.) and recover
> it via the clinic's subscription + credit top-ups, always priced above cost. Details in
> SOFTWARE_STACK_AND_COSTS.md.

---

## 5. MuAPI (images + video) — will your key work, and what it costs

**Yes — a MuAPI key works.** MuAPI is "one API for all models" (Flux, Midjourney, Veo 3,
Kling, Runway, Suno + tools like upscale/bg-removal/lip-sync). It's a **credit-based REST
API**: you top up credits, each generation spends credits. We integrate it exactly like we
did OpenAI — put `MUAPI_KEY` in Netlify, and our `generate_image` / new `generate_video`
tools call MuAPI, pick a model, and use the result. **One key → images AND video for every
agent.** (When you send the key I'll confirm the exact endpoint from their docs and finish
the wiring.)

### What each thing costs (per generation — approx; MuAPI bills credits, verify live rates)
These are driven by the underlying model. MuAPI is competitive but adds a small margin.

| Type | Model (quality) | ~Cost each |
|---|---|---|
| **Image — cheap/fast** | Flux Schnell | ~$0.003 |
| **Image — standard** | Flux Dev | ~$0.02–0.03 |
| **Image — professional** | Flux Pro / Kontext, Ideogram, Midjourney V7 | ~$0.04–0.08 |
| **Image — DALL·E 3** | OpenAI | ~$0.04–0.12 |
| **Video — budget** | Runway / Luma | ~$0.05–0.15 / second |
| **Video — great** | Kling | ~$0.10–0.35 / second (5s ≈ $0.5–1.75) |
| **Video — premium** | Veo 3 / Sora | ~$0.30–0.75 / second (5s ≈ $1.5–4+) |
| **Music** | Suno | ~$0.05–0.10 / track |
| **Tools** | upscale / bg-remove / lip-sync | ~$0.01–0.10 |
| **Agent brain (text/reports)** | gpt-4o-mini (cheap) → Claude Sonnet / GPT-4o (pro) | fraction of a ¢ → a few ¢ per report |

**Reading it:** images are pennies; **video is the expensive line** (a 5-second Reel is
~$0.50–$4 depending on the model). So price video as a premium credit.

## 6. "Professional results, not cheap" — how to match Helena/enrichlabs

Same architecture, three quality levers (all one-line swaps):
1. **Better media models** — use **Flux Pro / Ideogram** for images and **Kling / Veo** for
   video instead of the cheapest. That's the difference between "AI-looking" and pro.
2. **Better brain for writing & reports** — switch the agents from `gpt-4o-mini` to
   **Claude Sonnet** (or GPT-4o) for blogs and reports. Claude writes excellent, on-brand
   long-form — this is the single biggest quality jump, and it's just the model id.
3. **Better inputs** — brand knowledge + real data (GA4, Search Console, ads) + strong
   prompts → reports with substance, not filler.

We'll add a **quality tier**: routine work uses cheap models (cents), "hero" work (a flagship
blog, a campaign video, a client report) uses premium models. enrichlabs does exactly this.

## 7. Can Claude do the reports? Should we charge?

- **Yes — Claude can power the agents.** Via OpenRouter we can route any agent to **Claude
  Sonnet/Opus** by changing one model string, so Helena/Sam produce **professional reports**
  (e.g. a monthly SEO/traffic report from real GA4 + Search Console data, written by Claude,
  exportable to PDF/email). That's a concrete feature we can build.
- **Yes — charge for it.** Premium models cost more per use, so put pro images, video, and
  Claude-written reports in **higher-tier packages** or have them **consume more credits**.
  You pay the provider; the client pays you above cost. Cheap routine work stays in the base
  plan; premium output is the upsell.

**Bottom line:** matching enrichlabs' quality is a *model + prompt* choice, not a different
build. Same pipes, premium models where it counts, billed as premium.

---

## 8. Using Claude for the AI Team (keys, free options, switching)

### You do NOT need a separate Claude key — use OpenRouter
Your existing **OpenRouter key already gives you Claude.** OpenRouter routes to the *real*
Anthropic models, so Claude via OpenRouter behaves **exactly like native Claude** (same
model, same quality) — you just name it. To switch all four agents to Claude, set ONE env
var in Netlify and redeploy:
```
TEAM_AI_MODEL = anthropic/claude-sonnet-4
```
(Leave it unset to keep the cheap default `openai/gpt-4o-mini`.) That's the whole switch —
the code reads `TEAM_AI_MODEL`.

### Is Claude free? / Pro / Max?
- **No free Claude API.** Claude Sonnet isn't free for API use — it's pennies per request
  (paid). OpenRouter's *free* models are open-source ones (Llama, etc.), **not** Claude.
- **Claude Pro / Max ($20 / $200) is NOT an API key.** Those are for the claude.ai chat app
  only. They do **not** give API access. So a Pro/Max plan can't power Pydent.
- **A real Anthropic API key** (if you ever want it directly) comes from
  **console.anthropic.com → API Keys → Create** (billed per token, separate from Pro/Max).
  But you don't need it — OpenRouter is simpler and already set up.

### Where to get the keys
- **OpenRouter key:** openrouter.ai → sign in → **Keys → Create Key** → add credit. (You
  have this.) Put it in Netlify as `OPENROUTER_API_KEY`.
- **Anthropic key (optional):** console.anthropic.com → **API Keys → Create**.

## 9. "Create a document I can download" — how that works

When you tell an agent "make a document/report", the model produces the **text**; an AI
can't hand you a file by itself. To give a **downloadable file**, *we* convert that text
into a document and provide a link. That's a small feature we can add:
- Agent writes the report (Markdown/HTML).
- We render it to a file — **PDF** (printable, branded) or **.docx** — store it, and return
  a **download link** in the chat.
- Best paired with Claude for the writing + the real data (GA4/Search Console) so the report
  has substance.

So yes — a downloadable report/document is buildable; it's a "render + link" step on top of
what the agents already write. (Not built yet — it's on the list.)

## What's already built on the agents (your question)
- ✅ **Brand knowledge box** in each agent's left rail (editable) — and it's now actually
  injected into all four agents (a bug where the text was dropped is fixed).
- ✅ **Chat history / sessions** — New chat + History dropdown to reopen past chats.
- ✅ **Channels** panel (live connected/not) + **website/brand** on the left rail.
- ⏳ Still to do (the rest of the enrichlabs right rail): **activity feed** (blogs/posts/
  images the agent made, with links), **metrics tiles**, **brand assets** (logo/colours
  gallery), **weekly tasks / scheduling**, **document/report download**.
