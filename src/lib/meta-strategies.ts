// Meta campaign objectives + Pydent's SELLABLE strategy presets.
// The create-campaign wizard shows objectives as Google-Ads-style boxes (Meta's
// own objectives, not Google's), then 4–6 named strategies per objective — each
// a pre-made recipe (audience, age, interests, ad-set plan, budget guidance)
// that is applied to Meta automatically instead of manual setup.
// Shared by the wizard UI and the server route that executes the strategy.

export interface MetaObjective {
  key: string; // Meta ODAX objective
  label: string;
  icon: string; // lucide icon name resolved in the UI
  description: string; // shown in the box
  goodFor: string; // shown on hover / selected panel
  details: string; // longer hover explanation
  optimization: string; // default optimization_goal for ad sets
  billing: string; // billing_event
  fallbackOptimization: string; // used when the primary needs a pixel/page we may not have
}

export const META_OBJECTIVES: MetaObjective[] = [
  {
    key: "OUTCOME_LEADS",
    label: "Leads",
    icon: "Users",
    description: "Collect leads for your clinic — instant forms, messages or calls.",
    goodFor: "Instant forms · Messenger/WhatsApp conversations · Calls",
    details: "Meta optimises delivery towards people likely to share their contact details or start a conversation. The standard choice for new-patient acquisition.",
    optimization: "LEAD_GENERATION",
    billing: "IMPRESSIONS",
    fallbackOptimization: "LINK_CLICKS",
  },
  {
    key: "OUTCOME_SALES",
    label: "Sales / Conversions",
    icon: "ShoppingBag",
    description: "Drive bookings and purchases tracked by your pixel.",
    goodFor: "Website bookings · Treatment purchases · Retargeting",
    details: "Optimises for conversion events (e.g. a completed booking form). Needs the Meta pixel on your site for full power; otherwise optimises for high-intent clicks.",
    optimization: "OFFSITE_CONVERSIONS",
    billing: "IMPRESSIONS",
    fallbackOptimization: "LINK_CLICKS",
  },
  {
    key: "OUTCOME_TRAFFIC",
    label: "Website traffic",
    icon: "MousePointerClick",
    description: "Send the right people to your website or booking page.",
    goodFor: "Landing pages · Blog content · Special-offer pages",
    details: "Optimises for link clicks or landing-page views. Good when the website does the convincing and you want volume at low cost.",
    optimization: "LINK_CLICKS",
    billing: "IMPRESSIONS",
    fallbackOptimization: "LINK_CLICKS",
  },
  {
    key: "OUTCOME_ENGAGEMENT",
    label: "Engagement",
    icon: "MessageCircle",
    description: "Get more messages, post engagement and page followers.",
    goodFor: "WhatsApp/Messenger chats · Post likes & shares · Video views",
    details: "Optimises towards people who interact — great for warming up an audience before running lead campaigns, and for message-based booking.",
    optimization: "POST_ENGAGEMENT",
    billing: "IMPRESSIONS",
    fallbackOptimization: "POST_ENGAGEMENT",
  },
  {
    key: "OUTCOME_AWARENESS",
    label: "Awareness",
    icon: "Megaphone",
    description: "Reach the maximum number of people near your clinic.",
    goodFor: "New clinic launch · Brand recall · Local presence",
    details: "Optimises for reach and ad recall, not clicks. The cheapest way to make the neighbourhood know your clinic exists.",
    optimization: "REACH",
    billing: "IMPRESSIONS",
    fallbackOptimization: "REACH",
  },
  {
    key: "OUTCOME_APP_PROMOTION",
    label: "App promotion",
    icon: "Smartphone",
    description: "Get installs and engagement for your clinic's app.",
    goodFor: "Patient app installs · App re-engagement",
    details: "Only relevant if the clinic has its own mobile app registered with Meta.",
    optimization: "APP_INSTALLS",
    billing: "IMPRESSIONS",
    fallbackOptimization: "LINK_CLICKS",
  },
];

export interface StrategyAdSet {
  name: string;
  angle: string; // what this ad set targets / says
  interests: string[]; // resolved to Meta interest ids at execution time
  ageMin: number;
  ageMax: number;
}

export interface MetaStrategy {
  key: string;
  objective: string; // META_OBJECTIVES key
  name: string;
  tagline: string;
  projection: string; // the sales line, e.g. expected outcome
  bestFor: string;
  suggestedDailyBudget: number; // USD per ad set
  adSets: StrategyAdSet[];
}

const A = (name: string, angle: string, interests: string[], ageMin = 22, ageMax = 55): StrategyAdSet => ({ name, angle, interests, ageMin, ageMax });

export const META_STRATEGIES: MetaStrategy[] = [
  // ───────────────────────────── LEADS (6)
  {
    key: "leads-new-patient",
    objective: "OUTCOME_LEADS",
    name: "New Patient Acquisition",
    tagline: "The core machine: fill the chair with first-time patients around the clinic.",
    projection: "Typically 30–60 leads/month at moderate local budgets.",
    bestFor: "Clinics that want steady general-dentistry bookings.",
    suggestedDailyBudget: 15,
    adSets: [
      A("General checkup seekers", "Everyone nearby due for a dentist", ["Dentistry", "Oral hygiene", "Health & wellness"], 22, 60),
      A("Families with kids", "Parents booking for the family", ["Parenting", "Family", "Dentistry"], 27, 50),
      A("Young professionals", "Convenience + easy booking angle", ["Health & wellness", "Fitness and wellness"], 22, 38),
    ],
  },
  {
    key: "leads-invisalign",
    objective: "OUTCOME_LEADS",
    name: "Invisalign / Aligner Funnel",
    tagline: "High-ticket aligner leads with a free-consultation hook.",
    projection: "Fewer, higher-value leads — one case can pay the month's budget.",
    bestFor: "Clinics selling Invisalign or clear aligners.",
    suggestedDailyBudget: 20,
    adSets: [
      A("Aligner intenders", "People researching straightening", ["Invisalign", "Orthodontics", "Cosmetic dentistry"], 20, 45),
      A("Image-conscious", "Confidence/smile angle", ["Beauty", "Cosmetics", "Selfie"], 20, 40),
      A("Wedding & events", "Big-day smile angle", ["Wedding", "Engagement", "Beauty"], 22, 40),
    ],
  },
  {
    key: "leads-implants",
    objective: "OUTCOME_LEADS",
    name: "Implant High-Value Leads",
    tagline: "Target the 40+ audience for implant consultations.",
    projection: "Low volume, very high value — optimise for quality over quantity.",
    bestFor: "Clinics with implantology capacity.",
    suggestedDailyBudget: 25,
    adSets: [
      A("Missing-teeth solutions", "Implant education + consult", ["Dental implant", "Dentistry"], 40, 65),
      A("Denture upgraders", "From dentures to fixed teeth", ["Dentures", "Health care"], 50, 65),
    ],
  },
  {
    key: "leads-whitening",
    objective: "OUTCOME_LEADS",
    name: "Whitening Offer Blast",
    tagline: "A price-led whitening offer to get new faces in the door fast.",
    projection: "High lead volume; convert them to full patients in the chair.",
    bestFor: "Filling gaps in the schedule quickly.",
    suggestedDailyBudget: 12,
    adSets: [
      A("Whitening seekers", "Direct offer + price anchor", ["Teeth whitening", "Cosmetic dentistry"], 20, 45),
      A("Beauty & selfcare", "Glow-up angle", ["Beauty", "Skin care", "Cosmetics"], 20, 40),
    ],
  },
  {
    key: "leads-emergency",
    objective: "OUTCOME_LEADS",
    name: "Emergency & Same-Day",
    tagline: "Catch people in pain looking for a dentist NOW.",
    projection: "Immediate bookings; keep response time under 5 minutes.",
    bestFor: "Clinics with same-day slots and fast phone response.",
    suggestedDailyBudget: 15,
    adSets: [
      A("Urgent care", "Same-day appointment promise", ["Dentistry", "Health care"], 20, 60),
      A("Night & weekend", "Out-of-hours availability", ["Dentistry", "Urgent care"], 20, 60),
    ],
  },
  {
    key: "leads-insurance",
    objective: "OUTCOME_LEADS",
    name: "Insurance-Covered Checkups",
    tagline: "\"Your insurance covers it\" — remove the price objection entirely.",
    projection: "Strong lead quality from insured professionals.",
    bestFor: "Clinics with major insurance network partnerships.",
    suggestedDailyBudget: 15,
    adSets: [
      A("Insured employees", "Use-your-benefits angle", ["Health insurance", "Employee benefits"], 25, 55),
      A("Year-end benefits", "Don't waste your coverage", ["Health insurance", "Personal finance"], 25, 55),
    ],
  },

  // ───────────────────────────── SALES / CONVERSIONS (5)
  {
    key: "sales-booking-conversions",
    objective: "OUTCOME_SALES",
    name: "Website Booking Conversions",
    tagline: "Optimise straight for completed bookings on your site (pixel).",
    projection: "Best cost-per-booking once the pixel has ~50 conversions.",
    bestFor: "Clinics with online booking + Meta pixel installed.",
    suggestedDailyBudget: 20,
    adSets: [
      A("High-intent local", "Book-now creative", ["Dentistry", "Health & wellness"], 22, 55),
      A("Service pages retarget", "Visited but didn't book", ["Dentistry"], 20, 60),
    ],
  },
  {
    key: "sales-retargeting",
    objective: "OUTCOME_SALES",
    name: "Warm Retargeting Engine",
    tagline: "Re-capture site visitors and engagers who didn't book.",
    projection: "Usually the cheapest conversions in the whole account.",
    bestFor: "Any clinic already running traffic/lead campaigns.",
    suggestedDailyBudget: 10,
    adSets: [
      A("Site visitors 30d", "Reminder + testimonial creative", ["Dentistry"], 20, 60),
      A("Engagers 90d", "Offer for people who engaged", ["Dentistry"], 20, 60),
    ],
  },
  {
    key: "sales-highticket",
    objective: "OUTCOME_SALES",
    name: "High-Ticket Treatment Push",
    tagline: "Veneers / smile-makeover conversions for premium audiences.",
    projection: "Low volume; one closed case covers months of spend.",
    bestFor: "Cosmetic-focused clinics with premium pricing.",
    suggestedDailyBudget: 25,
    adSets: [
      A("Premium cosmetic", "Smile-makeover transformations", ["Cosmetic dentistry", "Luxury goods", "Beauty"], 28, 55),
      A("Affluent professionals", "Discretion + quality angle", ["Business", "Luxury goods"], 30, 55),
    ],
  },
  {
    key: "sales-offer-season",
    objective: "OUTCOME_SALES",
    name: "Seasonal Offer Converter",
    tagline: "Time-limited seasonal promos optimised to purchase/booking.",
    projection: "Spikes of bookings around the offer window.",
    bestFor: "Ramadan/summer/new-year style campaigns.",
    suggestedDailyBudget: 15,
    adSets: [
      A("Offer cold", "The offer to fresh audiences", ["Dentistry", "Discounts and allowances"], 22, 55),
      A("Offer warm", "The offer to engagers/visitors", ["Dentistry"], 20, 60),
    ],
  },
  {
    key: "sales-family-plan",
    objective: "OUTCOME_SALES",
    name: "Family Plan Bundles",
    tagline: "Sell family checkup bundles — one conversion, four patients.",
    projection: "Higher value per conversion via bundling.",
    bestFor: "Family-oriented neighbourhoods.",
    suggestedDailyBudget: 15,
    adSets: [
      A("Parents", "Whole-family bundle", ["Parenting", "Family", "Dentistry"], 27, 50),
      A("School season", "Back-to-school checkups", ["Parenting", "Education"], 27, 48),
    ],
  },

  // ───────────────────────────── TRAFFIC (5)
  {
    key: "traffic-landing",
    objective: "OUTCOME_TRAFFIC",
    name: "Offer Landing-Page Traffic",
    tagline: "Cheap, high-quality clicks to a single offer page.",
    projection: "Lowest cost-per-click of any strategy; volume play.",
    bestFor: "Testing offers and creatives before scaling to leads.",
    suggestedDailyBudget: 10,
    adSets: [
      A("Local broad", "Best creative to everyone local", ["Dentistry", "Health & wellness"], 20, 60),
      A("Interest-refined", "Offer to dental intenders", ["Teeth whitening", "Dental implant", "Orthodontics"], 22, 55),
    ],
  },
  {
    key: "traffic-content",
    objective: "OUTCOME_TRAFFIC",
    name: "Authority Content Engine",
    tagline: "Push educational blog content to build trust + retargeting pools.",
    projection: "Feeds the retargeting engine with cheap warm audiences.",
    bestFor: "Clinics investing in SEO/content marketing.",
    suggestedDailyBudget: 8,
    adSets: [
      A("Education readers", "Top blog posts", ["Dentistry", "Health & wellness", "Oral hygiene"], 22, 60),
      A("Treatment researchers", "Deep-dive guides", ["Dental implant", "Orthodontics", "Cosmetic dentistry"], 25, 60),
    ],
  },
  {
    key: "traffic-gmb",
    objective: "OUTCOME_TRAFFIC",
    name: "Reviews & Profile Booster",
    tagline: "Send people to your Google profile/reviews to boost local rank.",
    projection: "Indirect: stronger map-pack position and social proof.",
    bestFor: "Clinics fighting for the local map pack.",
    suggestedDailyBudget: 6,
    adSets: [A("Local awareness → profile", "See why patients rate us 4.9★", ["Dentistry"], 22, 60)],
  },
  {
    key: "traffic-newpage",
    objective: "OUTCOME_TRAFFIC",
    name: "New Service Launch Traffic",
    tagline: "Announce a new treatment/technology and drive research clicks.",
    projection: "Awareness + intent building for the first 30 days of a launch.",
    bestFor: "Launching a new chair, scanner, or treatment line.",
    suggestedDailyBudget: 12,
    adSets: [
      A("Innovation angle", "New tech, better outcomes", ["Technology", "Health & wellness"], 25, 55),
      A("Treatment intenders", "People researching this treatment", ["Dentistry", "Cosmetic dentistry"], 25, 55),
    ],
  },
  {
    key: "traffic-competitor",
    objective: "OUTCOME_TRAFFIC",
    name: "Comparison / Switcher Play",
    tagline: "Win patients comparing clinics — transparent pricing angle.",
    projection: "Clicks from in-market patients actively choosing a clinic.",
    bestFor: "Competitive areas with many clinics.",
    suggestedDailyBudget: 12,
    adSets: [
      A("Price researchers", "Transparent price list angle", ["Dentistry", "Discounts and allowances"], 22, 55),
      A("Quality seekers", "Credentials + before/afters", ["Cosmetic dentistry", "Luxury goods"], 25, 55),
    ],
  },

  // ───────────────────────────── ENGAGEMENT (4)
  {
    key: "engage-whatsapp",
    objective: "OUTCOME_ENGAGEMENT",
    name: "WhatsApp Conversation Starter",
    tagline: "\"Message us\" ads that start WhatsApp chats your AI agent answers.",
    projection: "Chats convert at 2–3× form leads when answered instantly.",
    bestFor: "Clinics using Pydent's WhatsApp agent — chats get answered 24/7.",
    suggestedDailyBudget: 12,
    adSets: [
      A("Quick questions", "Ask us anything on WhatsApp", ["Dentistry", "Health & wellness"], 20, 55),
      A("Price checkers", "Message for a quick quote", ["Teeth whitening", "Dental implant"], 22, 55),
    ],
  },
  {
    key: "engage-video-views",
    objective: "OUTCOME_ENGAGEMENT",
    name: "Video Warm-Up Audience",
    tagline: "Cheap video views to build audiences for retargeting.",
    projection: "Pennies per view; feeds every other strategy.",
    bestFor: "Clinics with clinic-tour / testimonial videos.",
    suggestedDailyBudget: 8,
    adSets: [
      A("Clinic tour viewers", "Meet the clinic video", ["Dentistry", "Health & wellness"], 20, 60),
      A("Testimonial viewers", "Patient story videos", ["Dentistry"], 20, 60),
    ],
  },
  {
    key: "engage-social-proof",
    objective: "OUTCOME_ENGAGEMENT",
    name: "Social Proof Amplifier",
    tagline: "Boost your best organic posts to compound likes/shares.",
    projection: "Bigger page presence and cheaper future ads (social proof carries).",
    bestFor: "Clinics with active Instagram/Facebook content.",
    suggestedDailyBudget: 6,
    adSets: [A("Best-post boost", "Amplify top organic content", ["Dentistry", "Beauty"], 20, 55)],
  },
  {
    key: "engage-community",
    objective: "OUTCOME_ENGAGEMENT",
    name: "Local Community Builder",
    tagline: "Follower growth + engagement inside your service radius.",
    projection: "A growing local audience you can reach for free later.",
    bestFor: "New clinics building a base.",
    suggestedDailyBudget: 8,
    adSets: [
      A("Neighbourhood reach", "Community-first content", ["Dentistry", "Family"], 22, 60),
      A("Health-conscious", "Wellness lifestyle content", ["Health & wellness", "Fitness and wellness"], 22, 50),
    ],
  },

  // ───────────────────────────── AWARENESS (4)
  {
    key: "aware-launch",
    objective: "OUTCOME_AWARENESS",
    name: "Grand Opening Blitz",
    tagline: "Saturate the neighbourhood for a new clinic launch.",
    projection: "Maximum local reach in the first 30 days.",
    bestFor: "New clinics or new branches.",
    suggestedDailyBudget: 10,
    adSets: [
      A("Everyone nearby", "We're open — meet the team", ["Dentistry", "Health & wellness"], 20, 65),
      A("Families nearby", "Family-friendly angle", ["Parenting", "Family"], 25, 55),
    ],
  },
  {
    key: "aware-brand-recall",
    objective: "OUTCOME_AWARENESS",
    name: "Always-On Brand Recall",
    tagline: "Low-budget constant presence so you're the first clinic they think of.",
    projection: "Reach thousands monthly for coffee money.",
    bestFor: "Every clinic as a base layer under other campaigns.",
    suggestedDailyBudget: 5,
    adSets: [A("Local frequency", "Rotating brand creatives", ["Dentistry"], 20, 65)],
  },
  {
    key: "aware-doctor-brand",
    objective: "OUTCOME_AWARENESS",
    name: "Doctor Personal Brand",
    tagline: "Make your lead dentist locally famous — faces beat logos.",
    projection: "Trust that compounds into every other campaign.",
    bestFor: "Clinics with a charismatic lead doctor.",
    suggestedDailyBudget: 8,
    adSets: [A("Meet Dr. X", "Doctor-led education/tips", ["Dentistry", "Health & wellness"], 22, 60)],
  },
  {
    key: "aware-event",
    objective: "OUTCOME_AWARENESS",
    name: "Event / Open-Day Reach",
    tagline: "Fill a free-checkup day or community event.",
    projection: "Event awareness in a tight radius, fast.",
    bestFor: "Open days, screenings, school visits.",
    suggestedDailyBudget: 10,
    adSets: [A("Event radius blast", "Event details + RSVP", ["Family", "Health & wellness"], 20, 60)],
  },

  // ───────────────────────────── APP PROMOTION (3)
  {
    key: "app-installs",
    objective: "OUTCOME_APP_PROMOTION",
    name: "Patient App Installs",
    tagline: "Get existing + new patients onto the clinic app.",
    projection: "Installs from the local area at low CPI.",
    bestFor: "Clinics with a patient app in the stores.",
    suggestedDailyBudget: 10,
    adSets: [A("Local installers", "Book faster with the app", ["Dentistry", "Mobile app"], 20, 55)],
  },
  {
    key: "app-reengage",
    objective: "OUTCOME_APP_PROMOTION",
    name: "App Re-Engagement",
    tagline: "Wake up users who installed but stopped opening the app.",
    projection: "Cheap re-activation of an existing install base.",
    bestFor: "Apps with 500+ installs.",
    suggestedDailyBudget: 8,
    adSets: [A("Dormant users", "Reminder + new feature", ["Dentistry"], 20, 60)],
  },
  {
    key: "app-feature",
    objective: "OUTCOME_APP_PROMOTION",
    name: "Feature Launch Push",
    tagline: "Promote a new app feature (online booking, reminders).",
    projection: "Feature adoption from current patients.",
    bestFor: "App updates worth shouting about.",
    suggestedDailyBudget: 8,
    adSets: [A("Feature announce", "What's new in the app", ["Dentistry", "Technology"], 20, 60)],
  },
];

export function strategiesFor(objective: string): MetaStrategy[] {
  return META_STRATEGIES.filter((s) => s.objective === objective);
}

export function objectiveFor(key: string): MetaObjective | undefined {
  return META_OBJECTIVES.find((o) => o.key === key);
}
