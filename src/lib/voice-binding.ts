import { type AiAgent, type VoiceNumber } from "@/lib/db";
import { authFetch, newIdempotencyKey } from "@/lib/auth-fetch";

// Assign (or re-assign) a number to a voice agent through the guarded
// server-side transaction (/api/voice-numbers/[id]/assign): the server checks
// authorization and the workspace, updates the PROVIDER that really routes the
// number (LiveKit dispatch rule in place / Vapi), reads it back, and only then
// records the new agent. Nothing is written from the browser, and `ok` is true
// only when the server confirmed the outcome. Pass agent=undefined to unassign
// (allowed only for numbers without provider routing).
export interface BindResult {
  ok: boolean;
  message: string;
  status?: string;
  code?: string;
  assignmentId?: string;
}

export async function bindNumberToAgent(
  num: VoiceNumber,
  agent: AiAgent | undefined,
  opts: { confirmNumber?: string; idempotencyKey?: string } = {}
): Promise<BindResult> {
  try {
    const res = await authFetch(`/api/voice-numbers/${encodeURIComponent(num.id)}/assign`, {
      method: "POST",
      body: JSON.stringify({
        targetAgentId: agent?.id ?? null,
        expectedCurrentAgentId: num.agentId ?? null,
        idempotencyKey: opts.idempotencyKey ?? newIdempotencyKey("assign"),
        confirmNumber: opts.confirmNumber,
      }),
    });
    const data = await res.json().catch(() => ({}));
    return {
      ok: !!data.ok,
      message: data.message ?? data.error ?? `Request failed (${res.status}).`,
      status: data.status,
      code: data.code,
      assignmentId: data.assignmentId,
    };
  } catch {
    return { ok: false, message: "Couldn't confirm the result with Pydent — refresh to see the current routing before retrying." };
  }
}
