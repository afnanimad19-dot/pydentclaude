// Ready-made templates for the AI Marketing specialists — Hyperfx-style: each is
// a box the user previews, then "Use this template" drops the full prompt into
// the chat input (NOT auto-sent; the user reviews and hits send). The prompts are
// written to exercise the agents' real tools (ads data, SEO research, scraping,
// campaigns) so the work runs through the marketing engine at the backend.

export interface AgentTemplate {
  id: string;
  agent: "helena" | "sam" | "kai" | "angela";
  title: string;
  description: string;
  apps: string[]; // chips shown on the box
  prompt: string;
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  // ─────────────────────────────── Helena — marketing / ads / creative
  {
    id: "helena-ads-audit",
    agent: "helena",
    title: "Meta Ads performance audit",
    description: "Pull the last 30 days of Meta ads and get a what-to-fix plan.",
    apps: ["Meta Ads"],
    prompt:
      "Pull my Meta ads performance for the last 30 days. Break it down by campaign: spend, impressions, clicks, CTR and CPC. Then tell me:\n1. Which campaigns are underperforming and why\n2. What I should pause, scale, or change\n3. Three new ad copy angles for a dental clinic based on what's working\nFinish with a prioritized action list for this week.",
  },
  {
    id: "helena-competitor-ads",
    agent: "helena",
    title: "Competitor ads research",
    description: "Scrape competitor dental clinics' live ads from the Meta Ads Library.",
    apps: ["Meta Ads Library"],
    prompt:
      "Search the Meta Ads Library for ads currently run by dental clinics in my city (use my brand knowledge for the location). For the 5 most interesting advertisers:\n1. What offers and hooks are they running?\n2. What creative styles do they use (video, before/after, testimonials)?\n3. What can we copy, and where can we differentiate?\nEnd with 3 ad concepts for our clinic inspired by the gaps you found.",
  },
  {
    id: "helena-content-calendar",
    agent: "helena",
    title: "Monthly content calendar",
    description: "A full month of posts across Instagram, Facebook and TikTok.",
    apps: ["Instagram", "Facebook", "TikTok"],
    prompt:
      "Plan next month's social content calendar for the clinic. I want:\n- 3 posts per week across Instagram, Facebook and TikTok\n- A mix of: treatment education, before/after concepts, team/behind-the-scenes, patient FAQs, and one promo per week\n- For each post: the day, platform, caption (with hashtags + CTA) and a visual idea\nLay it out week by week so I can review and approve.",
  },
  {
    id: "helena-blog",
    agent: "helena",
    title: "SEO blog post → WordPress draft",
    description: "Write a full SEO blog post and draft it to the website.",
    apps: ["WordPress"],
    prompt:
      "Write a 900–1200 word SEO blog post for our clinic on a high-interest dental topic (pick one we haven't covered — e.g. Invisalign vs braces, teeth whitening safety, implant aftercare). Include an H1, H2 sections, a patient FAQ section, and a call-to-action to book. Generate a featured image, then draft it to WordPress for my review — do NOT publish live.",
  },
  {
    id: "helena-brand-report",
    agent: "helena",
    title: "CMO brand report",
    description: "A cross-channel brand intelligence report on the clinic.",
    apps: ["CMO reports"],
    prompt:
      "Run a brand intelligence report on our clinic (use my brand knowledge + website). Cover: how our online presence looks across channels, how our ads compare to the market, and the 5 highest-impact marketing moves for the next 90 days. Save it as a report document I can download.",
  },
  {
    id: "helena-google-ads-review",
    agent: "helena",
    title: "Google Ads review + new copy",
    description: "Review Google Ads performance and draft refreshed ad copy.",
    apps: ["Google Ads"],
    prompt:
      "Review my Google Ads campaign performance for the last 30 days: impressions, clicks, CTR, average CPC and conversions per campaign. Identify wasted spend and the strongest keywords. Then write 3 new responsive search ad variants (15 headlines + 4 descriptions each) tailored to a dental clinic, ready for me to approve.",
  },

  // ─────────────────────────────── Sam — SEO / local search / AI search
  {
    id: "sam-keyword-research",
    agent: "sam",
    title: "Dental keyword research",
    description: "Real volumes + competition for your city's dental searches.",
    apps: ["HyperSEO"],
    prompt:
      "Do keyword research for our clinic's city (use my brand knowledge for location). I want:\n1. The top 20 dental keywords with search volume, competition and CPC\n2. Which we can realistically rank for in 3–6 months\n3. A content plan: which page or blog post to create for each priority keyword\nGroup them by treatment (implants, Invisalign, whitening, general).",
  },
  {
    id: "sam-ai-visibility",
    agent: "sam",
    title: "AI search visibility check",
    description: "How visible is the clinic in AI answers (ChatGPT-style search)?",
    apps: ["HyperSEO"],
    prompt:
      "Check our AI search visibility: when people ask AI assistants things like 'best dentist in [our city]' or '[treatment] near me', do we appear? Analyze:\n1. Our current visibility vs the top 3 competitor clinics\n2. What's keeping us out of AI answers (content, schema, citations, reviews)\n3. A concrete fix-list, ordered by impact, to get the clinic cited by AI search",
  },
  {
    id: "sam-competitor-gap",
    agent: "sam",
    title: "Competitor SEO gap analysis",
    description: "Keywords competitors rank for that you don't.",
    apps: ["HyperSEO"],
    prompt:
      "Find our top 3 local dental competitors and run a keyword gap analysis:\n1. Which valuable keywords do they rank for that we don't?\n2. Where do we rank worse but could overtake them?\n3. What content or pages give the fastest wins?\nEnd with a 30-day plan: exactly which pages to create or rewrite, in order.",
  },
  {
    id: "sam-gbp",
    agent: "sam",
    title: "Google Business Profile optimisation",
    description: "Win the local map pack for 'dentist near me'.",
    apps: ["Business Profile"],
    prompt:
      "Audit and optimise our Google Business Profile for the local map pack:\n1. Review our current categories, services, photos, posts and Q&A\n2. Compare against the clinics currently winning 'dentist near me' in our area\n3. Give me the exact changes: category tweaks, services to add, post cadence, photo shot-list, and review strategy\nThen draft this week's GBP post for my approval.",
  },
  {
    id: "sam-page-audit",
    agent: "sam",
    title: "Website SEO audit",
    description: "Full on-page audit of the clinic website with fixes.",
    apps: ["Search Console", "Website"],
    prompt:
      "Audit our website's SEO (use the site from my brand knowledge). Check titles, meta descriptions, headings, page speed signals, internal linking and schema (especially FAQ and LocalBusiness). Cross-reference Search Console: which pages get impressions but poor clicks? Give me a fix-list ordered by impact, with rewritten titles/metas for the 5 most important pages.",
  },

  // ─────────────────────────────── Kai — reputation / listening
  {
    id: "kai-review-sweep",
    agent: "kai",
    title: "Review sweep + reply drafts",
    description: "Pull the latest reviews, flag problems, draft warm replies.",
    apps: ["Google Reviews", "Facebook"],
    prompt:
      "Pull our latest Google and Facebook reviews. Then:\n1. Summarize sentiment — what do patients love, what keeps coming up as a complaint?\n2. Flag anything urgent (unhappy patients, mentions of pain, billing disputes)\n3. Draft an on-brand reply for every review that doesn't have one — warm, professional, no medical detail\nShow me the replies for approval; do not post anything yourself.",
  },
  {
    id: "kai-competitor-watch",
    agent: "kai",
    title: "Competitor reputation watch",
    description: "Scrape competitor clinics' reviews — steal their wins, avoid their mistakes.",
    apps: ["Review scraping"],
    prompt:
      "Scrape the Google reviews of our top 3 competitor clinics (find them near our location). Tell me:\n1. What patients praise about them that we should adopt\n2. What patients complain about — our opportunity to win those patients\n3. How our rating and review volume compares, and a plan to close any gap in 60 days",
  },
  {
    id: "kai-reddit-listening",
    agent: "kai",
    title: "Social listening (Reddit + trends)",
    description: "What are people saying about dental care in your market?",
    apps: ["Reddit"],
    prompt:
      "Do a social listening sweep: search Reddit for recent conversations about dentists and dental treatments in our region (fears, price complaints, what people wish clinics did). Summarize:\n1. The 5 most common themes\n2. Trust objections we should answer in our content\n3. Three post ideas that speak directly to what people are worried about",
  },
  {
    id: "kai-monthly-report",
    agent: "kai",
    title: "Monthly reputation report",
    description: "One document: reviews, sentiment, competitors, actions.",
    apps: ["Google Reviews", "CMO reports"],
    prompt:
      "Build this month's reputation report: new reviews and our average rating trend, overall sentiment summary, anything we flagged and how it was handled, competitor rating comparison, and the top 3 reputation actions for next month. Save it as a report document I can download and share with the team.",
  },

  // ─────────────────────────────── Angela — campaigns / patient marketing
  {
    id: "angela-recall",
    agent: "angela",
    title: "Recall campaign (due patients)",
    description: "Find patients due for a visit and draft the recall campaign.",
    apps: ["WhatsApp", "Email"],
    prompt:
      "Find patients who are due for recall (not seen in 6+ months). Then draft a recall campaign:\n1. A friendly WhatsApp message (template-compliant)\n2. An email version (subject + body)\n3. A suggested send plan (day/time, and a reminder for non-responders after 5 days)\nShow me everything for approval before anything is scheduled.",
  },
  {
    id: "angela-winback",
    agent: "angela",
    title: "Win-back lapsed patients",
    description: "A 3-touch reactivation sequence for patients who stopped coming.",
    apps: ["Email", "WhatsApp"],
    prompt:
      "Draft a 3-touch win-back sequence for patients who haven't visited in over a year:\n- Touch 1: warm 'we miss you' email with an easy booking link\n- Touch 2 (a week later): WhatsApp message with a gentle nudge + offer idea\n- Touch 3 (two weeks later): final email with a time-limited incentive\nKeep it caring, not salesy, and compliant (easy opt-out). Show me the copy for approval.",
  },
  {
    id: "angela-newsletter",
    agent: "angela",
    title: "Monthly patient newsletter",
    description: "A ready-to-send newsletter: tips, news, one promo.",
    apps: ["Email"],
    prompt:
      "Write this month's patient newsletter: one seasonal oral-health tip section, one 'meet the team / clinic news' blurb (use my brand knowledge), one treatment spotlight with a soft CTA, and one promo block. Give me the subject line (plus 2 alternates) and the full email body. Then, if I approve, put it into a draft campaign targeting our main contact list.",
  },
  {
    id: "angela-leadgen",
    agent: "angela",
    title: "Local lead scrape + outreach",
    description: "Scrape local businesses for B2B partnerships (schools, gyms, offices).",
    apps: ["Maps scraping"],
    prompt:
      "Scrape Google Maps for local businesses near our clinic that could be partnership leads — gyms, schools, nurseries, corporate offices (find ~20 with phone numbers). Then draft:\n1. A short partnership pitch (corporate dental checkup days / staff discounts)\n2. A WhatsApp-length version and an email version\nPresent the list + copy for my approval; don't contact anyone yourself.",
  },
  {
    id: "angela-posttreatment",
    agent: "angela",
    title: "Post-treatment follow-up sequences",
    description: "Aftercare check-in flows per treatment type.",
    apps: ["WhatsApp", "Email"],
    prompt:
      "Create post-treatment follow-up sequences for our three most common treatments (e.g. extraction, implant, whitening):\n- Day 1: aftercare check-in (WhatsApp)\n- Day 7: healing check + care tips (WhatsApp)\n- Day 30: review request + next-visit nudge (email)\nWrite every message, keep it warm and compliant (no medical advice), and show me the full flows for approval.",
  },
];

export function templatesFor(agentKey: string): AgentTemplate[] {
  return AGENT_TEMPLATES.filter((t) => t.agent === agentKey);
}
