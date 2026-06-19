// Shared agent-reply generator (OpenRouter). Used by the inbox chat route and the
// WhatsApp webhook auto-responder. Supports a `book_appointment` tool so the agent
// can actually create appointments (Calendar + Open Dental) when canBook is on.

export interface AgentReplyInput {
  model?: string;
  agentName?: string;
  instructions?: string;
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
}

function buildSystem(input: AgentReplyInput): string {
  const { agentName = "Assistant", instructions = "", knowledgeBase = "", capabilities = {}, patientContext = "", sessionNote = "" } = input;
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
    instructions,
    knowledgeBase && `KNOWLEDGE BASE (answer only from this; if the answer isn't here, say you'll check with the team):\n${knowledgeBase}`,
    abilities && `You are allowed to: ${abilities}.`,
    capabilities.canBook && "When the patient has agreed on a specific date AND time, call the book_appointment tool with the service, doctor (if named) and the ISO datetime. After it succeeds, confirm warmly in one sentence. Do not claim an appointment is booked unless the tool succeeded.",
    patientContext && `PATIENT CONTEXT:\n${patientContext}`,
    sessionNote && `SESSION NOTE:\n${sessionNote}`,
    "Keep replies short (1-3 sentences), warm and professional. Never invent medical advice or diagnosis.",
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
      messages: [{ role: "system", content: buildSystem(input) }, ...input.messages.slice(-12)],
    });
    return { reply: data.choices?.[0]?.message?.content ?? "", status: 200 };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "AI request failed", status: 502 };
  }
}

const BOOK_TOOL = {
  type: "function",
  function: {
    name: "book_appointment",
    description: "Book a dental appointment once the patient has agreed on a specific date and time.",
    parameters: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service, e.g. cleaning, check-up, consultation, whitening" },
        doctor: { type: "string", description: "Doctor name if the patient specified one, otherwise empty" },
        datetime: { type: "string", description: "ISO 8601 date-time, e.g. 2026-06-22T14:00" },
      },
      required: ["service", "datetime"],
    },
  },
};

// Reply with the ability to actually book. `executeBooking` performs the booking
// (Calendar + Open Dental) and returns a short result string for the model.
export async function generateAgentReplyWithBooking(
  input: AgentReplyInput,
  executeBooking: (args: BookingArgs) => Promise<string>
): Promise<{ reply?: string; booked?: boolean; error?: string; status: number }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { error: "OPENROUTER_API_KEY is not configured on the server.", status: 503 };
  const model = input.model ?? "openai/gpt-4o-mini";
  const baseMessages = [{ role: "system", content: buildSystem(input) }, ...input.messages.slice(-12)];

  try {
    const first = await callOpenRouter(apiKey, model, { messages: baseMessages, tools: [BOOK_TOOL], tool_choice: "auto" });
    const msg = first.choices?.[0]?.message;
    const toolCalls = msg?.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      return { reply: msg?.content ?? "", booked: false, status: 200 };
    }

    // Execute each booking tool call, then ask the model to confirm.
    const toolMessages: Record<string, unknown>[] = [];
    let booked = false;
    for (const tc of toolCalls) {
      if (tc.function?.name !== "book_appointment") {
        toolMessages.push({ role: "tool", tool_call_id: tc.id, content: "Unsupported tool." });
        continue;
      }
      let result = "Booking failed.";
      try {
        const args = JSON.parse(tc.function.arguments || "{}") as BookingArgs;
        result = await executeBooking(args);
        booked = true;
      } catch (e) {
        result = `Booking failed: ${e instanceof Error ? e.message : "error"}`;
      }
      toolMessages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }

    const second = await callOpenRouter(apiKey, model, {
      messages: [...baseMessages, msg, ...toolMessages],
    });
    return { reply: second.choices?.[0]?.message?.content ?? "Your appointment is booked.", booked, status: 200 };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "AI request failed", status: 502 };
  }
}
