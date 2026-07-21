// xAI Grok Voice Agent API (https://docs.x.ai — Voice Agent API). Pydent's
// in-browser voice agents run on this: full-duplex speech-to-speech over
// WebSocket (wss://api.x.ai/v1/realtime), OpenAI-Realtime-compatible events,
// Grok voice models and xAI's own voices. The browser NEVER sees the API key —
// it connects with a short-lived client secret minted server-side via
// POST /v1/realtime/client_secrets and passed as the WebSocket subprotocol
// `xai-client-secret.<token>`.

export const XAI_BASE = "https://api.x.ai/v1";
export const XAI_REALTIME_URL = "wss://api.x.ai/v1/realtime";

// The full-duplex voice models. grok-voice-latest tracks the newest release
// (currently grok-voice-think-fast-1.0, reasoning on by default).
export const XAI_VOICE_MODELS = ["grok-voice-latest", "grok-voice-think-fast-1.0"];

// xAI's built-in voice roster (same ids across Voice Agent + TTS APIs).
export const XAI_VOICES: { id: string; label: string }[] = [
  { id: "eve", label: "Eve · natural female (default)" },
  { id: "ara", label: "Ara · warm friendly female" },
  { id: "rex", label: "Rex · confident clear male" },
  { id: "sal", label: "Sal · calm neutral male" },
  { id: "leo", label: "Leo · energetic male" },
];

// Accept several env names so whatever the key was saved as in Netlify works.
// (X_AI_VOICE_KEY is the name used on this deployment.)
export function xaiApiKey(): string | null {
  return (
    process.env.X_AI_VOICE_KEY ||
    process.env.XAI_API_KEY ||
    process.env.XAI_VOICE_API_KEY ||
    process.env.X_AI_API_KEY ||
    process.env.GROK_API_KEY ||
    process.env.XAI_KEY ||
    null
  );
}

// Map whatever is stored in agent.voice (a legacy label like "Warm female ·
// US English", a Grok label like "Ara · warm friendly female", a custom-voice
// label like "Clinic Voice · custom (voice_ab12cd)", or a bare id) onto an xAI
// voice id.
export function resolveXaiVoice(label: string | null | undefined): string {
  const raw = label ?? "";
  // Custom voices embed their raw id in trailing parentheses (see /api/xai/voices).
  const custom = /\(([A-Za-z0-9_-]{2,64})\)\s*$/.exec(raw);
  if (custom) return custom[1];
  const l = raw.toLowerCase();
  for (const v of XAI_VOICES) if (l.includes(v.id)) return v.id;
  if (/female|woman/.test(l)) return "ara";
  if (/male|man/.test(l)) return "rex";
  return "eve";
}

// Mint a short-lived client secret the browser can open the realtime WebSocket
// with. Response shapes vary slightly across API versions — parse tolerantly.
export async function createXaiClientSecret(): Promise<{ ok: boolean; token?: string; error?: string }> {
  const key = xaiApiKey();
  if (!key) {
    return { ok: false, error: "xAI voice isn't configured — add your xAI API key as XAI_API_KEY in Netlify (Site settings → Environment variables) and redeploy." };
  }
  try {
    const res = await fetch(`${XAI_BASE}/realtime/client_secrets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expires_after: { seconds: 600 } }),
      signal: AbortSignal.timeout(15000),
    });
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data?.error?.message ?? data?.error ?? data?.message ?? `HTTP ${res.status}`;
      return { ok: false, error: `xAI rejected the request: ${String(detail).slice(0, 200)}${res.status === 401 ? " — the API key in Netlify looks invalid." : ""}` };
    }
    const token =
      data?.client_secret?.value ??
      (typeof data?.client_secret === "string" ? data.client_secret : null) ??
      data?.value ??
      data?.token ??
      data?.secret ??
      null;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    if (!token) return { ok: false, error: "xAI returned no client secret (unexpected response shape)." };
    return { ok: true, token: String(token) };
  } catch (e) {
    return { ok: false, error: `Could not reach xAI: ${e instanceof Error ? e.message : "network error"}` };
  }
}

interface VoiceAgentRow {
  name?: string;
  agent_identity?: string;
  instructions?: string;
  behavior?: string;
  knowledge_base?: string;
  can_book?: boolean;
  can_reschedule?: boolean;
  can_cancel?: boolean;
  first_message?: string;
  first_message_mode?: string;
  voice?: string;
  model?: string;
}

// The system prompt for a live voice session — same structure the Vapi mapping
// used (identity / tasks / style / knowledge base), plus the tool contract with
// the ask-one-at-a-time → summary → confirm → book flow.
export function buildXaiInstructions(agent: VoiceAgentRow): string {
  const caps = { canBook: !!agent.can_book, canReschedule: !!agent.can_reschedule, canCancel: !!agent.can_cancel };
  const booking =
    caps.canBook || caps.canReschedule || caps.canCancel
      ? "BOOKING — read carefully: You can ONLY change the schedule by calling the tools. Saying 'booked' out loud does NOT book anything. " +
        "To book: first call get_available_slots and only offer real open times. Once the caller agrees on a date and time, collect their details ONE question at a time: full name first, then phone number (repeat it back digit-by-digit), then email (repeat it back to confirm the spelling). " +
        "Then read back ONE full summary — name, phone, email, treatment, date and time — and ask 'is everything correct?'. Only after a clear yes, call book_appointment. If they correct something, fix it and re-confirm. NEVER say it is booked unless the tool returned success. " +
        "EMAIL: when the caller asks for the details or confirmation by email, confirm their address out loud and call send_email — only to an address they gave you."
      : "";
  return [
    `You are ${agent.name ?? "the assistant"}, a voice AI for a dental clinic, on a live phone-quality call. Today is ${new Date().toISOString().slice(0, 10)}.`,
    agent.agent_identity && `AGENT IDENTITY (who you are, your tone and role):\n${agent.agent_identity}`,
    agent.instructions && `TASKS (what you do — your goals and the actions to perform):\n${agent.instructions}`,
    agent.behavior && `STYLE GUARDRAILS (how you speak — phrases to use/avoid, conversational flow):\n${agent.behavior}`,
    agent.knowledge_base && `KNOWLEDGE BASE (answer ONLY from this — the clinic's real doctors, services, prices, hours. If it isn't here, say you'll check with the team):\n${agent.knowledge_base}`,
    booking,
    "Speak naturally and keep each turn short — one or two sentences — so the caller can jump in. Never read out symbols, markdown or URLs; say them like a human would. Never invent medical advice.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ------------------------------------------------------- xAI console agents
// xAI's Agents API keeps PERSISTENT voice agents (visible in the console under
// Voice → Agents, usable for phone deployment there). We mirror every Pydent
// voice agent into it on save — like the Vapi sync — so the clinic can see and
// deploy the same agent in the xAI console. The API is in beta and its exact
// shapes shift, so every call is defensive: update falls back through
// PATCH → PUT → recreate, and create retries without tools if the schema
// rejects them. Documented updatable fields: name, instructions, tools, voice.

/* eslint-disable @typescript-eslint/no-explicit-any */
async function xaiAgentsFetch(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const key = xaiApiKey();
  if (!key) return { status: 503, data: { error: "xAI isn't configured (X_AI_VOICE_KEY missing)." } };
  const res = await fetch(`${XAI_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function xaiAgentIdFrom(data: any): string | null {
  const id = data?.id ?? data?.agent_id ?? data?.agent?.id ?? data?.data?.id ?? null;
  return id ? String(id) : null;
}

// Build the console agent payload. The welcome message is folded into the
// instructions too (the beta API's greeting field name isn't stable), so the
// agent opens correctly however it's deployed.
function xaiAgentPayload(agent: VoiceAgentRow): Record<string, unknown> {
  const greetFirst = (agent.first_message_mode ?? "assistant_first") !== "user_first";
  const welcome = greetFirst && agent.first_message ? `\n\nWELCOME MESSAGE — open every conversation with exactly: "${agent.first_message}"` : "";
  return {
    name: agent.name || "Pydent voice agent",
    instructions: buildXaiInstructions(agent) + welcome,
    voice: resolveXaiVoice(agent.voice),
    tools: xaiAgentTools(agent),
  };
}

// Create or update the mirrored console agent. Returns the (possibly new) xAI
// agent id. Never throws — callers surface the error text.
export async function syncXaiAgent(agent: VoiceAgentRow, existingId?: string | null): Promise<{ ok: boolean; id?: string; error?: string }> {
  const payload = xaiAgentPayload(agent);
  try {
    if (existingId) {
      for (const method of ["PATCH", "PUT"]) {
        const r = await xaiAgentsFetch(method, `/agents/${encodeURIComponent(existingId)}`, payload);
        if (r.status >= 200 && r.status < 300) return { ok: true, id: xaiAgentIdFrom(r.data) ?? existingId };
        if (r.status === 404) break; // deleted in the console → recreate below
        if (r.status !== 405 && r.status !== 501) {
          // Schema complaint? Retry this method without tools before moving on.
          const retry = await xaiAgentsFetch(method, `/agents/${encodeURIComponent(existingId)}`, { ...payload, tools: undefined });
          if (retry.status >= 200 && retry.status < 300) return { ok: true, id: xaiAgentIdFrom(retry.data) ?? existingId };
        }
      }
    }
    let r = await xaiAgentsFetch("POST", "/agents", payload);
    if (r.status === 400) r = await xaiAgentsFetch("POST", "/agents", { ...payload, tools: undefined });
    if (r.status >= 200 && r.status < 300) {
      const id = xaiAgentIdFrom(r.data);
      return id ? { ok: true, id } : { ok: true };
    }
    const detail = r.data?.error?.message ?? r.data?.error ?? r.data?.message ?? `HTTP ${r.status}`;
    return { ok: false, error: String(detail).slice(0, 250) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not reach xAI." };
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// Realtime function tools (flat OpenAI-Realtime schema: name/description/parameters
// at the top level). The browser executes each call via POST /api/agents/tool-exec.
/* eslint-disable @typescript-eslint/no-explicit-any */
export function xaiAgentTools(agent: VoiceAgentRow): any[] {
  const tools: any[] = [];
  if (agent.can_book) {
    tools.push({
      type: "function",
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
    });
    tools.push({
      type: "function",
      name: "book_appointment",
      description: "Book the appointment AFTER the caller confirmed the summary of their details. Pass the patient's name, phone, email, the treatment, the fee if quoted, and the ISO date-time.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Patient full name" },
          phone: { type: "string", description: "Patient phone number" },
          email: { type: "string", description: "Patient email if given" },
          treatment: { type: "string", description: "The treatment/service booked" },
          fee: { type: "number", description: "Fee/price if mentioned (number only)" },
          doctor: { type: "string", description: "Doctor name if specified" },
          datetime: { type: "string", description: "ISO 8601 date-time, e.g. 2026-07-22T14:00" },
        },
        required: ["treatment", "datetime"],
      },
    });
  }
  if (agent.can_reschedule) {
    tools.push({
      type: "function",
      name: "reschedule_appointment",
      description: "Move the caller's existing appointment to a new date and time.",
      parameters: { type: "object", properties: { datetime: { type: "string", description: "New ISO date-time" } }, required: ["datetime"] },
    });
  }
  if (agent.can_cancel) {
    tools.push({
      type: "function",
      name: "cancel_appointment",
      description: "Cancel the caller's existing appointment.",
      parameters: { type: "object", properties: { reason: { type: "string" } } },
    });
  }
  tools.push({
    type: "function",
    name: "send_email",
    description: "Email the caller a confirmation or the information they asked for. Only use an email address the caller gave you; confirm the spelling out loud first.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "The caller's email address" },
        subject: { type: "string", description: "Short subject line" },
        body: { type: "string", description: "Friendly plain-text body (include booking details when confirming)" },
      },
      required: ["to", "subject", "body"],
    },
  });
  return tools;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
