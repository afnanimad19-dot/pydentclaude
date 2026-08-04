// Shared agent-reply generator (OpenRouter). Used by the inbox chat route and the
// WhatsApp webhook auto-responder. Supports a `book_appointment` tool so the agent
// can actually create appointments (Calendar + Open Dental) when canBook is on.

export interface AgentReplyInput {
  model?: string;
  agentName?: string;
  agentIdentity?: string;
  instructions?: string;
  behavior?: string;
  knowledgeBase?: string;
  language?: string; // the agent's configured language, e.g. "Arabic"
  capabilities?: { canBook?: boolean; canReschedule?: boolean; canCancel?: boolean };
  patientContext?: string;
  sessionNote?: string;
  messages: { role: "user" | "assistant"; content: string }[];
}

export interface BookingArgs {
  service: string;
  doctor?: string;
  datetime: string; // ISO 8601, e.g. 2026-06-22T14:00
  firstName?: string;
  lastName?: string;
  email?: string;
}

// The agent's configured language becomes a hard conversation-language rule.
// Arabic is the priority case: reply in natural, warm spoken Arabic throughout.
export function languageRule(language?: string): string {
  const l = (language ?? "").trim();
  if (!l || /^english$/i.test(l)) return "";
  if (/\+/.test(l)) return `LANGUAGE: The clinic serves patients in ${l}. Reply in the language the patient uses; greet in the language they wrote/spoke first.`;
  const arabic = /arabic/i.test(l) ? " Use natural, warm, everyday spoken Arabic (Gulf/UAE style is ideal); keep medical terms simple, and write numbers/times clearly." : "";
  return `LANGUAGE: Conduct the ENTIRE conversation in ${l} — greet, answer, ask questions and confirm bookings in ${l}.${arabic} Only switch language if the patient clearly uses a different one; then follow the patient.`;
}

// A returning patient (existing conversation gone quiet, or one who already has
// an appointment on file) should be GREETED with clear choices — not dropped
// back into the middle of the old chat, and not made to repeat details the
// clinic already has. Shared by every chat agent (WhatsApp, SMS, inbox) so the
// behaviour is identical everywhere. `appt` is their next upcoming appointment,
// if any; `known` lists contact details already on file so the agent reuses
// them instead of re-asking.
export function returningGreetingNote(opts: {
  name?: string;
  appt?: { procedure?: string; date?: string; time?: string; provider?: string } | null;
  known?: { phone?: string; email?: string };
}): string {
  const first = (opts.name ?? "").trim().split(/\s+/)[0] || "";
  const a = opts.appt;
  const apptLine = a?.date
    ? `They ALREADY have an appointment booked: ${a.procedure || "an appointment"}${a.provider ? ` with ${a.provider}` : ""} on ${a.date}${a.time ? ` at ${a.time}` : ""}. `
    : "";
  const knownBits = [opts.known?.phone && "phone number", opts.known?.email && "email"].filter(Boolean).join(" and ");
  const knownLine = knownBits ? `You already have their ${knownBits} on file — do NOT ask for those again; only ask for what's genuinely missing. ` : "";
  return (
    `FOR THIS REPLY ONLY (this overrides other instructions for this one message): this is a RETURNING patient. ` +
    `Do NOT silently resume the middle of the old conversation and do NOT restart a booking that is already done. ` +
    `Greet them warmly${first ? ` by name (${first})` : ""} and say it's good to hear from them again. ` +
    apptLine +
    `Then ask how you can help and offer exactly these choices, asking them to reply with the number:\n` +
    (apptLine
      ? `1) Reschedule or cancel that appointment, 2) Book a different/new appointment, 3) Ask a question (a doctor, a service, hours or prices). `
      : `1) Continue where we left off, 2) Book a new appointment, 3) Ask a question (a doctor, a service, hours or prices). `) +
    knownLine +
    `If they choose to book, ask only for the details you don't already have, one question at a time, then send ONE summary of everything for them to review and confirm before you book. Keep it short and friendly.`
  );
}

function buildSystem(input: AgentReplyInput): string {
  const { agentName = "Assistant", agentIdentity = "", instructions = "", behavior = "", knowledgeBase = "", capabilities = {}, patientContext = "", sessionNote = "" } = input;
  const abilities = [
    capabilities.canBook && "book new appointments",
    capabilities.canReschedule && "reschedule existing appointments",
    capabilities.canCancel && "cancel appointments",
  ]
    .filter(Boolean)
    .join(", ");

  return [
    `You are ${agentName}, an AI assistant for a dental clinic, chatting with a patient.`,
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    languageRule(input.language),
    "MULTILINGUAL — any patient, any language: if the patient writes in a different language than your current one (Arabic, Spanish, French, Hindi, Urdu, Russian ...), switch and reply in the patient's language from then on — including the booking questions, the summary and the confirmation. The knowledge base may be written in English: translate its facts naturally into the patient's language. Never say you only support English.",
    agentIdentity && `AGENT IDENTITY (who you are, your tone and role):\n${agentIdentity}`,
    instructions && `TASKS (what you do — your goals and the actions to perform):\n${instructions}`,
    behavior && `STYLE GUARDRAILS (how you speak — phrases to use/avoid, conversational flow):\n${behavior}`,
    // Send the knowledge base to the model. gpt-4o-mini has a 128k context, so a
    // generous cap (~48k chars ≈ 12k tokens) keeps a clinic's full KB — uploaded
    // doctor lists, price sheets, service docs — in scope rather than truncated
    // away (a small doc added after a big website import used to fall past 12k).
    knowledgeBase && `KNOWLEDGE BASE (answer ONLY from this; it contains the clinic's real facts — doctors, services, prices, hours. Read all of it. If the answer genuinely isn't here, say you'll check with the team):\n${knowledgeBase.slice(0, 48000)}`,
    abilities && `You are allowed to: ${abilities}.`,
    capabilities.canBook
      ? "BOOKING — read carefully: You can ONLY book by calling the book_appointment tool. Saying 'booked' in words does NOT book anything. " +
        "Use get_available_slots first and only offer real open times. Collect the patient's details ONE question at a time, each in its own message: first their full name, then their email, then their phone number — never all in one message. " +
        "When you have everything, send ONE summary message for review, e.g.: 'Here's a summary of the information you provided — Name: …, Email: …, Phone: …, Service: …, Date & time: …. Is everything correct?' and WAIT for their answer. " +
        "Only AFTER the patient confirms the summary is correct, you MUST call book_appointment. If they correct something, update it and re-confirm before booking. NEVER tell the patient it is booked unless the tool returned success."
      : "You cannot book appointments yourself. If the patient wants to book, collect their preferred date/time and say the team will confirm — NEVER claim an appointment is already booked.",
    capabilities.canReschedule && "To move an existing appointment, confirm the new time then call reschedule_appointment.",
    capabilities.canCancel && "To cancel an existing appointment, confirm with the patient then call cancel_appointment.",
    "EMAIL — you can email the patient when they ask (e.g. 'can you send me this in an email', 'email me the confirmation/details'). Call the send_email tool with `to` = the email address the patient gave you, a short `subject`, and a `body` written as a friendly plain-text message (for a booking, include the service, date, time, doctor if known, and the clinic name). NEVER invent an email address — only send to one the patient actually provided. After a booking, if the patient asked for it in writing, proactively offer to email the confirmation. Saying 'I've emailed you' does NOT send anything — you must call send_email.",
    patientContext && `PATIENT CONTEXT:\n${patientContext}`,
    sessionNote && `SESSION NOTE:\n${sessionNote}`,
    "Keep replies short (1-3 sentences), warm and professional. Never invent medical advice or diagnosis.",
    "CRITICAL — use the conversation above as your memory:\n" +
      "• Do NOT repeat a message you already sent, and do NOT re-list information (like a list of doctors or services) you already gave — answer the patient's LATEST message directly.\n" +
      "• Never make up facts, doctor names, counts, prices, hours or availability. Use only the knowledge base; if something isn't there, say you'll check with the team.\n" +
      "• Move the conversation forward one step at a time; ask only one question at a time and remember what the patient already told you.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function callOpenRouter(apiKey: string, model: string, body: Record<string, unknown>) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 320, ...body }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Fallback LLM: xAI's Grok chat API (OpenAI-compatible, function calling
// included). Uses the same funded X_AI_VOICE_KEY as the voice agents, so when
// OpenRouter can't run a request — the free tier's "Prompt tokens limit
// exceeded" cap, or an empty balance — replies keep flowing instead of the
// patient's "hi" dying with a 402.
const XAI_CHAT_MODELS = ["grok-4-fast-non-reasoning", "grok-3-mini", "grok-3"];

function xaiKey(): string | null {
  return (
    process.env.X_AI_VOICE_KEY || process.env.XAI_API_KEY || process.env.XAI_VOICE_API_KEY ||
    process.env.X_AI_API_KEY || process.env.GROK_API_KEY || process.env.XAI_KEY || null
  );
}

async function callXaiChat(body: Record<string, unknown>) {
  const key = xaiKey();
  if (!key) throw new Error("xAI fallback unavailable (no key)");
  let lastErr = "";
  for (const model of XAI_CHAT_MODELS) {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ max_tokens: 320, ...body, model }),
    });
    if (res.ok) return res.json();
    lastErr = `${res.status}: ${(await res.text()).slice(0, 150)}`;
    if (res.status !== 404 && res.status !== 400) break; // only ladder on unknown-model errors
  }
  throw new Error(`xAI fallback failed (${lastErr})`);
}

// OpenRouter first (the agent's configured model), Grok as automatic fallback
// when OpenRouter refuses for credit/size reasons.
async function resilientChat(apiKey: string, model: string, body: Record<string, unknown>) {
  try {
    return await callOpenRouter(apiKey, model, body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (/402|credit|tokens limit|Prompt tokens|payment/i.test(msg)) {
      return await callXaiChat(body);
    }
    throw e;
  }
}

export async function generateAgentReply(input: AgentReplyInput): Promise<{ reply?: string; error?: string; status: number }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { error: "OPENROUTER_API_KEY is not configured on the server.", status: 503 };
  try {
    const data = await resilientChat(apiKey, input.model ?? "openai/gpt-4o-mini", {
      messages: [{ role: "system", content: buildSystem(input) }, ...input.messages.slice(-20)],
    });
    return { reply: data.choices?.[0]?.message?.content ?? "", status: 200 };
  } catch (e) {
    // Last resort: shrink the knowledge base so the prompt fits whatever
    // OpenRouter's remaining allowance is, and try once more.
    try {
      const slim = { ...input, knowledgeBase: (input.knowledgeBase ?? "").slice(0, 6000) };
      const data = await callOpenRouter(apiKey, input.model ?? "openai/gpt-4o-mini", {
        messages: [{ role: "system", content: buildSystem(slim) }, ...input.messages.slice(-12)],
      });
      return { reply: data.choices?.[0]?.message?.content ?? "", status: 200 };
    } catch {
      return { error: e instanceof Error ? e.message : "AI request failed", status: 502 };
    }
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toolsFor(caps: { canBook?: boolean; canReschedule?: boolean; canCancel?: boolean }): any[] {
  const tools: any[] = [];
  if (caps.canBook) {
    tools.push({
      type: "function",
      function: {
        name: "get_available_slots",
        description: "Fetch real open appointment times for a service/doctor on a date BEFORE offering times to the patient.",
        parameters: {
          type: "object",
          properties: {
            service: { type: "string", description: "e.g. cleaning, check-up, consultation, whitening" },
            doctor: { type: "string", description: "Doctor name if specified, else empty" },
            date: { type: "string", description: "Date as YYYY-MM-DD" },
          },
          required: ["service", "date"],
        },
      },
    });
    tools.push({
      type: "function",
      function: {
        name: "book_appointment",
        description: "Book a dental appointment once the patient has agreed on a specific date and time. Collect the patient's name, phone, email, the treatment they want, and the fee/price quoted so the booking is complete.",
        parameters: {
          type: "object",
          properties: {
            firstName: { type: "string", description: "Patient first name" },
            lastName: { type: "string", description: "Patient last name" },
            email: { type: "string", description: "Patient email if given" },
            phone: { type: "string", description: "Patient phone number if given" },
            service: { type: "string", description: "The treatment/service booked, e.g. cleaning, whitening, implant consult" },
            fee: { type: "number", description: "The fee/price the patient is booking for, if mentioned (number only)" },
            doctor: { type: "string" },
            datetime: { type: "string", description: "ISO 8601 date-time, e.g. 2026-06-22T14:00" },
          },
          required: ["service", "datetime"],
        },
      },
    });
  }
  if (caps.canReschedule) {
    tools.push({
      type: "function",
      function: {
        name: "reschedule_appointment",
        description: "Move the patient's existing appointment to a new date and time.",
        parameters: { type: "object", properties: { datetime: { type: "string", description: "New ISO date-time" } }, required: ["datetime"] },
      },
    });
  }
  if (caps.canCancel) {
    tools.push({
      type: "function",
      function: {
        name: "cancel_appointment",
        description: "Cancel the patient's existing appointment.",
        parameters: { type: "object", properties: { reason: { type: "string" } } },
      },
    });
  }
  // Always available alongside the booking tools: email the patient a
  // confirmation / summary when they ask for it in writing.
  tools.push({
    type: "function",
    function: {
      name: "send_email",
      description: "Email the patient a confirmation or the information they asked for (e.g. after booking, or when they say 'send me this in an email'). Only use an email address the patient actually gave you.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "The patient's email address (must be one they provided)" },
          subject: { type: "string", description: "Short email subject line" },
          body: { type: "string", description: "The email body as friendly plain text (include booking details when confirming an appointment)" },
        },
        required: ["to", "subject", "body"],
      },
    },
  });
  return tools;
}

// Reply with tool-use (slots / book / reschedule / cancel). `executeTool` runs the
// action against the Calendar + Open Dental and returns a short result string.
export async function generateAgentReplyWithTools(
  input: AgentReplyInput,
  executeTool: (name: string, args: any) => Promise<string>
): Promise<{ reply?: string; error?: string; status: number }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { error: "OPENROUTER_API_KEY is not configured on the server.", status: 503 };
  const model = input.model ?? "openai/gpt-4o-mini";
  const tools = toolsFor(input.capabilities ?? {});
  if (tools.length === 0) return generateAgentReply(input);

  const messages: any[] = [{ role: "system", content: buildSystem(input) }, ...input.messages.slice(-20)];
  try {
    for (let round = 0; round < 4; round++) {
      const data = await resilientChat(apiKey, model, { messages, tools, tool_choice: "auto" });
      const msg = data.choices?.[0]?.message;
      if (!msg?.tool_calls?.length) return { reply: msg?.content ?? "", status: 200 };
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        let result: string;
        try {
          result = await executeTool(tc.function?.name, JSON.parse(tc.function?.arguments || "{}"));
        } catch (e) {
          result = `Error: ${e instanceof Error ? e.message : "failed"}`;
        }
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
    }
    const final = await resilientChat(apiKey, model, { messages });
    return { reply: final.choices?.[0]?.message?.content ?? "", status: 200 };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "AI request failed", status: 502 };
  }
}
