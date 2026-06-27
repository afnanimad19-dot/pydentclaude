# Pydental — Session Handoff / Context (for continuing in a new Claude Code session)

Paste this to a fresh Claude Code so it can pick up exactly where we are. It
describes the product, how everything is connected, what's done, and how to work.

## 1. What this is
**Pydental** — a multi-tenant SaaS for dental clinics: an AI omnichannel inbox
(WhatsApp / Instagram / Messenger), AI chat + voice agents that answer and **book
appointments**, a CRM (patients, pipeline, calendar, broadcasts, reports), and a
**privacy-safe Open Dental** integration (clinical data stays on the clinic's local
server). Built with Claude (Opus 4.8). Sold per clinic.

> Brand is now **Pydent** (renamed from "Pydental" across the UI). See also
> **STATUS.md**, **SOFTWARE_STACK_AND_COSTS.md**, **AI_TEAM.md**, **VOICE_SETUP.md**,
> **CONNECTIONS_SETUP.md**, **OPEN_DENTAL.md**, **RUN_PENDING_MIGRATIONS.sql**.

---

## ⭐ CURRENT BUILD STATUS (read this first — updated end of this session)

Legend: ✅ built & working · 🟡 built, needs an API key / approval to go live · ❌ not built.

### Sidebar structure (recently reorganised)
Overview · Omnichannel Inbox · **AI Team** (Helena/Sam/Kai/Angela) · **Chat Agents**
(All chat agents / Agent Hub / AI Learning) · **Voice Agents** (All voice agents /
Phone Numbers / Contacts / Call Logs) · WhatsApp · Instagram · Pipeline · Calendar ·
Patients · Workflows · Reports · Settings.

### Messaging
- **WhatsApp** ✅ inbound+outbound, webhook (`/api/whatsapp/webhook`), templates,
  broadcasts, 24h-window handling, AI auto-reply with booking tools, returning-contact
  welcome, voice notes. 🟡 needs the clinic's Meta number + tokens + `META_APP_SECRET`.
- **Instagram / Messenger** 🟡 same webhook handles them; needs the Meta app **Live**
  + permissions approved (App Review). Inbound DMs flow into the inbox.
- **SMS** ❌ tab exists but no provider wired. Needs **Twilio** (number + `TWILIO_*`).
- **Voice-note delivery to WhatsApp** ❌ plays in-app today; true Meta media upload not wired.

### Email
- Inbox **email tab** ✅ (UI). Sending: **Angela can send via Brevo** 🟡 (`BREVO_API_KEY`
  + `BREVO_FROM_EMAIL`). Connection **cards for Brevo + Mailchimp** ✅ in Integrations.
  ❌ Mailchimp campaign send, ❌ Gmail/clinic-domain inbound sync.

### AI Chat Agents ✅
- Create/edit (instructions + behavior/"what NOT to do" + **unlimited KB uploads**, PDF/
  Word text extracted, website import), book/reschedule/cancel tools, **Learning Agent**
  (captures unanswered questions → teach). Agent Hub = chat channel routing (chat-only).
- 🟡 replies need `OPENROUTER_API_KEY`; booking needs the agent's "Book appointments" ability ON.

### Voice Agents 🟡 (IMPORTANT — see gap)
- Voice agent editor (voice picker = **ElevenLabs library + cloning + preview**), test call
  (Vapi), behavior applied on calls, **Phone Numbers** page (Add: existing / Twilio / full
  **SIP-trunk** form), **Contacts**, **Call Logs** (list + recording/transcript/summary
  detail + status filter + CSV export). 🟡 needs `VAPI_API_KEY` + `ELEVENLABS_API_KEY` + a number.
- ❌ **GAP (asked, not built): the Vapi-/Callab-style ADVANCED voice settings** in the agent
  editor — Voice Activity Detection (min speech/silence, activation threshold, prefix
  padding, end-of-speech timeout), turn detection, noise reduction, answering-machine
  detection, reminder/call-duration limits, privacy toggles, post-call data extraction.
  The current voice editor is basic (voice, language, first message, instructions, behavior).
- ❌ **Voice-call booking tool** (book into the calendar from a live phone call) — chat books;
  the live-call booking tool isn't wired yet.
- ❌ Call Logs as a full **dedicated detail page** + "To"/campaign columns (currently a side
  panel; needs extra Vapi webhook fields). SIP form stores config; live SIP handshake is done in Vapi.

### AI Team — Helena, Sam, Kai, Angela ✅ (some tools need keys)
Each agent: brand knowledge (+ **unlimited uploaded brand docs**), **chat history/sessions**,
channels panel (green when connected), **Documents** (downloadable reports DOCX/PDF),
**Activity feed**, **Autopilot** scheduler. Model switchable to Claude via `TEAM_AI_MODEL`.
- **Helena:** blogs→WordPress ✅, image gen 🟡(`OPENAI_API_KEY`), GA4 + Search Console ✅,
  Facebook/Instagram post 🟡(Meta approval), Meta Ads data ✅, Google Ads 🟡(dev token),
  reports ✅, `research_url` (Firecrawl) 🟡.
- **Sam:** keyword research (free Google Autocomplete ✅ / full **DataForSEO** 🟡), competitors,
  backlinks, SERP 🟡(`DATAFORSEO_API_KEY`), page audit ✅, Search Console ✅, GBP post 🟡,
  `crawl_url` (Firecrawl) 🟡, reports ✅.
- **Kai:** Google reviews 🟡(GBP API approval) + Facebook reviews ✅, sentiment + reply ✅.
  ❌ broad mentions/competitor listening (needs paid social-listening data).
- **Angela:** recall list ✅, copy ✅, WhatsApp broadcast ✅, **email send** 🟡(Brevo).
- **Autopilot:** UI + `/api/cron/run` ✅ — 🟡 needs a cron pointed at it (`CRON_SECRET`).
- ❌ packages/entitlements (lock agents per plan) — comes with the admin panel.
- ❌ video generation (MuAPI/Higgsfield).

### Connections / Integrations ✅ (Google live; others need their app keys)
- Catalog (Google products, Meta/IG/FB, LinkedIn, Reddit, Pinterest, TikTok, WordPress,
  Shopify, Stripe, Notion, Brevo, Mailchimp) with per-clinic OAuth, green Connected state,
  **read/write toggle**, **disconnect confirm**, **Firecrawl** for crawling.
- ✅ **Google** (Analytics, Search Console, Business, Ads, Drive, Calendar, YouTube) +
  **WordPress self-hosted** (app password). 🟡 generic OAuth (Meta, LinkedIn, Reddit,
  Pinterest, TikTok, WordPress.com) light up when their `*_CLIENT_ID/_SECRET` are added.
- ❌ bespoke flows: X/Twitter (PKCE), Shopify (shop domain), TikTok Ads, Stripe Connect, Notion.

### Calendar & Booking ✅
- Week (now **24h, Sun→Sat**) / 15-day / 30-day views + month jump. Bookings from chat/inbox
  land on the calendar (name/phone/email/service), no double-book (slot conflict check), and
  forward to Open Dental when enabled. 🟡 Google Calendar push not wired.

### Open Dental 🟡 (code ready; user will connect later — DON'T disturb the live clinic)
- Settings card + gateway routes (slots/book/reschedule/cancel/doctors) + booking forward +
  external-id mirror ✅ (code). ❌ the **local connector** (Node app installed at the clinic)
  is NOT built. 🟡 user has the API key but is intentionally NOT connecting it yet.

### Patients / Contacts / Pipeline ✅ (UI; some demo)
- Patients list + profile (appointments). Reports = real patient/appointment data + CSV.
- ❌ User wants: rename "Patients" tab to **Contacts**; contact click should open a contact
  detail (NOT the patient page); trim the patient detail (remove payments/documents/insurance/
  treatment-plans/collect-payment, keep appointments); Voice-Agent Contacts = voice-source only,
  with **checkboxes/select-all + bulk export/import/delete** + a **country-flag phone dropdown**.

### Workflows 🟡
- Workflow list + **builder** page exist (UI). ❌ not executing real automations yet (no runner
  wired to triggers/actions). Treat as scaffold.

### Sample/demo data ✅ removed (real-clinic mode).

---

## 🔑 What's blocked ONLY by an API key / approval (add these → it works)
| Add in Netlify | Unlocks |
|---|---|
| `OPENROUTER_API_KEY` | all AI text |
| `SUPABASE_SERVICE_ROLE_KEY` | OAuth tokens, reports, autopilot, activity |
| `VAPI_API_KEY` + `ELEVENLABS_API_KEY` + a number | voice calls |
| `OPENAI_API_KEY` | image generation |
| `GOOGLE_OAUTH_CLIENT_ID/_SECRET` (+ verify app, add test users) | Google connections |
| `FACEBOOK_CLIENT_ID/_SECRET` + Meta app **Live** | FB/IG/Meta Ads |
| `DATAFORSEO_API_KEY` | full SEO data (free fallback works) |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads reporting |
| `BREVO_API_KEY` + `BREVO_FROM_EMAIL` | Angela email send |
| `FIRECRAWL_API_KEY` | whole-site crawling |
| `TWILIO_*` | SMS + UAE/Twilio voice numbers |
| `CRON_SECRET` + a scheduler → `/api/cron/run` | Autopilot actually firing |
| `TEAM_AI_MODEL=anthropic/claude-sonnet-4` | AI Team uses Claude |

## 🚧 The real remaining BUILD work (not just keys)
1. **Voice agent advanced settings** (VAD / turn detection / noise / AMD / call limits /
   privacy / post-call extraction) — the Vapi/Callab-style editor. **User asked for this.**
2. **Voice-call booking tool** (book from a live call → calendar + Open Dental).
3. **Open Dental local connector** + live test (when the user enables the key).
4. **Patients → Contacts** rename + contact detail page + trim patient tabs + voice-only
   contacts + country-flag phone picker + bulk select/import/export.
5. **Call Logs full detail page** + To/campaign columns; **Phone Numbers** card layout +
   provider methods (Ziwo/Maqsam/Vocalcom/GoAutoDial) like Callab.
6. **Workflows runner** (execute triggers→actions).
7. **SMS (Twilio)**, **Google Calendar push**, **WhatsApp audio delivery**,
   **Mailchimp send**, **X/Shopify/TikTok-Ads/Stripe/Notion** connectors.
8. **Billing/credits + Admin panel + packages/entitlements** — *deliberately last* (user said
   do it when the software is nearly finished).
9. **Video generation** (MuAPI/Higgsfield), **client-facing setup guide** MD.

## Migrations: run **RUN_PENDING_MIGRATIONS.sql** (bundles 0024→0034) in Supabase.

## 2. Repo, branch, hosting
- **GitHub:** `afnanimad19-dot/pydentclaude`. **Work only on branch
  `claude/vigilant-heisenberg-o5g281`.** Commit + push there (Netlify auto-deploys
  on push). Never push to other branches.
- **Hosting:** Netlify (site `pydentai.netlify.app`). The user redeploys after each push.
- **DB/Auth:** Supabase (Postgres + Auth). Direct DB is IPv6-only/unreachable from
  the sandbox — all access is via the Supabase JS client (`src/lib/supabase.ts`).
- **Stack:** Next.js 16 (App Router) + React 19 + Tailwind v4 + TypeScript.
  `lucide-react` icons. recharts.

## 3. How things connect
```
Patient (WhatsApp/IG/Messenger)
  → Meta webhook  /api/whatsapp/webhook   (one endpoint, all 3 Meta channels)
      → store conversation+message (per workspace) → auto-capture lead as patient
      → agent auto-reply (OpenRouter) with tools: slots/book/reschedule/cancel
          → appointment → Calendar (+ Open Dental if connected)
Voice: Vapi assistant → webhook /api/vapi/events → voice_calls (transcript/recording/summary)
Broadcasts: templates submitted to Meta → approved → send via Cloud API (+ cron for scheduled)
Open Dental: app → /api/opendental/* gateway → Cloudflare Tunnel → clinic local connector → Open Dental
```

## 4. Multi-tenant model (important)
- Each clinic = a **workspace**. `profiles(user_id → workspace_id)`; a DB trigger
  creates a workspace+profile on signup (migration 0014). Existing data was
  backfilled to the primary (oldest) account = `afnanimmad@gmail.com`.
- Every data table has `workspace_id`. **Reads are scoped in `src/lib/db.ts`** via
  `getWorkspaceId()`; inserts default to `current_workspace()` in the DB. Server
  routes (webhook etc.) tag rows explicitly. RLS is currently demo-open (isolation
  is app-level); strict RLS is a future hardening task.

## 5. Migrations (Supabase SQL Editor) — RUN ONCE, IN ORDER
`supabase/migrations/0001 … 0023`. **Migrations are not idempotent except the
recent catch-ups (0020+).** Re-running old seed files used to throw
`ERROR 42P10 ON CONFLICT` (fixed by replacing `on conflict (col)` with
`on conflict do nothing`, and routing all app upserts through `upsertRow()`).
- **`0022_add_missing_tables.sql`** — created the only two tables that were missing
  (`opendental_config`, `voice_calls`) + `appointments.external_id` + dedup index.
  Idempotent, no ON CONFLICT. **User confirmed this ran successfully.**
- **`0023_team_members.sql` — NEW, USER MUST RUN THIS.** Creates `team_members`
  (invite by email + role admin/editor/viewer + status invited/active), adds
  `wa_conversations.assigned_to`, and updates `handle_new_user()` so an invited
  email JOINS the existing clinic workspace instead of creating a new one.
  Idempotent (`create … if not exists`), no targeted ON CONFLICT. Run in a fresh tab.
- **`0024_voices.sql` — USER MUST RUN THIS.** Creates `voices` (per-clinic
  cloned voices) and adds `agents.voice_id`. Powers the Voice Library + custom voice
  feature. Idempotent, no ON CONFLICT.
- **`0025_clinic_settings.sql` — USER MUST RUN THIS.** Creates `clinic_settings`
  (the clinic website URL) for the "import knowledge from website" feature. Idempotent.
- **`0026_connections.sql` — NEW, USER MUST RUN THIS.** Creates `connections`
  (per-workspace integration status, readable) and `oauth_tokens` (per-workspace
  tokens, service-role only — no RLS policy). Powers the multi-tenant Google
  connections. Idempotent.

## 6. Env vars (Netlify → Site config → Environment variables)
Required/used:
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `OPENROUTER_API_KEY` (chat AI — agent replies fail without it)
- `META_APP_SECRET` (verifies webhook signatures; lenient if absent)
- `VAPI_API_KEY` (voice), optional `VAPI_WEBHOOK_SECRET`
- `ELEVENLABS_API_KEY` (voice library + custom voice cloning). Without it the
  Voice Library still loads a curated list and previews with the basic browser
  voice, but real audio previews and "record your own voice" are disabled.
- `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` (calendar)
- Optional: `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_STRICT_SIGNATURE`,
  `RETURNING_SESSION_MIN` (default 15), `CRON_SECRET`, `META_GRAPH_VERSION`.
Per-clinic creds (WhatsApp token, Page token, Open Dental URL/key) are saved IN-APP
(Settings) per workspace, not in env.

## 7. What's DONE
- Multi-tenant auth; demo data removed; signup → empty workspace (email verification
  is a Supabase toggle).
- Omnichannel inbox (WhatsApp/IG/Messenger live), lifecycle rail, assign-to-me /
  assign-to-teammate (dropdown) / hand-back-to-AI, scroll-to-latest.
- **Team members** (Settings → Team): invite staff by email + role
  (Administrator/Editor/Viewer), edit role, remove. Invited emails auto-join the
  clinic workspace on signup. In the inbox, any conversation can be assigned to
  "Me" or a named teammate — assigning to a human stops AI auto-reply until handed
  back. Stored in `team_members`; assignee in `wa_conversations.assigned_to`.
- Lead auto-capture; returning-session welcome (~15 min) with continue/follow-up/
  new-booking options.
- Chat agents: name/type/language/model, **Instructions** + **Behavior** boxes,
  knowledge-base upload, abilities (book/reschedule/cancel), channels.
- Booking tools: live slots (Open Dental or calendar fallback), book/reschedule/
  cancel → Calendar (+ Open Dental); slot-conflict prevention; double-reply dedupe.
- Pipeline on live leads; Broadcasts (template submit/sync to Meta, folder audiences,
  send-now/schedule via Netlify cron, delivered/read tracking).
- Calendar (month dropdown, click→patient details); Reports; Settings (tabbed) with a
  WhatsApp **Webhook activity** diagnostics panel.
- Open Dental: gateway routes + Settings connection card + `opendental-connector/`
  (local Node middleware) + Cloudflare Tunnel design.
- Voice (Vapi): `/api/vapi/events` webhook + `voice_calls` + Call-log UI (transcript/
  recording/summary, live badge) + voice preview button.
- **Voice Library + custom voices** (managed TTS / ElevenLabs): in the voice-agent
  editor, "Browse" opens a voice library — premade voices grouped by gender with
  real audio previews, plus "Create custom voice" (record ~20–30s in the browser →
  instant clone, with a consent checkbox). Chosen voice id is saved on the agent
  (`agents.voice_id`) and used for the live Vapi call (`provider: 11labs`). Custom
  voices stored per-clinic in `voices` (migration 0024). Routes: `/api/voice/list`,
  `/api/voice/preview`, `/api/voice/clone`. Falls back gracefully with no API key.
  NOTE: OmniVoice (user's fork) was evaluated but is GPU-only / not realtime, so we
  went with a managed TTS that also works for live calls.
- **Voice notes in the inbox**: when handling a chat yourself, type a message, pick a
  voice (your cloned voice or a premade one) and "Send as voice note" — it's generated
  via `/api/voice/preview` (ElevenLabs TTS) and dropped into the thread as a playable
  audio bubble. Needs ELEVENLABS_API_KEY; empty/curated list works offline. (Live
  WhatsApp *audio* delivery via Meta media API is a future step — today the note plays
  in-dashboard.)
- Agent editor: knowledge-base uploads are now **unlimited** (removed the 10-file cap).
  Instructions + Behavior are two separate boxes (Behavior = tone/rules/negative "what
  NOT to do"); both render for chat and voice agents. PDF/Word text is extracted via
  `/api/kb/extract`. Behavior is now included in the Vapi voice-call system prompt.
- **Website knowledge import**: clinic website URL saved in Settings → Connections
  (`clinic_settings`, migration 0025); agent editor has "Import from your website"
  which fetches + strips the page via `/api/kb/website` into the knowledge base.
- **Booking system**: `createBooking()` (db.ts) creates/links a lead (name/phone/
  email), books an appointment on our Calendar, and forwards to Open Dental
  `/api/opendental/book` when the clinic has it enabled. Surfaced as a BookingModal —
  "Quick booking" on the Calendar and a "Book" button in the inbox thread header
  (prefilled with the contact). NOTE: autonomous agent booking (LLM decides + calls
  the tool) is the remaining wiring step; the plumbing + OD forward are ready.
- **Calendar view switcher**: Week grid / Next 15 days / Next 30 days (agenda list),
  alongside the existing month jump dropdown.
- **Multi-tenant connections (Settings → Connections → IntegrationsPanel)**: per-clinic
  Google connections (Analytics, Search Console, Business Profile, Ads, Drive, Calendar)
  via OAuth popup. Cards show green "Connected · <email>" / "Not connected" and a
  Disconnect. Generalized `/api/google/oauth` carries `{ws, provider, popup}` in `state`;
  `/api/google/oauth/callback` stores tokens in `oauth_tokens` and status in
  `connections` PER WORKSPACE (service-role), then closes the popup via postMessage.
  `/api/connections/disconnect` removes both.

  ## How multi-tenant connections work (the meeting question)
  - The Netlify env vars hold ONE thing: the developer's *app* credentials
    (`GOOGLE_OAUTH_CLIENT_ID/SECRET`, the Vapi/ElevenLabs/OpenRouter keys). That is the
    SaaS's single app — like Calendly/Zapier having one Google app that everyone connects
    to. New clinics never touch Netlify.
  - Each clinic clicks Connect → approves in the Google popup → Google returns a code →
    the callback exchanges it for THAT clinic's tokens → stored per `workspace_id` in the
    DB. So every clinic's connection is its own, isolated by workspace — not shared, not
    in Netlify.
  - For non-OAuth keys (ElevenLabs/Vapi/OpenAI): either the SaaS provides them globally
    (env, you bill usage) OR each clinic pastes its own key into the dashboard (store
    per-workspace, like the Open Dental / WhatsApp config cards already do).
  - Google "Error 400: redirect_uri_mismatch" → in Google Cloud Console → Credentials →
    the OAuth client → Authorized redirect URIs, add the EXACT
    `https://<your-domain>/api/google/oauth/callback` (and the Netlify URL). Plus add the
    requested scopes/test users on the OAuth consent screen.

## 8. Key files
- `src/lib/db.ts` — all data access (workspace-scoped). `upsertRow()` = resilient
  upsert (no ON CONFLICT). `getWorkspaceId()`.
- `src/app/api/whatsapp/webhook/route.ts` — inbound + auto-reply + booking tools.
- `src/lib/agent-reply.ts` — OpenRouter, tool loop (book/slots/reschedule/cancel).
- `src/lib/wa-send.ts` — WhatsApp/Messenger send, creds resolved by phone/page id.
- `src/components/dashboard/agents-shared.tsx` — agent create/edit modal.
- `src/components/dashboard/team-members.tsx` — Team tab panel (invite/role/remove).
  Inbox assign-to-teammate lives in `src/app/dashboard/inbox/page.tsx`
  (`assignToPerson` / `assignToMe` → `setWaAssignee` in db.ts).
- `src/app/api/vapi/events/route.ts`, `src/app/dashboard/voice/page.tsx` — voice.
- `src/app/api/opendental/*`, `src/lib/opendental-gateway.ts`, `opendental-connector/`.
- Docs: `PROJECT_OVERVIEW.md`, `AGENT_GUIDE.md`, `VOICE_AGENT_VAPI.md`,
  `OPEN_DENTAL.md`, `OPEN_DENTAL_SETUP.md`, `GO_LIVE.md`.

## 9. Working conventions
- Always run `npx tsc --noEmit`, `npm run lint`, `npm run build` before committing.
  All must pass. (`node_modules` may need `npm install` first in a fresh sandbox.)
- Commit + push to `claude/vigilant-heisenberg-o5g281` after each chunk; the user
  redeploys on Netlify and runs any new SQL.
- When a change needs the DB, add a numbered migration in `supabase/migrations/` and
  tell the user to run it. Keep new migrations idempotent and avoid `on conflict (col)`.
- Per-clinic isolation: scope new reads by `workspace_id` (via `getWorkspaceId()`),
  set it on inserts (DB default handles authed client; server routes set it explicitly).

## 10. Known gotchas
- **Migrations run once, in order.** Re-running old ones can error; use `0020_catchup`.
- **WhatsApp test access tokens expire ~24h** — use a permanent System User token.
- The **Webhook activity** panel (Settings → WhatsApp) shows the exact reason an
  auto-reply did/didn't send (no agent / OpenRouter key / token expired / delivered).
- Test numbers only message **allowlisted recipients** until the Meta app is published.

## 11. Roadmap / what's next
1. ~~Team members + roles~~ ✅ DONE (invite by email; Administrator/Editor/Viewer;
   inbox assign-to-teammate). Next: enforce role permissions in the UI/routes
   (currently roles are stored but not yet gating access).
2. Voice library + custom voice cloning ✅ DONE (managed TTS; works for previews and
   live Vapi calls). Remaining "weppy": phone-booking tool on the Vapi assistant so
   voice calls can actually book/reschedule/cancel like the chat agents do.
3. Website chat widget + HubSpot/Zoho lead sync (marketing data only).
4. PDF/Word knowledge-base extraction; strict RLS hardening; OpenDental connector
   productionising (find-or-create patient → real PatNum).
