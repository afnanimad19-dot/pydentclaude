# Pydental

**Voice agents, WhatsApp, SMS, email and pipeline — one calm workspace for dental clinics.**

Pydental is a SaaS platform for dental clinics that unifies every patient conversation
into a single workspace, plugged directly into the clinic's own **OpenDental** instance.
Your team ships faster, your patients feel heard, and revenue compounds — without
stitching tools together.

## What's inside

| Area | Route | What it does |
| --- | --- | --- |
| Marketing site | `/` | Landing page: channels, OpenDental integration, how it works |
| Overview | `/dashboard` | Daily KPIs, conversation volume, production booked via Pydental |
| Omnichannel Inbox | `/dashboard/inbox` | Every WhatsApp / SMS / email / voice conversation in one queue, with a live OpenDental patient panel |
| WhatsApp | `/dashboard/whatsapp` | Chats, broadcast campaigns, and a visual chatbot flow builder |
| SMS | `/dashboard/sms` | Reminders, confirmations, no-show recovery, templates with OpenDental merge fields |
| Email | `/dashboard/email` | Campaigns + automations measured in bookings, not opens |
| Voice Agents | `/dashboard/voice` | AI receptionists (Retell-style), call log, transcripts, sentiment |
| Pipeline | `/dashboard/pipeline` | Kanban from first message to accepted treatment |
| Patients | `/dashboard/patients` | OpenDental roster, schedule and recall worklist in a modern UI |
| Settings | `/dashboard/settings` | OpenDental API key connection + channel integrations |

## Demo mode (current state)

The entire app runs in **demo mode** with realistic sample-clinic data
(`src/lib/mock-data.ts`). Nothing connects to a live OpenDental database, phone
line, or messaging provider — so it's completely safe to explore and demo.

## OpenDental integration plan

`src/lib/opendental.ts` contains the API client. The rollout is deliberately staged
so a live clinic can never be put at risk:

1. **Phase 1 — Read-only**: `GET /patients`, `/appointments`, `/recalls`, `/treatplans`
   sync into the UI. Nothing is written back.
2. **Phase 2 — Opt-in writes** (per clinic, per action): `POST /appointments`,
   appointment confirmations, and `POST /commlogs` to log conversations to the chart.

Clinics authenticate with their own Developer/Customer key pair
(`Authorization: ODFHIR {DeveloperKey}/{CustomerKey}`) entered in Settings.

## Tech stack

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind CSS v4
- lucide-react (icons), recharts (charts)

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:3000 for the website, or http://localhost:3000/dashboard
for the workspace.

## Going live (next steps)

- Auth + multi-tenant clinic workspaces
- Real OpenDental sync (read-only first) behind the Settings toggle
- WhatsApp Business Cloud API, Twilio SMS, Resend email, Retell AI voice
- Persisted conversations, campaigns and pipeline in a database
