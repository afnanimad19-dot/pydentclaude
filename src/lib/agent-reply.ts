// Shared agent-reply generator (OpenRouter). Used by the inbox chat route and
// the WhatsApp webhook auto-responder so both produce identical replies.

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

export async function generateAgentReply(input: AgentReplyInput): Promise<{ reply?: string; error?: string; status: number }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { error: "OPENROUTER_API_KEY is not configured on the server.", status: 503 };

  const {
    model = "openai/gpt-4o-mini",
    agentName = "Assistant",
    instructions = "",
    knowledgeBase = "",
    capabilities = {},
    patientContext = "",
    sessionNote = "",
    messages,
  } = input;

  const abilities = [
    capabilities.canBook && "book new appointments (offer concrete available slots)",
    capabilities.canReschedule && "reschedule existing appointments",
    capabilities.canCancel && "cancel appointments",
  ]
    .filter(Boolean)
    .join(", ");

  const system = [
    `You are ${agentName}, an AI assistant for a dental clinic, chatting with a patient.`,
    instructions,
    knowledgeBase && `KNOWLEDGE BASE (answer only from this; if the answer isn't here, say you'll check with the team):\n${knowledgeBase}`,
    abilities && `You are allowed to: ${abilities}.`,
    patientContext && `PATIENT CONTEXT:\n${patientContext}`,
    sessionNote && `SESSION NOTE:\n${sessionNote}`,
    "Keep replies short (1-3 sentences), warm and professional. Never invent medical advice or diagnosis.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "system", content: system }, ...messages.slice(-12)], max_tokens: 300 }),
  });

  if (!res.ok) {
    const text = await res.text();
    return { error: `OpenRouter error ${res.status}: ${text.slice(0, 200)}`, status: 502 };
  }
  const data = await res.json();
  return { reply: data.choices?.[0]?.message?.content ?? "", status: 200 };
}
