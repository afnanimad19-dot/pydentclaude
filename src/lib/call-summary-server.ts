import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { resilientChat } from "@/lib/agent-reply";
import {
  runCallSummary,
  transcriptOf,
  SUMMARY_AI_KEY,
  type ChatMessage,
  type SummaryStore,
  type SummaryRunOutcome,
} from "@/lib/call-summary";

// Real bindings for the AI Call Summary pipeline (call-summary.ts is pure).
// Same model/provider chain as post-call extraction. All writes here touch
// ONLY voice_calls.summary and the summary_ai key inside structured_data.

async function summaryChat(messages: ChatMessage[]): Promise<string> {
  const res = await resilientChat(process.env.OPENROUTER_API_KEY ?? "", "openai/gpt-4o-mini", {
    messages,
    max_tokens: 400,
    temperature: 0,
  });
  return (res as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content ?? "";
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function sdOf(row: any): Record<string, unknown> {
  return row?.structured_data && typeof row.structured_data === "object" ? row.structured_data : {};
}

/** Store bound to one voice_calls row. Status writes read-merge-write the
 *  summary_ai key so tool results / extraction data are never clobbered, and
 *  the summary write is guarded at the DB (fills only an empty summary). */
function storeForRow(id: string): SummaryStore {
  const mergeStatus = async (state: Record<string, unknown>) => {
    try {
      const { data } = await supabase.from("voice_calls").select("structured_data").eq("id", id).maybeSingle();
      await supabase
        .from("voice_calls")
        .update({ structured_data: { ...sdOf(data), [SUMMARY_AI_KEY]: state } })
        .eq("id", id);
    } catch {
      /* status is auxiliary — on legacy DBs without structured_data it is skipped */
    }
  };
  return {
    markProcessing: (at) => mergeStatus({ status: "processing", at }),
    markFailed: (error, at) => mergeStatus({ status: "failed", error, at }),
    async saveSummary(summary, at) {
      const { data: row } = await supabase.from("voice_calls").select("summary, structured_data").eq("id", id).maybeSingle();
      if (String(row?.summary ?? "").trim()) return false; // someone else landed one — preserve it
      const guarded = () =>
        supabase.from("voice_calls").update({
          summary,
          structured_data: { ...sdOf(row), [SUMMARY_AI_KEY]: { status: "available", at } },
        })
        .eq("id", id)
        .or('summary.is.null,summary.eq.""')
        .select("id");
      let { data, error } = await guarded();
      if (error && /structured_data/.test(error.message)) {
        // Legacy DB without structured_data: write the summary alone, still guarded.
        ({ data, error } = await supabase.from("voice_calls").update({ summary }).eq("id", id).or('summary.is.null,summary.eq.""').select("id"));
      }
      if (error) throw new Error(error.message);
      return (data?.length ?? 0) > 0;
    },
  };
}

export interface SummaryRow {
  id: string;
  summary?: unknown;
  transcript?: unknown;
  messages?: unknown;
  structured_data?: unknown;
  agent_name?: unknown;
}

/** Generate + persist the AI summary for a stored call row. Never throws. */
export async function runCallSummaryForRow(row: SummaryRow, opts?: { deadlineMs?: number }): Promise<SummaryRunOutcome> {
  try {
    const structuredData = sdOf(row);
    const agentName = String(row.agent_name ?? "");
    return await runCallSummary(
      { chat: summaryChat, store: storeForRow(row.id) },
      {
        summary: String(row.summary ?? ""),
        transcript: transcriptOf(row.transcript, row.messages, agentName),
        structuredData,
        agentName,
        privacy: typeof structuredData.privacy === "string" ? structuredData.privacy : "",
        deadlineMs: opts?.deadlineMs,
      }
    );
  } catch (e) {
    return { status: "failed", reason: e instanceof Error ? e.message : "Summary generation failed." };
  }
}
