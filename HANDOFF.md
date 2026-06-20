# Pydental — Session Handoff / Context (for continuing in a new Claude Code session)

Paste this to a fresh Claude Code so it can pick up exactly where we are. It
describes the product, how everything is connected, what's done, and how to work.

## 1. What this is
**Pydental** — a multi-tenant SaaS for dental clinics: an AI omnichannel inbox
(WhatsApp / Instagram / Messenger), AI chat + voice agents that answer and **book
appointments**, a CRM (patients, pipeline, calendar, broadcasts, reports), and a
**privacy-safe Open Dental** integration (clinical data stays on the clinic's local
server). Built with Claude (Opus 4.8). Sold per clinic.

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
- **`0024_voices.sql` — NEW, USER MUST RUN THIS.** Creates `voices` (per-clinic
  cloned voices) and adds `agents.voice_id`. Powers the Voice Library + custom voice
  feature. Idempotent, no ON CONFLICT.

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
