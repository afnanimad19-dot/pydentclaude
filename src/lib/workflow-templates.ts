// Workflow template gallery — dental-flavored starting points, in the spirit
// of respond.io's template browser.

import type { WorkflowNode } from "./db";

export interface WorkflowTemplate {
  key: string;
  name: string;
  description: string;
  channel: string;
  category: "Auto-responder" | "Routing & Assignment" | "Recall & Recovery" | "Reviews & Feedback" | "Ads & Leads";
  nodes: WorkflowNode[];
}

const n = (id: string, type: WorkflowNode["type"], title: string, detail: string): WorkflowNode => ({ id, type, title, detail });

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    key: "welcome",
    name: "Welcome Message",
    description: "Send a warm welcome every time a new patient starts a conversation with the clinic.",
    channel: "whatsapp",
    category: "Auto-responder",
    nodes: [
      n("t1", "trigger", "Trigger: conversation opened", "A contact messages the clinic for the first time"),
      n("t2", "message", "Welcome message", "“Hi {{first_name}}! Welcome to our clinic 🦷 How can we help today?”"),
      n("t3", "agent", "AI agent takes over", "Assigned chat agent answers from its knowledge base"),
    ],
  },
  {
    key: "away",
    name: "Away Message with Business Hours",
    description: "Reply automatically when patients message outside office hours.",
    channel: "whatsapp",
    category: "Auto-responder",
    nodes: [
      n("t1", "trigger", "Trigger: conversation opened", "Message received outside business hours"),
      n("t2", "condition", "Outside office hours?", "Mon–Fri 8am–6pm, Sat 9am–2pm"),
      n("t3", "message", "Away message", "“We're closed right now — we'll reply first thing in the morning. For emergencies call…”"),
      n("t4", "action", "Create follow-up task", "Queue the conversation for the morning shift"),
    ],
  },
  {
    key: "welcome-email",
    name: "Welcome & Ask For Email",
    description: "Greet new contacts and collect their email if you don't have it.",
    channel: "whatsapp",
    category: "Auto-responder",
    nodes: [
      n("t1", "trigger", "Trigger: conversation opened", "New contact, no email on file"),
      n("t2", "message", "Welcome + ask email", "“Welcome! What's the best email for your appointment confirmations?”"),
      n("t3", "action", "Save to patient chart", "Store the reply in the patient's contact info"),
    ],
  },
  {
    key: "least-open",
    name: "Assignment: Least Open Contacts",
    description: "Assign new conversations to the team member with the fewest open chats.",
    channel: "whatsapp",
    category: "Routing & Assignment",
    nodes: [
      n("t1", "trigger", "Trigger: conversation opened", "A contact starts a conversation"),
      n("t2", "message", "Hold message", "“One moment — connecting you with our team.”"),
      n("t3", "action", "Assign: least open contacts", "Route to the team member with the fewest open conversations"),
      n("t4", "message", "Assignment message", "“You're now chatting with {{assignee_name}}!”"),
    ],
  },
  {
    key: "round-robin",
    name: "Assignment: Round Robin",
    description: "Distribute new conversations across the front-desk team evenly.",
    channel: "whatsapp",
    category: "Routing & Assignment",
    nodes: [
      n("t1", "trigger", "Trigger: conversation opened", "A contact starts a conversation"),
      n("t2", "action", "Assign round robin", "Rotate through available team members in order"),
      n("t3", "message", "Assignment message", "“You've been connected with {{assignee_name}}.”"),
    ],
  },
  {
    key: "language-routing",
    name: "Routing: By Language",
    description: "Detect the patient's language and route to the right agent.",
    channel: "whatsapp",
    category: "Routing & Assignment",
    nodes: [
      n("t1", "trigger", "Trigger: conversation opened", "Any inbound message"),
      n("t2", "condition", "Detect language", "English / Spanish — based on the first message"),
      n("t3", "agent", "Route to language agent", "Spanish → Mila (ES), English → default agent"),
    ],
  },
  {
    key: "recall",
    name: "Hygiene Recall & Rebooking",
    description: "Win back overdue hygiene patients automatically with slots they can tap.",
    channel: "whatsapp",
    category: "Recall & Recovery",
    nodes: [
      n("t1", "trigger", "Trigger: recall due", "Patient overdue for hygiene ≥ 30 days"),
      n("t2", "message", "Recall message", "“Hi {{first_name}}, you're due for your cleaning…” with 3 slot buttons"),
      n("t3", "condition", "Replied within 24h?", "If silent, retry once; then queue a voice-agent call"),
      n("t4", "action", "Book appointment", "Create the appointment in the chosen slot"),
      n("t5", "message", "Confirm + remind", "Instant confirmation, reminders at T-24h and T-2h"),
    ],
  },
  {
    key: "no-show",
    name: "No-Show Recovery",
    description: "Recover broken appointments with an empathetic same-day rebook text.",
    channel: "sms",
    category: "Recall & Recovery",
    nodes: [
      n("t1", "trigger", "Trigger: appointment broken", "Appointment marked Broken"),
      n("t2", "message", "Rebook text", "“We missed you today — want to grab a new time?” with booking link"),
      n("t3", "condition", "Booked within 48h?", "If not → add to Pipeline and notify Front Desk"),
    ],
  },
  {
    key: "treatment-followup",
    name: "Treatment Plan Follow-Up",
    description: "Nudge patients with presented-but-unscheduled treatment plans.",
    channel: "whatsapp",
    category: "Recall & Recovery",
    nodes: [
      n("t1", "trigger", "Trigger: unscheduled treatment", "Treatment plan presented > 7 days ago, not accepted"),
      n("t2", "agent", "Sales agent reaches out", "Sam follows up with financing options from the knowledge base"),
      n("t3", "wait", "Wait 3 days", "Give the patient time to decide"),
      n("t4", "condition", "Accepted?", "If yes → book; if no → second touch with consult offer"),
    ],
  },
  {
    key: "csat",
    name: "Post-Visit Review Request",
    description: "Ask for a Google review a few hours after each completed visit.",
    channel: "sms",
    category: "Reviews & Feedback",
    nodes: [
      n("t1", "trigger", "Trigger: appointment completed", "4 hours after the visit"),
      n("t2", "message", "How was your visit?", "“How was your visit today? Reply 1–5.”"),
      n("t3", "condition", "Rated 4–5?", "If yes → send the Google review link; if 1–3 → alert the office manager"),
    ],
  },
  {
    key: "ctc-ads",
    name: "Click-to-Chat Ads: Appointment Scheduling",
    description: "Convert contacts arriving from Instagram/Facebook ads straight into bookings.",
    channel: "whatsapp",
    category: "Ads & Leads",
    nodes: [
      n("t1", "trigger", "Trigger: contact from CTC ad", "Contact opens a chat from a click-to-chat ad"),
      n("t2", "message", "Promo welcome", "“Thanks for your interest in our {{promo}} — here's how it works…”"),
      n("t3", "agent", "Appointment setter takes over", "AI agent offers slots and books directly"),
      n("t4", "action", "Add to pipeline", "Create a deal in New lead with the ad source"),
    ],
  },
  {
    key: "vip",
    name: "Routing: VIP Patients",
    description: "Recognize high-value patients and route them to a dedicated person.",
    channel: "whatsapp",
    category: "Routing & Assignment",
    nodes: [
      n("t1", "trigger", "Trigger: conversation opened", "Any inbound message"),
      n("t2", "condition", "VIP patient?", "Lifetime value > $5,000 or tagged VIP"),
      n("t3", "action", "Assign to office manager", "Skip the queue and notify immediately"),
    ],
  },
];
