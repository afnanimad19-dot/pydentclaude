// Worker transcript → stored messages (Stage C2) — pure mapping.
//
// The worker sends [{role, text, secondsFromStart?}]. secondsFromStart is the
// message's REAL offset from call start (computed by the worker from each
// chat item's created_at). It is stored only when genuinely present and
// valid — the previous behavior of substituting the array index fabricated
// timestamps, so a missing offset now stays null and the UI simply shows the
// bubble without a clock. Historical rows keep whatever they stored.

export interface StoredCallMessage {
  role: "bot" | "user";
  message: string;
  secondsFromStart: number | null;
}

export function workerMessagesToRows(messages: unknown): StoredCallMessage[] {
  if (!Array.isArray(messages)) return [];
  const rows: StoredCallMessage[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const r = m as { role?: unknown; text?: unknown; content?: unknown; secondsFromStart?: unknown };
    const raw = r.secondsFromStart;
    const secs = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
    rows.push({
      role: r.role === "assistant" ? "bot" : "user",
      message: String(r.text ?? r.content ?? ""),
      secondsFromStart: secs,
    });
  }
  return rows;
}
