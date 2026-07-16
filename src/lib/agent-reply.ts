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
        "Collect the patient's first name, last name, email, the service, and a specific date AND time. Use get_available_slots first and only offer real open times. " +
        "Once you have name + email + service + a specific date and time, you MUST call book_appointment. NEVER tell the patient it is booked unless the tool returned success."
      : "You cannot book appointments yourself. If the patient wants to book, collect their preferred date/time and say the team will confirm — NEVER claim an appointment is already booked.",
    capabilities.canReschedule && "To move an existing appointment, confirm the new time then call reschedule_appointment.",
    capabilities.canCancel && "To cancel an existing appointment, confirm with the patient then call cancel_appointment.",
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

export async function generateAgentReply(input: AgentReplyInput): Promise<{ reply?: string; error?: string; status: number }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { error: "OPENROUTER_API_KEY is not configured on the server.", status: 503 };
  try {
    const data = await callOpenRouter(apiKey, input.model ?? "openai/gpt-4o-mini", {
      messages: [{ role: "system", content: buildSystem(input) }, ...input.messages.slice(-20)],
    });
    return { reply: data.choices?.[0]?.message?.content ?? "", status: 200 };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "AI request failed", status: 502 };
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
      const data = await callOpenRouter(apiKey, model, { messages, tools, tool_choice: "auto" });
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
    const final = await callOpenRouter(apiKey, model, { messages });
    return { reply: final.choices?.[0]?.message?.content ?? "", status: 200 };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "AI request failed", status: 502 };
  }
}
