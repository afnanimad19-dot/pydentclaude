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
  if (map[label ?? ""]) return map[label ?? ""];
  // Grok voice labels (browser calls run on xAI) → closest Vapi phone voice.
  const l = (label ?? "").toLowerCase();
  if (/rex|leo/.test(l)) return "Elliot";
  if (/sal/.test(l)) return "Rohan";
  return "Leah"; // eve / ara / default
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
      onPunctuationSeconds: clamp(vs.minSilenceDuration ?? 0.4, 0.2, 3),
      // Wait ~1s on a pause without punctuation so the agent doesn't barge in mid-sentence.
      onNoPunctuationSeconds: clamp(vs.endOfSpeechTimeout ?? 1.0, 0.5, 4),
      onNumberSeconds: 0.5,
    },
  };
  // How readily the caller can interrupt the agent. numWords:0 treats ANY audio
  // (a cough, "mm-hm", echo) as an interruption → the agent stops, restarts, and
  // ends up talking over itself. Require a couple of real words, and back off
  // longer before resuming so it doesn't immediately restart its sentence.
  out.stopSpeakingPlan = {
    numWords: clamp(vs.interruptionWords ?? 2, 0, 5),
    voiceSeconds: clamp(vs.minSpeechDuration ?? 0.2, 0.1, 0.5),
    backoffSeconds: clamp(vs.backoffSeconds ?? 1.5, 1, 3),
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
  // Vapi-managed filler so the LLM doesn't keep improvising "one moment" in a loop:
  // ONE short acknowledgement at the start, and a single delayed nudge after 8s.
  const msgs = (start: string) => [
    { type: "request-start", content: start },
    { type: "request-response-delayed", content: "Still on it — one moment.", timingMilliseconds: 8000 },
  ];
  const tools: any[] = [];
  if (caps.canBook) {
    tools.push({
      type: "function",
      server,
      messages: msgs("Let me check that for you."),
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
      messages: msgs("Booking that for you now."),
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
      messages: msgs("Let me update that appointment."),
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
      messages: msgs("One moment while I cancel that."),
      function: {
        name: "cancel_appointment",
        description: "Cancel the caller's existing appointment.",
        parameters: { type: "object", properties: { reason: { type: "string" } } },
      },
    });
  }
  // Always available: email the caller a confirmation / the details they ask for
  // during the call ("can you send that to my email?").
  tools.push({
    type: "function",
    server,
    messages: msgs("Sure, sending that to your email now."),
    function: {
      name: "send_email",
      description: "Email the caller a confirmation or the information they asked for during the call. Only use an email address the caller gave you; read it back to confirm the spelling first.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "The caller's email address (confirm the spelling by reading it back first)" },
          subject: { type: "string", description: "Short email subject line" },
          body: { type: "string", description: "The email body as friendly plain text (include booking details when confirming an appointment)" },
        },
        required: ["to", "subject", "body"],
      },
    },
  });
  return tools;
}

// Speech-to-text per language. Deepgram nova-2 covers English well and its
// "multi" mode handles es/fr/de/hi/ru/pt/ja/it/nl — but NOT Arabic (and a few
// others), which would transcribe as garbage. Those route to Azure STT, whose
// coverage includes Gulf Arabic.
function transcriberFor(language?: string, preferredModel?: string): Record<string, unknown> {
  const l = (language ?? "").toLowerCase();
  const azure = (code: string) => ({ provider: "azure", language: code });
  if (l.includes("arabic")) return azure("ar-AE");
  if (l.includes("urdu")) return azure("ur-PK");
  if (l.includes("turkish")) return azure("tr-TR");
  if (l.includes("bengali")) return azure("bn-IN");
  if (l.includes("vietnamese")) return azure("vi-VN");
  if (l.includes("indonesian")) return azure("id-ID");
  if (l.includes("korean")) return azure("ko-KR");
  if (l.includes("mandarin") || l.includes("chinese")) return azure("zh-CN");
  if (l.includes("polish")) return azure("pl-PL");
  if (l.includes("tagalog")) return azure("fil-PH");
  const multi = /spanish|french|german|hindi|russian|portuguese|japanese|italian|dutch|\+/.test(l);
  // English-only calls may use the agent's chosen Deepgram model (nova-3 is
  // English-only, so multilingual agents stay on nova-2 multi).
  if (multi) return { provider: "deepgram", model: "nova-2", language: "multi" };
  return { provider: "deepgram", model: preferredModel === "nova-3" ? "nova-3" : "nova-2", language: "en" };
}

// Hard conversation-language rule (Arabic priority: warm Gulf/UAE spoken style).
function languageLine(language?: string): string {
  const l = (language ?? "").trim();
  if (!l || /^english$/i.test(l)) return "";
  if (/\+/.test(l)) return `LANGUAGE: The clinic serves callers in ${l}. Speak whichever the caller uses; follow their language from their first words.`;
  const arabic = /arabic/i.test(l) ? " Speak natural, warm, everyday spoken Arabic (Gulf/UAE style) — keep medical terms simple and say numbers, prices and times the way people say them in Arabic." : "";
  return `LANGUAGE: Conduct the ENTIRE call in ${l} — greet, answer, collect details, read the booking summary and confirm in ${l}.${arabic} Only switch if the caller clearly speaks another language.`;
}

function bookingPrompt(caps: { canBook?: boolean; canReschedule?: boolean; canCancel?: boolean }): string {
  if (!caps.canBook && !caps.canReschedule && !caps.canCancel) return "";
  return (
    "SPEAKING STYLE: Finish your sentence before starting a new one — never speak two things at once. While a tool is running, say a brief acknowledgement like 'one moment' AT MOST ONCE, then stay quiet until the result comes back. Do NOT repeat filler phrases. " +
    "BOOKING — read carefully: You can ONLY change the schedule by calling the tools. " +
    "Saying 'booked' in words does NOT book anything. To book: first call get_available_slots to offer real open times. " +
    "Once the caller agrees on a specific date and time, collect their details ONE question at a time: full name first, then phone number (repeat it back digit-by-digit), then email (repeat it back to confirm the spelling), then the treatment and the fee/price. " +
    "Then read back ONE full summary — name, phone, email, treatment, date and time — and ask 'is everything correct?'. Only after the caller clearly confirms, call book_appointment with all of them. " +
    "If they correct something, fix it and re-confirm before booking. NEVER tell the caller the appointment is booked unless book_appointment returned success."
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

  // Call transfer to a human: when the agent can't help (or the caller asks for a
  // person), it can transfer the live call to a real number.
  const transferNumber = (agent.voiceSettings?.transferNumber || "").trim();
  if (transferNumber) {
    tools.push({
      type: "transferCall",
      destinations: [{ type: "number", number: transferNumber, message: agent.voiceSettings?.transferMessage || "One moment — connecting you to a team member now." }],
    });
  }

  // Map a Pydent voice agent onto a Vapi assistant definition.
  const assistant = {
    name: agent.name,
    firstMessage: agent.firstMessage || `Hi, this is ${agent.name} from the dental office. How can I help?`,
    firstMessageMode: FIRST_MESSAGE_MODE[agent.firstMessageMode] ?? "assistant-speaks-first",
    // Vapi calls this for status updates, end-of-call reports, and tool-calls.
    server: { url: serverUrl, ...(process.env.VAPI_WEBHOOK_SECRET ? { secret: process.env.VAPI_WEBHOOK_SECRET } : {}) },
    model: {
      provider: "openai",
      // An agent edited under the xAI engine may carry a grok-voice model —
      // Vapi's OpenAI provider can't run that, and the call silently fails to
      // answer. Map any non-OpenAI model to a safe default.
      model: /^grok/i.test(agent.model ?? "") ? "gpt-4o-mini" : agent.model || "gpt-4o-mini",
      ...(tools.length ? { tools } : {}),
      messages: [
        {
          role: "system",
          content: [
            languageLine(agent.language),
            "MULTILINGUAL: if the caller speaks another language you can understand, reply in that language — translating knowledge-base facts naturally. Never say you only speak English.",
            agent.agentIdentity && `AGENT IDENTITY (who you are, your tone and role):\n${agent.agentIdentity}`,
            agent.instructions && `TASKS (what you do — your goals and the actions to perform):\n${agent.instructions}`,
            agent.behavior && `STYLE GUARDRAILS (how you speak — phrases to use/avoid, conversational flow):\n${agent.behavior}`,
            bookingPrompt(caps),
            transferNumber && `TRANSFER: If the caller asks for a human, is upset, has a clinical emergency, or you genuinely cannot help, use the transferCall tool to connect them to ${transferNumber}. Tell them you're connecting them before transferring.`,
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
    transcriber: transcriberFor(agent.language, agent.voiceSettings?.transcriber),
    // Advanced call-tuning (turn detection, interruptions, noise, voicemail,
    // limits, idle reminders, privacy, post-call extraction).
    ...advancedFromSettings(agent.voiceSettings),
  };

  // Update the SAME Vapi assistant when we already have its id (no duplicates);
  // otherwise create it. So "save/publish in Pydent" updates Vapi in place.
  const existingId = (agent.vapiAssistantId || "").trim();
  const res = existingId
    ? await fetch(`${VAPI_BASE}/assistant/${existingId}`, { method: "PATCH", headers: vapiHeaders(), body: JSON.stringify(assistant) })
    : await fetch(`${VAPI_BASE}/assistant`, { method: "POST", headers: vapiHeaders(), body: JSON.stringify(assistant) });
  let data = await res.json();
  // If the stored id no longer exists on Vapi (404), create a fresh one.
  if (!res.ok && existingId && res.status === 404) {
    const re = await fetch(`${VAPI_BASE}/assistant`, { method: "POST", headers: vapiHeaders(), body: JSON.stringify(assistant) });
    data = await re.json();
    return NextResponse.json(data, { status: re.status });
  }
  return NextResponse.json(data, { status: res.status });
}
