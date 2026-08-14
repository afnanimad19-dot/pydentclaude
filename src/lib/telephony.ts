import { supabaseAdmin as supabase } from "@/lib/supabase-admin";

// A clinic's on-prem box (Raspberry Pi + Asterisk) is paired to a landline
// profile by a per-device token generated when the profile is saved. The box's
// connector authenticates every outbound call to Pydent with that token — the
// cloud never reaches INTO the clinic network, the box always reaches OUT. This
// resolves a token to its landline row (which carries the workspace + assigned
// agent). Tokens are unique random strings, so a scan of landline rows is fine.
export interface DeviceRow {
  id: string;
  workspace_id: string;
  number: string;
  agent_id: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>;
}

export async function findDeviceByToken(token: string): Promise<DeviceRow | null> {
  if (!token) return null;
  const { data } = await supabase
    .from("voice_numbers")
    .select("id, workspace_id, number, agent_id, config")
    .eq("provider", "landline");
  const row = (data ?? []).find((r) => (r.config as { deviceToken?: string } | null)?.deviceToken === token);
  return (row as DeviceRow) ?? null;
}

// Merge a patch into a landline row's config JSON (read-modify-write, since the
// blob holds the whole profile). Best-effort — never throws into a request.
export async function patchDeviceConfig(id: string, current: Record<string, unknown>, patch: Record<string, unknown>): Promise<void> {
  try {
    await supabase.from("voice_numbers").update({ config: { ...current, ...patch } }).eq("id", id);
  } catch {
    /* heartbeat is best-effort */
  }
}
