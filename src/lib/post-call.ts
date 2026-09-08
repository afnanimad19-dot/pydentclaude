import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { resilientChat } from "@/lib/agent-reply";
import type { ExtractionField } from "@/lib/db";

// Post-Call Data Extraction — turns a finished call's transcript into the
// structured fields an agent was configured to capture (caller name, appointment
// intent, lead quality, call summary ...). Runs AFTER the call is stored, so it
// never delays call termination, and is skipped entirely when the agent's
// privacy setting forbids analysis.

export interface ExtractionResult {
  values: Record<string, unknown>;
  error?: string;
}

function jsonTypeFor(t: string): string {
  switch (t) {
    case "number": return "a number";
    case "boolean": return "true or false";
    case "date": return "a date as YYYY-MM-DD";
    case "datetime": return "a datetime as YYYY-MM-DDTHH:MM";
    case "enum": return "one of the allowed values";
    default: return "a short string";
  }
}

/** Coerce + validate one extracted value against its configured type. */
export function coerceValue(raw: unknown, field: ExtractionField): unknown {
  if (raw === null || raw === undefined || raw === "") return null;
  const type = field.type === "string" ? "text" : field.type;
  switch (type) {
    case "number": {
      if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
      const digits = String(raw).replace(/[^0-9.-]/g, "");
      // "not stated" strips to "" and Number("") is 0 — that would invent a
      // value the caller never gave, so anything without a digit is null.
      if (!/\d/.test(digits)) return null;
      const n = Number(digits);
      return Number.isFinite(n) ? n : null;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      const s = String(raw).trim().toLowerCase();
      if (["true", "yes", "y", "1"].includes(s)) return true;
      if (["false", "no", "n", "0"].includes(s)) return false;
      return null;
    }
    case "date": {
      const m = /\d{4}-\d{2}-\d{2}/.exec(String(raw));
      return m ? m[0] : null;
    }
    case "datetime": {
      const m = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.exec(String(raw));
      return m ? m[0].replace(" ", "T") : null;
    }
    case "enum": {
      const opts = field.options ?? [];
      const s = String(raw).trim();
      if (!opts.length) return s;
      const hit = opts.find((o) => o.toLowerCase() === s.toLowerCase());
      return hit ?? null;
    }
    default:
      return String(raw).slice(0, 2000);
  }
}

/**
 * Ask the LLM to pull the configured fields out of a transcript, then validate
 * each value against its declared type. Never throws — a failed extraction
 * returns an error string and leaves the call record intact.
 */
export async function extractFromTranscript(
  transcript: string,
  fields: ExtractionField[],
  agentName: string
): Promise<ExtractionResult> {
  if (!transcript.trim() || fields.length === 0) return { values: {} };

  const spec = fields
    .map((f) => {
      const type = f.type === "string" ? "text" : f.type;
      const opts = type === "enum" && f.options?.length ? ` Allowed values: ${f.options.join(" | ")}.` : "";
      return `- "${f.name}" (${jsonTypeFor(type)}): ${f.description || "extract this from the call"}.${opts}`;
    })
    .join("\n");

  const system =
    "You extract structured data from a phone-call transcript for a dental clinic. " +
    "Return ONLY a JSON object whose keys are exactly the requested field names. " +
    "Use null for anything the transcript does not clearly state — never guess or invent. " +
    "Do not wrap the JSON in markdown.";
  const user = `Fields to extract:\n${spec}\n\nTranscript of the call handled by ${agentName}:\n${transcript.slice(0, 24000)}`;

  try {
    const res = await resilientChat(process.env.OPENROUTER_API_KEY ?? "", "openai/gpt-4o-mini", {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 800,
      temperature: 0,
    });
    const text: string =
      (res as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content ?? "";
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) return { values: {}, error: "The model did not return JSON." };
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;

    const values: Record<string, unknown> = {};
    for (const f of fields) values[f.name] = coerceValue(parsed[f.name], f);
    return { values };
  } catch (e) {
    return { values: {}, error: e instanceof Error ? e.message : "extraction failed" };
  }
}

/** Run extraction for a stored call and save the result. Best-effort. */
export async function runPostCallExtraction(opts: {
  callKey: string;
  transcript: string;
  fields: ExtractionField[];
  agentName: string;
}): Promise<void> {
  if (!opts.fields.length || !opts.transcript.trim()) return;
  const result = await extractFromTranscript(opts.transcript, opts.fields, opts.agentName);
  try {
    await supabase
      .from("voice_calls")
      .update({ extracted_data: result.error ? { _error: result.error } : result.values })
      .eq("vapi_call_id", opts.callKey);
  } catch {
    /* the call record itself is already saved — extraction is additive */
  }
}
