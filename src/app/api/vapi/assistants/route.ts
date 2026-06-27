import { NextRequest, NextResponse } from "next/server";

// Proxies to the Vapi API (https://api.vapi.ai) using the server-side
// private key. The dashboard adjusts voice agents here; Vapi runs the calls.

const VAPI_BASE = "https://api.vapi.ai";

function vapiHeaders() {
  return {
    Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
    "Content-Type": "application/json",
  };
}

// Map Pydent voice labels onto currently-supported Vapi voices
// (verified against the live API: Leah, Elliot, Savannah, Rohan, Tara).
function voiceFor(label?: string): string {
  const map: Record<string, string> = {
    "Warm female · US English": "Leah",
    "Friendly male · US English": "Elliot",
    "Neutral female · US English": "Savannah",
    "Calm male · US English": "Rohan",
  };
  return map[label ?? ""] ?? "Leah";
}

function notConfigured() {
  return NextResponse.json(
    {
      error:
        "VAPI_API_KEY is not configured (needs the PRIVATE key from the Vapi dashboard → Organization → API Keys).",
    },
    { status: 503 }
  );
}

export async function GET() {
  if (!process.env.VAPI_API_KEY) return notConfigured();
  const res = await fetch(`${VAPI_BASE}/assistant`, { headers: vapiHeaders() });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}

const FIRST_MESSAGE_MODE: Record<string, string> = {
  assistant_first: "assistant-speaks-first",
  user_first: "assistant-waits-for-user",
  assistant_first_generated: "assistant-speaks-first-with-model-generated-message",
};

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));

// Translate Pydent's advanced voice settings (Callab-style fields) onto the
// matching Vapi assistant fields (startSpeakingPlan / stopSpeakingPlan /
// analysisPlan / artifactPlan / voicemailDetection / messagePlan). Returns a
// partial assistant to spread in. Some fine-grained Callab VAD knobs (activation
// threshold, prefix padding) have no direct Vapi equivalent — the meaningful
// ones (timeouts, turn detection, limits, privacy, extraction) are mapped here.
/* eslint-disable @typescript-eslint/no-explicit-any */
function advancedFromSettings(vs: any): Record<string, any> {
  if (!vs || typeof vs !== "object") return {};
  const out: Record<string, any> = {};

  // Call limits
  out.maxDurationSeconds = clamp((vs.maxCallDuration ?? 60) * 60, 10, 43200);
  out.silenceTimeoutSeconds = clamp(vs.maxSilenceDuration ?? 120, 5, 3600);

  // Noise reduction
  out.backgroundDenoisingEnabled = !!vs.noiseReductionEnabled;

  // Turn detection / VAD
  const turnOn = vs.turnDetectionEnabled !== false;
  out.startSpeakingPlan = {
    waitSeconds: clamp(vs.detectionTimeout ?? 2.0, 0, 5),
    ...(turnOn && vs.detectionMode !== "fixed"
      ? { smartEndpointingPlan: { provider: "livekit" } }
      : {}),
    transcriptionEndpointingPlan: {
      onPunctuationSeconds: clamp(vs.minSilenceDuration ?? 0.3, 0, 3),
      onNoPunctuationSeconds: clamp(vs.endOfSpeechTimeout ?? 0.2, 0, 4),
      onNumberSeconds: 0.5,
    },
  };
  // Min speech duration maps roughly to how much voice is needed to count as a turn.
  out.stopSpeakingPlan = {
    numWords: 0,
    voiceSeconds: clamp(vs.minSpeechDuration ?? 0.2, 0, 0.5),
    backoffSeconds: 1,
  };

  // Answering-machine detection
  if (vs.amdEnabled) {
    out.voicemailDetection = { provider: "vapi" };
  }

  // Reminder & call-duration → idle check-ins
  out.messagePlan = {
    idleMessages: ["Are you still there?"],
    idleTimeoutSeconds: clamp(vs.silenceBeforeCheck ?? 60, 5, 60),
    idleMessageMaxSpokenCount: clamp(vs.maxCheckAttempts ?? 3, 1, 10),
  };

  // Privacy / compliance — driven by the data-storage preference
  const storage = vs.dataStorage ?? "store_analyze";
  const noStore = storage === "no_store";
  const analyze = storage === "store_analyze";
  out.hipaaEnabled = noStore;
  out.artifactPlan = {
    recordingEnabled: !noStore,
    transcriptPlan: { enabled: !noStore },
  };

  // Post-call analysis (only when analytics are allowed)
  const analysisPlan: Record<string, any> = {
    summaryPlan: { enabled: analyze },
    successEvaluationPlan: { enabled: analyze },
  };
  if (analyze && Array.isArray(vs.extractionFields)) {
    const fields = vs.extractionFields.filter((f: any) => f?.name?.trim());
    if (fields.length) {
      const properties: Record<string, any> = {};
      for (const f of fields) {
        properties[f.name.trim()] = {
          type: f.type === "number" ? "number" : f.type === "boolean" ? "boolean" : "string",
          description: f.description ?? "",
        };
      }
      analysisPlan.structuredDataPlan = {
        enabled: true,
        schema: { type: "object", properties },
      };
    }
  }
  out.analysisPlan = analysisPlan;

  return out;
}
// Live-call booking tools. When the model calls one, Vapi POSTs to our server
// (the events webhook) which actually books on the Calendar + Open Dental and
// returns the result — so the agent only says "booked" after it really is.
/* eslint-disable @typescript-eslint/no-explicit-any */
function bookingTools(
  caps: { canBook?: boolean; canReschedule?: boolean; canCancel?: boolean },
  serverUrl: string
): any[] {
  const server = { url: serverUrl };
  const tools: any[] = [];
  if (caps.canBook) {
    tools.push({
      type: "function",
      server,
      function: {
        name: "get_available_slots",
        description: "Fetch real open appointment times for a treatment on a date BEFORE offering times to the caller.",
        parameters: {
          type: "object",
          properties: {
            treatment: { type: "string", description: "e.g. cleaning, check-up, consultation, whitening" },
            doctor: { type: "string", description: "Doctor name if specified, else empty" },
            date: { type: "string", description: "Date as YYYY-MM-DD" },
          },
          required: ["date"],
        },
      },
    });
    tools.push({
      type: "function",
      server,
      function: {
        name: "book_appointment",
        description:
          "Book the appointment once the caller agreed on a specific date and time. Collect and pass the patient's name, phone, email, the treatment, and the fee/price quoted. Only tell the caller it is booked AFTER this returns success.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Patient full name" },
            phone: { type: "string", description: "Patient phone number (defaults to the caller's number)" },
            email: { type: "string", description: "Patient email if given" },
            treatment: { type: "string", description: "The treatment/service booked" },
            fee: { type: "number", description: "The fee/price the patient is booking for, if mentioned (number only)" },
            doctor: { type: "string", description: "Doctor name if specified" },
            datetime: { type: "string", description: "ISO 8601 date-time, e.g. 2026-06-22T14:00" },
          },
          required: ["treatment", "datetime"],
        },
      },
    });
  }
  if (caps.canReschedule) {
    tools.push({
      type: "function",
      server,
      function: {
        name: "reschedule_appointment",
        description: "Move the caller's existing appointment to a new date and time.",
        parameters: { type: "object", properties: { datetime: { type: "string", description: "New ISO date-time" } }, required: ["datetime"] },
      },
    });
  }
  if (caps.canCancel) {
    tools.push({
      type: "function",
      server,
      function: {
        name: "cancel_appointment",
        description: "Cancel the caller's existing appointment.",
        parameters: { type: "object", properties: { reason: { type: "string" } } },
      },
    });
  }
  return tools;
}

function bookingPrompt(caps: { canBook?: boolean; canReschedule?: boolean; canCancel?: boolean }): string {
  if (!caps.canBook && !caps.canReschedule && !caps.canCancel) return "";
  return (
    "BOOKING — read carefully: You can ONLY change the schedule by calling the tools. " +
    "Saying 'booked' in words does NOT book anything. To book: first call get_available_slots to offer real open times, " +
    "then once the caller agrees on a specific date and time, collect their full name, phone number, email, the treatment they want, " +
    "and the fee/price, and call book_appointment with all of them. NEVER tell the caller the appointment is booked unless book_appointment returned success."
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function POST(req: NextRequest) {
  if (!process.env.VAPI_API_KEY) return notConfigured();
  const agent = await req.json();

  // Absolute URL Vapi calls back for status updates, end-of-call reports, and
  // tool-calls (live booking). Derived from the deployment origin.
  const origin =
    process.env.VAPI_SERVER_URL?.replace(/\/$/, "") ||
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ||
    new URL(req.url).origin;
  const serverUrl = `${origin}/api/vapi/events`;

  const caps = { canBook: agent.canBook, canReschedule: agent.canReschedule, canCancel: agent.canCancel };
  const tools = bookingTools(caps, serverUrl);

  // Map a Pydent voice agent onto a Vapi assistant definition.
  const assistant = {
    name: agent.name,
    firstMessage: agent.firstMessage || `Hi, this is ${agent.name} from the dental office. How can I help?`,
    firstMessageMode: FIRST_MESSAGE_MODE[agent.firstMessageMode] ?? "assistant-speaks-first",
    // Vapi calls this for status updates, end-of-call reports, and tool-calls.
    server: { url: serverUrl, ...(process.env.VAPI_WEBHOOK_SECRET ? { secret: process.env.VAPI_WEBHOOK_SECRET } : {}) },
    model: {
      provider: "openai",
      model: agent.model || "gpt-4o-mini",
      ...(tools.length ? { tools } : {}),
      messages: [
        {
          role: "system",
          content: [
            agent.instructions,
            agent.behavior && `BEHAVIOR RULES (how to act, what NOT to do):\n${agent.behavior}`,
            bookingPrompt(caps),
            agent.knowledgeBase && `KNOWLEDGE BASE:\n${agent.knowledgeBase}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
    },
    // Use the clinic's chosen ElevenLabs voice (premade or cloned) when set;
    // otherwise fall back to a built-in Vapi voice.
    voice: agent.voiceId
      ? { provider: "11labs", voiceId: agent.voiceId, model: "eleven_multilingual_v2" }
      : { provider: "vapi", voiceId: voiceFor(agent.voice) },
    transcriber: { provider: "deepgram", model: "nova-2", language: agent.language?.includes("Spanish") ? "multi" : "en" },
    // Advanced call-tuning (turn detection, interruptions, noise, voicemail,
    // limits, idle reminders, privacy, post-call extraction).
    ...advancedFromSettings(agent.voiceSettings),
  };

  const res = await fetch(`${VAPI_BASE}/assistant`, {
    method: "POST",
    headers: vapiHeaders(),
    body: JSON.stringify(assistant),
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
