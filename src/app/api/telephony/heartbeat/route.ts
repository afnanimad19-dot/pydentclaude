import { NextRequest, NextResponse } from "next/server";
import { findDeviceByToken, patchDeviceConfig } from "@/lib/telephony";

// The on-prem connector calls this every few seconds (OUTBOUND from the Pi) to
// report it's alive and what state Asterisk is in. Pydent stores the last
// heartbeat on the landline profile, so the dashboard can show "Box online / ARI
// connected / Stasis registered" WITHOUT the cloud ever needing to reach into
// the clinic's private Tailscale network.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { deviceToken, ariConnected, stasisRegistered, activeCalls } = body;
  if (!deviceToken) return NextResponse.json({ ok: false, error: "deviceToken is required." }, { status: 400 });

  const device = await findDeviceByToken(String(deviceToken));
  if (!device) return NextResponse.json({ ok: false, error: "Unknown device token — re-pair the box in Pydent." }, { status: 401 });

  await patchDeviceConfig(device.id, device.config, {
    lastHeartbeat: new Date().toISOString(),
    ariConnected: !!ariConnected,
    stasisRegistered: !!stasisRegistered,
    activeCalls: Number(activeCalls) || 0,
  });

  return NextResponse.json({ ok: true, agentAssigned: !!device.agent_id, stasisApp: device.config?.stasisApp ?? "pydent-agent" });
}
