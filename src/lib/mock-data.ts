// Demo-mode dataset for Pydental. Every dashboard screen reads from here so the
// whole product can be explored end-to-end before any live integration
// (OpenDental, WhatsApp Business, Twilio, Retell) is connected.

export type Channel = "whatsapp" | "instagram" | "messenger" | "sms" | "email" | "voice";

export interface Patient {
  id: string;
  patNum: number; // OpenDental PatNum
  name: string;
  phone: string;
  email: string;
  birthdate: string;
  balance: number;
  insurance: string;
  lastVisit: string;
  nextAppointment: string | null;
  recallDue: boolean;
  status: "Active" | "Inactive" | "New";
}

export interface Appointment {
  id: string;
  aptNum: number; // OpenDental AptNum
  patientId: string;
  patientName: string;
  provider: string;
  operatory: string;
  procedure: string;
  date: string;
  time: string;
  durationMin: number;
  status: "Scheduled" | "Confirmed" | "Completed" | "Broken" | "Unconfirmed";
  confirmedVia: Channel | null;
}

export interface Message {
  id: string;
  direction: "inbound" | "outbound";
  author: string;
  body: string;
  time: string;
  byBot?: boolean;
}

export interface Conversation {
  id: string;
  channel: Channel;
  patientId: string;
  patientName: string;
  preview: string;
  time: string;
  unread: number;
  assignedTo: string | null;
  tags: string[];
  messages: Message[];
}

export interface VoiceAgent {
  id: string;
  name: string;
  role: string;
  voice: string;
  language: string;
  status: "Live" | "Paused" | "Draft";
  phoneNumber: string;
  callsToday: number;
  avgDurationSec: number;
  bookingRate: number;
}

export interface VoiceCall {
  id: string;
  agentId: string;
  agentName: string;
  patientName: string;
  phone: string;
  direction: "inbound" | "outbound";
  startedAt: string;
  durationSec: number;
  outcome: "Booked" | "Rescheduled" | "Question answered" | "Voicemail" | "Transferred" | "Missed";
  sentiment: "positive" | "neutral" | "negative";
  transcript: { speaker: "agent" | "patient"; text: string }[];
}

export interface Broadcast {
  id: string;
  channel: Channel;
  name: string;
  audience: string;
  recipients: number;
  delivered: number;
  read: number;
  replied: number;
  booked: number;
  status: "Sent" | "Scheduled" | "Draft" | "Sending";
  sentAt: string;
}

export interface EmailCampaign {
  id: string;
  name: string;
  subject: string;
  audience: string;
  recipients: number;
  openRate: number;
  clickRate: number;
  bookings: number;
  status: "Sent" | "Scheduled" | "Draft";
  sentAt: string;
}

export interface Deal {
  id: string;
  patientName: string;
  treatment: string;
  value: number;
  source: Channel | "walk-in" | "referral";
  owner: string;
  daysInStage: number;
}

export interface PipelineStage {
  id: string;
  name: string;
  deals: Deal[];
}

export interface BotNode {
  id: string;
  type: "trigger" | "message" | "condition" | "action" | "handoff";
  title: string;
  detail: string;
}

export interface BotFlow {
  id: string;
  name: string;
  channel: Channel;
  status: "Live" | "Paused" | "Draft";
  triggeredToday: number;
  completionRate: number;
  nodes: BotNode[];
}

// ---------------------------------------------------------------------------

export const patients: Patient[] = [
  { id: "p1", patNum: 1042, name: "Maria Hernandez", phone: "+1 (305) 555-0114", email: "maria.h@gmail.com", birthdate: "1987-04-12", balance: 0, insurance: "Delta Dental PPO", lastVisit: "2026-05-28", nextAppointment: "2026-06-12 09:00", recallDue: false, status: "Active" },
  { id: "p2", patNum: 1187, name: "James Carter", phone: "+1 (305) 555-0162", email: "jcarter88@yahoo.com", birthdate: "1979-11-03", balance: 240.5, insurance: "Cigna Dental", lastVisit: "2025-12-15", nextAppointment: null, recallDue: true, status: "Active" },
  { id: "p3", patNum: 1290, name: "Aisha Williams", phone: "+1 (786) 555-0190", email: "aisha.w@outlook.com", birthdate: "1994-02-21", balance: 0, insurance: "MetLife", lastVisit: "2026-06-02", nextAppointment: "2026-06-13 14:30", recallDue: false, status: "Active" },
  { id: "p4", patNum: 1311, name: "Robert Kim", phone: "+1 (305) 555-0177", email: "rkim@gmail.com", birthdate: "1968-07-30", balance: 1180, insurance: "Self-pay", lastVisit: "2026-04-10", nextAppointment: "2026-06-18 11:00", recallDue: false, status: "Active" },
  { id: "p5", patNum: 1402, name: "Sofia Lopez", phone: "+1 (786) 555-0145", email: "sofia.lopez@gmail.com", birthdate: "2001-09-17", balance: 0, insurance: "Guardian", lastVisit: "2025-11-20", nextAppointment: null, recallDue: true, status: "Inactive" },
  { id: "p6", patNum: 1455, name: "Daniel Osei", phone: "+1 (305) 555-0133", email: "d.osei@gmail.com", birthdate: "1990-01-08", balance: 75, insurance: "Aetna", lastVisit: "2026-06-09", nextAppointment: "2026-09-09 10:00", recallDue: false, status: "Active" },
  { id: "p7", patNum: 1503, name: "Emily Tran", phone: "+1 (786) 555-0108", email: "emily.tran@icloud.com", birthdate: "1998-06-25", balance: 0, insurance: "Delta Dental PPO", lastVisit: "—", nextAppointment: "2026-06-12 16:00", recallDue: false, status: "New" },
  { id: "p8", patNum: 1544, name: "Luis Mendoza", phone: "+1 (305) 555-0121", email: "lmendoza@hotmail.com", birthdate: "1975-03-14", balance: 520, insurance: "Humana", lastVisit: "2026-02-02", nextAppointment: null, recallDue: true, status: "Active" },
];

export const appointments: Appointment[] = [
  { id: "a1", aptNum: 5012, patientId: "p1", patientName: "Maria Hernandez", provider: "Dr. Patel", operatory: "Op 1", procedure: "Prophylaxis + Exam", date: "2026-06-12", time: "09:00", durationMin: 60, status: "Confirmed", confirmedVia: "whatsapp" },
  { id: "a2", aptNum: 5013, patientId: "p7", patientName: "Emily Tran", provider: "Dr. Patel", operatory: "Op 2", procedure: "New Patient Exam + FMX", date: "2026-06-12", time: "16:00", durationMin: 90, status: "Confirmed", confirmedVia: "voice" },
  { id: "a3", aptNum: 5014, patientId: "p3", patientName: "Aisha Williams", provider: "Dr. Gomez", operatory: "Op 3", procedure: "Crown Seat #19", date: "2026-06-13", time: "14:30", durationMin: 60, status: "Unconfirmed", confirmedVia: null },
  { id: "a4", aptNum: 5015, patientId: "p4", patientName: "Robert Kim", provider: "Dr. Gomez", operatory: "Op 1", procedure: "Implant Consult", date: "2026-06-18", time: "11:00", durationMin: 45, status: "Scheduled", confirmedVia: null },
  { id: "a5", aptNum: 5016, patientId: "p6", patientName: "Daniel Osei", provider: "Hygiene — Kelly", operatory: "Op 4", procedure: "Perio Maintenance", date: "2026-09-09", time: "10:00", durationMin: 50, status: "Scheduled", confirmedVia: "sms" },
];

export const conversations: Conversation[] = [
  {
    id: "c1", channel: "whatsapp", patientId: "p1", patientName: "Maria Hernandez",
    preview: "Perfect, see you Friday at 9!", time: "9:42 AM", unread: 0, assignedTo: "Front Desk", tags: ["confirmation"],
    messages: [
      { id: "m1", direction: "outbound", author: "Recall Bot", byBot: true, body: "Hi Maria! 👋 This is Bright Smile Dental. You're due for your cleaning — Dr. Patel has Friday Jun 12 at 9:00 AM open. Want me to book it?", time: "Yesterday 4:10 PM" },
      { id: "m2", direction: "inbound", author: "Maria Hernandez", body: "Yes please, that works for me", time: "Yesterday 6:31 PM" },
      { id: "m3", direction: "outbound", author: "Recall Bot", byBot: true, body: "You're booked ✅ Friday Jun 12, 9:00 AM with Dr. Patel. Reply RESCHEDULE anytime if plans change.", time: "Yesterday 6:31 PM" },
      { id: "m4", direction: "inbound", author: "Maria Hernandez", body: "Perfect, see you Friday at 9!", time: "9:42 AM" },
    ],
  },
  {
    id: "c2", channel: "voice", patientId: "p7", patientName: "Emily Tran",
    preview: "Call summary: New patient booked for Jun 12, 4:00 PM", time: "9:15 AM", unread: 1, assignedTo: null, tags: ["new-patient", "voice-agent"],
    messages: [
      { id: "m5", direction: "inbound", author: "Ava (Voice Agent)", byBot: true, body: "📞 Inbound call handled by Ava (3m 12s). Caller asked about new-patient availability and insurance. Outcome: booked New Patient Exam + FMX for Jun 12, 4:00 PM with Dr. Patel. Verified Delta Dental PPO.", time: "9:15 AM" },
    ],
  },
  {
    id: "c3", channel: "sms", patientId: "p3", patientName: "Aisha Williams",
    preview: "Can I move it to 3pm instead?", time: "8:58 AM", unread: 2, assignedTo: null, tags: ["reschedule"],
    messages: [
      { id: "m6", direction: "outbound", author: "Reminder Bot", byBot: true, body: "Reminder: crown seat appointment tomorrow Jun 13 at 2:30 PM with Dr. Gomez. Reply C to confirm or R to reschedule.", time: "8:00 AM" },
      { id: "m7", direction: "inbound", author: "Aisha Williams", body: "R", time: "8:57 AM" },
      { id: "m8", direction: "inbound", author: "Aisha Williams", body: "Can I move it to 3pm instead?", time: "8:58 AM" },
    ],
  },
  {
    id: "c4", channel: "email", patientId: "p4", patientName: "Robert Kim",
    preview: "Re: Your implant consult — financing options", time: "Yesterday", unread: 0, assignedTo: "Dr. Gomez", tags: ["treatment-plan", "high-value"],
    messages: [
      { id: "m9", direction: "outbound", author: "Dr. Gomez", body: "Hi Robert, ahead of your consult on Jun 18 I've attached the treatment plan options for the implant at #30, including the financing breakdown we discussed. Happy to walk through it on a quick call.", time: "Yesterday 2:20 PM" },
      { id: "m10", direction: "inbound", author: "Robert Kim", body: "Thanks Dr. Gomez. The 12-month plan looks doable. I'll bring my questions on the 18th.", time: "Yesterday 5:47 PM" },
    ],
  },
  {
    id: "c5", channel: "whatsapp", patientId: "p8", patientName: "Luis Mendoza",
    preview: "What are your Saturday hours?", time: "Yesterday", unread: 1, assignedTo: null, tags: ["question"],
    messages: [
      { id: "m11", direction: "inbound", author: "Luis Mendoza", body: "What are your Saturday hours?", time: "Yesterday 7:12 PM" },
      { id: "m12", direction: "outbound", author: "FAQ Bot", byBot: true, body: "We're open Saturdays 9 AM – 2 PM. Want me to check availability for you this Saturday?", time: "Yesterday 7:12 PM" },
    ],
  },
  {
    id: "c6", channel: "sms", patientId: "p2", patientName: "James Carter",
    preview: "Ok I'll call back next week about the balance", time: "Mon", unread: 0, assignedTo: "Billing", tags: ["billing", "recall-due"],
    messages: [
      { id: "m13", direction: "outbound", author: "Billing Bot", byBot: true, body: "Hi James, a friendly note from Bright Smile Dental: you have an open balance of $240.50. You can pay securely here: pay.brightsmile.demo/8821 — or reply HELP to talk to our billing team.", time: "Mon 10:00 AM" },
      { id: "m14", direction: "inbound", author: "James Carter", body: "Ok I'll call back next week about the balance", time: "Mon 11:34 AM" },
    ],
  },
  {
    id: "c7", channel: "instagram", patientId: "p5", patientName: "Sofia Lopez",
    preview: "Do you do teeth whitening? saw your reel 😍", time: "10:21 AM", unread: 1, assignedTo: null, tags: ["new-lead", "whitening"],
    messages: [
      { id: "m15", direction: "inbound", author: "Sofia Lopez", body: "Hey! Do you do teeth whitening? Saw your reel 😍", time: "10:18 AM" },
      { id: "m16", direction: "outbound", author: "Social Bot", byBot: true, body: "Hi Sofia! 💜 Yes — we offer in-office Zoom whitening and take-home trays. New patients get a free whitening consult. Want me to find you a time this week?", time: "10:19 AM" },
      { id: "m17", direction: "inbound", author: "Sofia Lopez", body: "Do you do teeth whitening? saw your reel 😍", time: "10:21 AM" },
    ],
  },
  {
    id: "c8", channel: "messenger", patientId: "p6", patientName: "Daniel Osei",
    preview: "Is Saturday available for a checkup?", time: "Yesterday", unread: 2, assignedTo: null, tags: ["facebook", "question"],
    messages: [
      { id: "m18", direction: "inbound", author: "Daniel Osei", body: "Hi, found you on Facebook. Is Saturday available for a checkup?", time: "Yesterday 3:02 PM" },
      { id: "m19", direction: "outbound", author: "Social Bot", byBot: true, body: "Hi Daniel! We're open Saturdays 9 AM–2 PM. I can offer Sat Jun 14 at 10:30 AM with Dr. Patel — shall I book it?", time: "Yesterday 3:02 PM" },
      { id: "m20", direction: "inbound", author: "Daniel Osei", body: "Is Saturday available for a checkup?", time: "Yesterday 3:05 PM" },
    ],
  },
];

export const voiceAgents: VoiceAgent[] = [
  { id: "va1", name: "Ava", role: "Front-desk receptionist — answers, books, reschedules 24/7", voice: "Warm female · US English", language: "English + Spanish", status: "Live", phoneNumber: "+1 (305) 555-0100", callsToday: 23, avgDurationSec: 168, bookingRate: 0.61 },
  { id: "va2", name: "Leo", role: "Recall & reactivation — calls overdue hygiene patients", voice: "Friendly male · US English", language: "English", status: "Live", phoneNumber: "+1 (305) 555-0101", callsToday: 41, avgDurationSec: 94, bookingRate: 0.34 },
  { id: "va3", name: "Mia", role: "Insurance verification — calls payers, logs eligibility", voice: "Neutral female · US English", language: "English", status: "Paused", phoneNumber: "+1 (305) 555-0102", callsToday: 0, avgDurationSec: 412, bookingRate: 0 },
];

export const voiceCalls: VoiceCall[] = [
  {
    id: "vc1", agentId: "va1", agentName: "Ava", patientName: "Emily Tran", phone: "+1 (786) 555-0108",
    direction: "inbound", startedAt: "Today 9:12 AM", durationSec: 192, outcome: "Booked", sentiment: "positive",
    transcript: [
      { speaker: "agent", text: "Thank you for calling Bright Smile Dental, this is Ava. How can I help you today?" },
      { speaker: "patient", text: "Hi, I'm new to the area and looking for a dentist. Do you take Delta Dental?" },
      { speaker: "agent", text: "We do take Delta Dental PPO. I'd love to get you set up — our next new-patient opening is this Friday at 4 PM with Dr. Patel. Does that work?" },
      { speaker: "patient", text: "Friday at 4 works great." },
      { speaker: "agent", text: "Wonderful. Can I get your full name and date of birth to create your chart?" },
    ],
  },
  {
    id: "vc2", agentId: "va2", agentName: "Leo", patientName: "Sofia Lopez", phone: "+1 (786) 555-0145",
    direction: "outbound", startedAt: "Today 8:45 AM", durationSec: 71, outcome: "Voicemail", sentiment: "neutral",
    transcript: [
      { speaker: "agent", text: "Hi Sofia, this is Leo calling from Bright Smile Dental. It's been a little while since your last cleaning and we'd love to see you back. You can book by replying to our text or calling us at 305-555-0100. Take care!" },
    ],
  },
  {
    id: "vc3", agentId: "va1", agentName: "Ava", patientName: "Unknown caller", phone: "+1 (954) 555-0188",
    direction: "inbound", startedAt: "Today 8:21 AM", durationSec: 235, outcome: "Transferred", sentiment: "negative",
    transcript: [
      { speaker: "patient", text: "I've been in pain since my filling last week and I want to speak with the doctor now." },
      { speaker: "agent", text: "I'm so sorry to hear you're in pain — that's a priority for us. Let me connect you directly with our clinical team right away. Please hold for just a moment." },
    ],
  },
  {
    id: "vc4", agentId: "va2", agentName: "Leo", patientName: "James Carter", phone: "+1 (305) 555-0162",
    direction: "outbound", startedAt: "Yesterday 3:30 PM", durationSec: 154, outcome: "Booked", sentiment: "positive",
    transcript: [
      { speaker: "agent", text: "Hi James, Leo from Bright Smile Dental. You're overdue for your 6-month cleaning — want me to find you a time?" },
      { speaker: "patient", text: "Yeah, I keep putting it off. What do you have on a late afternoon?" },
      { speaker: "agent", text: "I have Tuesday Jun 16 at 5:00 PM or Thursday Jun 18 at 4:30 PM." },
      { speaker: "patient", text: "Thursday at 4:30." },
    ],
  },
];

export const broadcasts: Broadcast[] = [
  { id: "b1", channel: "whatsapp", name: "June recall — 6 months overdue", audience: "Recall due > 180 days (214 patients)", recipients: 214, delivered: 209, read: 182, replied: 64, booked: 31, status: "Sent", sentAt: "2026-06-08" },
  { id: "b2", channel: "whatsapp", name: "Whitening promo — Father's Day", audience: "Active patients, age 25–60 (486)", recipients: 486, delivered: 480, read: 391, replied: 47, booked: 18, status: "Sent", sentAt: "2026-06-05" },
  { id: "b3", channel: "sms", name: "Unconfirmed appts — next 48h", audience: "Tomorrow + Friday unconfirmed (12)", recipients: 12, delivered: 12, read: 0, replied: 9, booked: 9, status: "Sent", sentAt: "2026-06-10" },
  { id: "b4", channel: "whatsapp", name: "Hurricane closure notice", audience: "All active patients (1,240)", recipients: 0, delivered: 0, read: 0, replied: 0, booked: 0, status: "Draft", sentAt: "—" },
  { id: "b5", channel: "sms", name: "Insurance benefits expiring — use it or lose it", audience: "Remaining benefits > $500 (167)", recipients: 167, delivered: 0, read: 0, replied: 0, booked: 0, status: "Scheduled", sentAt: "2026-06-15" },
];

export const emailCampaigns: EmailCampaign[] = [
  { id: "e1", name: "Monthly newsletter — June", subject: "Summer smiles: 3 tips + a whitening offer inside", audience: "All subscribers (2,180)", recipients: 2180, openRate: 0.41, clickRate: 0.072, bookings: 14, status: "Sent", sentAt: "2026-06-03" },
  { id: "e2", name: "Treatment plan follow-up (auto)", subject: "Your treatment plan from Bright Smile Dental", audience: "Unscheduled tx plans, 7-day drip", recipients: 38, openRate: 0.63, clickRate: 0.18, bookings: 9, status: "Sent", sentAt: "Ongoing" },
  { id: "e3", name: "Reactivation — 12+ months", subject: "We miss your smile, {{first_name}}", audience: "Inactive > 12 months (342)", recipients: 342, openRate: 0.28, clickRate: 0.051, bookings: 6, status: "Sent", sentAt: "2026-05-22" },
  { id: "e4", name: "Post-visit review request (auto)", subject: "How was your visit?", audience: "Completed appts, +4 hours", recipients: 0, openRate: 0, clickRate: 0, bookings: 0, status: "Scheduled", sentAt: "Ongoing" },
];

export const pipeline: PipelineStage[] = [
  {
    id: "s1", name: "New lead",
    deals: [
      { id: "d1", patientName: "Karen Phillips", treatment: "Invisalign consult", value: 4800, source: "whatsapp", owner: "Front Desk", daysInStage: 1 },
      { id: "d2", patientName: "Tom Becker", treatment: "New patient exam", value: 350, source: "voice", owner: "Ava (AI)", daysInStage: 0 },
      { id: "d3", patientName: "Nina Alvarez", treatment: "Emergency — toothache", value: 600, source: "sms", owner: "Front Desk", daysInStage: 0 },
    ],
  },
  {
    id: "s2", name: "Contacted",
    deals: [
      { id: "d4", patientName: "Sofia Lopez", treatment: "Recall cleaning", value: 220, source: "voice", owner: "Leo (AI)", daysInStage: 2 },
      { id: "d5", patientName: "Mark Johnson", treatment: "Veneers consult", value: 9600, source: "email", owner: "Dr. Gomez", daysInStage: 4 },
    ],
  },
  {
    id: "s3", name: "Consult booked",
    deals: [
      { id: "d6", patientName: "Robert Kim", treatment: "Implant #30", value: 4200, source: "email", owner: "Dr. Gomez", daysInStage: 6 },
      { id: "d7", patientName: "Emily Tran", treatment: "New patient exam + FMX", value: 420, source: "voice", owner: "Ava (AI)", daysInStage: 1 },
    ],
  },
  {
    id: "s4", name: "Treatment presented",
    deals: [
      { id: "d8", patientName: "Patricia Wells", treatment: "Full-arch restoration", value: 18500, source: "referral", owner: "Dr. Patel", daysInStage: 9 },
      { id: "d9", patientName: "Luis Mendoza", treatment: "Crown #14 + filling", value: 1650, source: "whatsapp", owner: "Front Desk", daysInStage: 3 },
    ],
  },
  {
    id: "s5", name: "Accepted / scheduled",
    deals: [
      { id: "d10", patientName: "Aisha Williams", treatment: "Crown seat #19", value: 1280, source: "sms", owner: "Front Desk", daysInStage: 2 },
      { id: "d11", patientName: "James Carter", treatment: "Recall cleaning", value: 220, source: "voice", owner: "Leo (AI)", daysInStage: 1 },
    ],
  },
];

export const botFlows: BotFlow[] = [
  {
    id: "f1", name: "Hygiene recall & rebooking", channel: "whatsapp", status: "Live", triggeredToday: 38, completionRate: 0.72,
    nodes: [
      { id: "n1", type: "trigger", title: "Trigger: recall due", detail: "OpenDental recall list — patient overdue ≥ 30 days" },
      { id: "n2", type: "message", title: "Send recall message", detail: "Template: “Hi {{first_name}}, you're due for your cleaning…” with 3 slot buttons" },
      { id: "n3", type: "condition", title: "Patient replied?", detail: "Wait 24h → if no reply, retry once; after 2nd silence, queue voice call by Leo" },
      { id: "n4", type: "action", title: "Book in OpenDental", detail: "Create appointment via Appointments API in chosen slot" },
      { id: "n5", type: "message", title: "Confirmation + reminder", detail: "Send instant confirmation, reminder at T-24h and T-2h" },
    ],
  },
  {
    id: "f2", name: "FAQ & office-hours autoresponder", channel: "whatsapp", status: "Live", triggeredToday: 17, completionRate: 0.91,
    nodes: [
      { id: "n6", type: "trigger", title: "Trigger: inbound message", detail: "Any WhatsApp message outside an active conversation" },
      { id: "n7", type: "condition", title: "Intent detection (AI)", detail: "Classify: hours / pricing / insurance / emergency / other" },
      { id: "n8", type: "message", title: "Answer from knowledge base", detail: "AI answer grounded in clinic info; emergencies skip straight to handoff" },
      { id: "n9", type: "handoff", title: "Human handoff", detail: "Unresolved after 2 turns → assign to Front Desk inbox with full context" },
    ],
  },
  {
    id: "f3", name: "No-show recovery", channel: "sms", status: "Paused", triggeredToday: 0, completionRate: 0.44,
    nodes: [
      { id: "n10", type: "trigger", title: "Trigger: appointment broken", detail: "OpenDental status changes to Broken" },
      { id: "n11", type: "message", title: "Empathetic rebook text", detail: "“We missed you today — want to grab a new time?” with booking link" },
      { id: "n12", type: "condition", title: "Booked within 48h?", detail: "If not, add to Pipeline → Contacted and notify Front Desk" },
    ],
  },
];

// Dashboard KPI series ------------------------------------------------------

export const weeklyConversations = [
  { day: "Mon", whatsapp: 42, sms: 28, email: 12, voice: 19 },
  { day: "Tue", whatsapp: 51, sms: 31, email: 9, voice: 24 },
  { day: "Wed", whatsapp: 47, sms: 25, email: 15, voice: 22 },
  { day: "Thu", whatsapp: 58, sms: 33, email: 11, voice: 27 },
  { day: "Fri", whatsapp: 63, sms: 36, email: 14, voice: 31 },
  { day: "Sat", whatsapp: 22, sms: 12, email: 4, voice: 9 },
  { day: "Sun", whatsapp: 8, sms: 5, email: 2, voice: 3 },
];

export const monthlyRevenue = [
  { month: "Jan", production: 86_000, fromPydental: 9_400 },
  { month: "Feb", production: 91_500, fromPydental: 14_200 },
  { month: "Mar", production: 88_200, fromPydental: 18_900 },
  { month: "Apr", production: 97_800, fromPydental: 24_600 },
  { month: "May", production: 104_300, fromPydental: 31_200 },
  { month: "Jun", production: 48_900, fromPydental: 17_800 },
];

export const todayStats = {
  conversationsHandled: 96,
  byAi: 71,
  appointmentsBooked: 14,
  noShowsSaved: 3,
  avgFirstResponseSec: 8,
  openInboxItems: 4,
};

export const channelMeta: Record<Channel, { label: string; color: string; bg: string }> = {
  whatsapp: { label: "WhatsApp", color: "#22c55e", bg: "#22c55e26" },
  instagram: { label: "Instagram", color: "#e1306c", bg: "#e1306c26" },
  messenger: { label: "Messenger", color: "#0084ff", bg: "#0084ff26" },
  sms: { label: "SMS", color: "#3b82f6", bg: "#3b82f626" },
  email: { label: "Email", color: "#a855f7", bg: "#a855f726" },
  voice: { label: "Voice", color: "#f97316", bg: "#f9731626" },
};

// Patient-profile data (our own practice-management layer — used until a
// clinic's OpenDental sync is connected, and shaped to map 1:1 onto it).

export interface TreatmentPlan {
  id: string;
  patientId: string;
  name: string;
  procedures: { code: string; description: string; tooth: string; fee: number; status: "Planned" | "Accepted" | "Completed" }[];
  presentedOn: string;
  status: "Presented" | "Accepted" | "In progress" | "Completed";
}

export interface PatientDocument {
  id: string;
  patientId: string;
  name: string;
  category: "X-ray" | "Photo (before)" | "Photo (after)" | "Consent form" | "Insurance" | "Referral" | "Other";
  uploadedAt: string;
  size: string;
}

export interface InsurancePolicy {
  id: string;
  patientId: string;
  carrier: string;
  plan: string;
  memberId: string;
  groupNumber: string;
  annualMax: number;
  usedBenefits: number;
  deductible: number;
  status: "Verified" | "Pending verification" | "Expired";
}

export interface Payment {
  id: string;
  patientId: string;
  date: string;
  amount: number;
  method: "Card (Stripe)" | "Cash" | "Bank transfer" | "Insurance" | "Financing";
  description: string;
  status: "Paid" | "Pending" | "Refunded";
}

export const treatmentPlans: TreatmentPlan[] = [
  {
    id: "tp1", patientId: "p4", name: "Implant restoration — lower right", presentedOn: "2026-04-10", status: "Presented",
    procedures: [
      { code: "D6010", description: "Implant placement", tooth: "#30", fee: 2400, status: "Planned" },
      { code: "D6058", description: "Abutment supported crown", tooth: "#30", fee: 1500, status: "Planned" },
      { code: "D7140", description: "Extraction (completed)", tooth: "#30", fee: 300, status: "Completed" },
    ],
  },
  {
    id: "tp2", patientId: "p8", name: "Crown + restorative", presentedOn: "2026-02-02", status: "Accepted",
    procedures: [
      { code: "D2740", description: "Porcelain crown", tooth: "#14", fee: 1280, status: "Accepted" },
      { code: "D2392", description: "Composite filling, 2 surfaces", tooth: "#15", fee: 370, status: "Accepted" },
    ],
  },
  {
    id: "tp3", patientId: "p3", name: "Crown seat", presentedOn: "2026-05-12", status: "In progress",
    procedures: [
      { code: "D2740", description: "Porcelain crown", tooth: "#19", fee: 1280, status: "Accepted" },
    ],
  },
];

export const patientDocuments: PatientDocument[] = [
  { id: "doc1", patientId: "p4", name: "Panoramic X-ray — Apr 2026", category: "X-ray", uploadedAt: "2026-04-10", size: "4.2 MB" },
  { id: "doc2", patientId: "p4", name: "Implant consult consent", category: "Consent form", uploadedAt: "2026-04-10", size: "180 KB" },
  { id: "doc3", patientId: "p4", name: "Site #30 — before", category: "Photo (before)", uploadedAt: "2026-04-10", size: "2.1 MB" },
  { id: "doc4", patientId: "p1", name: "Bitewings — May 2026", category: "X-ray", uploadedAt: "2026-05-28", size: "3.8 MB" },
  { id: "doc5", patientId: "p1", name: "Delta Dental card", category: "Insurance", uploadedAt: "2025-01-14", size: "640 KB" },
  { id: "doc6", patientId: "p3", name: "Crown prep — before", category: "Photo (before)", uploadedAt: "2026-05-12", size: "1.9 MB" },
  { id: "doc7", patientId: "p3", name: "Crown prep — after", category: "Photo (after)", uploadedAt: "2026-05-12", size: "2.0 MB" },
];

export const insurancePolicies: InsurancePolicy[] = [
  { id: "ins1", patientId: "p1", carrier: "Delta Dental", plan: "PPO Premier", memberId: "DD-88412-MH", groupNumber: "GRP-2210", annualMax: 2000, usedBenefits: 740, deductible: 50, status: "Verified" },
  { id: "ins2", patientId: "p3", carrier: "MetLife", plan: "Dental PPO High", memberId: "ML-55218-AW", groupNumber: "GRP-9904", annualMax: 1500, usedBenefits: 1120, deductible: 75, status: "Verified" },
  { id: "ins3", patientId: "p4", carrier: "—", plan: "Self-pay", memberId: "—", groupNumber: "—", annualMax: 0, usedBenefits: 0, deductible: 0, status: "Verified" },
  { id: "ins4", patientId: "p8", carrier: "Humana", plan: "Dental Value", memberId: "HU-30141-LM", groupNumber: "GRP-1167", annualMax: 1000, usedBenefits: 410, deductible: 50, status: "Pending verification" },
];

export const payments: Payment[] = [
  { id: "pay1", patientId: "p1", date: "2026-05-28", amount: 145, method: "Insurance", description: "Prophylaxis + exam — Delta Dental claim", status: "Paid" },
  { id: "pay2", patientId: "p1", date: "2026-05-28", amount: 35, method: "Card (Stripe)", description: "Patient portion — copay", status: "Paid" },
  { id: "pay3", patientId: "p4", date: "2026-04-10", amount: 300, method: "Card (Stripe)", description: "Extraction #30", status: "Paid" },
  { id: "pay4", patientId: "p4", date: "2026-06-01", amount: 1180, method: "Financing", description: "Implant deposit — 12-month plan", status: "Pending" },
  { id: "pay5", patientId: "p3", date: "2026-05-12", amount: 640, method: "Card (Stripe)", description: "Crown #19 — 50% at prep", status: "Paid" },
  { id: "pay6", patientId: "p8", date: "2026-02-02", amount: 200, method: "Cash", description: "Partial payment on balance", status: "Paid" },
];

// --------------------------------------------------------------- billing & claims

export interface InsuranceClaim {
  id: string;
  claimNum: number;
  patientId: string;
  patientName: string;
  carrier: string;
  dateOfService: string;
  procedures: string;
  billed: number;
  estimated: number;
  paid: number;
  status: "Unsent" | "Sent" | "Received" | "Paid" | "Denied" | "Pending";
}

export const insuranceClaims: InsuranceClaim[] = [
  { id: "cl1", claimNum: 78021, patientId: "p1", patientName: "Maria Hernandez", carrier: "Delta Dental", dateOfService: "2026-05-28", procedures: "D1110, D0120", billed: 180, estimated: 145, paid: 145, status: "Paid" },
  { id: "cl2", claimNum: 78022, patientId: "p3", patientName: "Aisha Williams", carrier: "MetLife", dateOfService: "2026-05-12", procedures: "D2740 Crown #19", billed: 1280, estimated: 640, paid: 0, status: "Sent" },
  { id: "cl3", claimNum: 78023, patientId: "p8", patientName: "Luis Mendoza", carrier: "Humana", dateOfService: "2026-02-02", procedures: "D2740, D2392", billed: 1650, estimated: 720, paid: 0, status: "Pending" },
  { id: "cl4", claimNum: 78024, patientId: "p4", patientName: "Robert Kim", carrier: "Self-pay", dateOfService: "2026-04-10", procedures: "D7140 Extraction #30", billed: 300, estimated: 0, paid: 300, status: "Paid" },
  { id: "cl5", claimNum: 78025, patientId: "p6", patientName: "Daniel Osei", carrier: "Aetna", dateOfService: "2026-06-09", procedures: "D4910 Perio maint.", billed: 165, estimated: 120, paid: 0, status: "Unsent" },
  { id: "cl6", claimNum: 78026, patientId: "p2", patientName: "James Carter", carrier: "Cigna Dental", dateOfService: "2025-12-15", procedures: "D2950 Core buildup", billed: 410, estimated: 0, paid: 0, status: "Denied" },
];

// ----------------------------------------------------------------- tooth chart

export type ToothCondition =
  | "healthy"
  | "caries"
  | "filling"
  | "crown"
  | "missing"
  | "implant"
  | "rct"
  | "watch";

export const toothConditionMeta: Record<ToothCondition, { label: string; color: string }> = {
  healthy: { label: "Healthy", color: "#cbd5e1" },
  caries: { label: "Caries / decay", color: "#ef4444" },
  filling: { label: "Filling", color: "#3b82f6" },
  crown: { label: "Crown", color: "#f59e0b" },
  missing: { label: "Missing", color: "#94a3b8" },
  implant: { label: "Implant", color: "#8b5cf6" },
  rct: { label: "Root canal", color: "#ec4899" },
  watch: { label: "Watch", color: "#10b981" },
};

// Seed conditions keyed by patient id then Universal tooth number (1–32).
export const toothConditions: Record<string, Record<number, ToothCondition>> = {
  p1: { 3: "filling", 14: "filling", 19: "watch" },
  p3: { 19: "crown", 30: "watch" },
  p4: { 30: "implant", 18: "missing", 31: "rct" },
  p8: { 14: "crown", 15: "filling", 2: "caries" },
};

// --------------------------------------------------------------------- reports

export const providerProduction = [
  { provider: "Dr. Patel", production: 42600, goal: 48000 },
  { provider: "Dr. Gomez", production: 38900, goal: 40000 },
  { provider: "Hygiene — Kelly", production: 16400, goal: 15000 },
  { provider: "Hygiene — Marcus", production: 12100, goal: 15000 },
];

export const newPatientsTrend = [
  { month: "Jan", newPatients: 28, fromAi: 9 },
  { month: "Feb", newPatients: 34, fromAi: 14 },
  { month: "Mar", newPatients: 31, fromAi: 16 },
  { month: "Apr", newPatients: 41, fromAi: 22 },
  { month: "May", newPatients: 46, fromAi: 28 },
  { month: "Jun", newPatients: 24, fromAi: 17 },
];

export const appointmentMix = [
  { name: "Completed", value: 412, color: "#22c55e" },
  { name: "Scheduled", value: 168, color: "#3b82f6" },
  { name: "Unconfirmed", value: 54, color: "#f59e0b" },
  { name: "Broken / no-show", value: 23, color: "#ef4444" },
];

export const productionByChannel = [
  { channel: "WhatsApp", value: 38400 },
  { channel: "Voice agent", value: 27600 },
  { channel: "Instagram", value: 14800 },
  { channel: "Messenger", value: 8200 },
  { channel: "Email", value: 11200 },
  { channel: "Walk-in / referral", value: 22100 },
];

export function formatMoney(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
