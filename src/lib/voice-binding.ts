import { updateVoiceNumber, type AiAgent, type VoiceNumber } from "@/lib/db";

// Assign (or re-assign) an existing connected number to a voice agent. Persists
// the link in our DB and re-routes inbound calls on Vapi so the agent actually
// answers. Used by the Voice Agent Settings page and the Phone Numbers card.
// Pass agent=undefined to unassign.
export async function bindNumberToAgent(num: VoiceNumber, agent: AiAgent | undefined): Promise<{ ok: boolean; message: string }> {
  if (!agent) {
    await updateVoiceNumber(num.id, { agentId: null });
    return { ok: true, message: "Number unassigned." };
  }
  // Persist the link first so the UI reflects it even if Vapi is unreachable.
  await updateVoiceNumber(num.id, { agentId: agent.id });
  if (!agent.vapiAssistantId) {
    return { ok: true, message: `Assigned. Open "${agent.name}" and Save once so it syncs to Vapi, then re-assign here to connect inbound calls.` };
  }
  try {
    const res = await fetch("/api/vapi/phone-numbers", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vapiPhoneNumberId: num.vapiPhoneNumberId,
        provider: num.provider,
        number: num.number,
        nickname: num.nickname,
        assistantId: agent.vapiAssistantId,
        config: num.config,
      }),
    });
    const data = await res.json();
    if (data.ok && data.vapiPhoneNumberId && data.vapiPhoneNumberId !== num.vapiPhoneNumberId) {
      await updateVoiceNumber(num.id, { vapiPhoneNumberId: data.vapiPhoneNumberId });
    }
    return data.ok ? { ok: true, message: data.message } : { ok: false, message: `Assigned here. Vapi: ${data.error}` };
  } catch {
    return { ok: false, message: "Assigned here, but couldn't reach Vapi to route inbound calls." };
  }
}
