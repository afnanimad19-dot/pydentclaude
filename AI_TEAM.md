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
