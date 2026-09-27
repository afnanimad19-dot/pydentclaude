import {
  AgentDispatchClient,
  AzureBlobUpload,
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
} from "livekit-server-sdk";
import {
  BlobSASPermissions,
  SASProtocol,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from "@azure/storage-blob";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { lkHttpUrl, roomService, type LivekitCreds } from "@/lib/livekit";
import { recordingEnvFrom, recordingObjectPath, type RecordingEnv } from "@/lib/call-recording";

// Server bindings for Stage C2 call recording. Everything here runs with
// server-held secrets only:
//  - the Azure account key goes into the egress request (server → LiveKit)
//    and into short-lived blob-scoped read SAS tokens — never into join
//    tokens, client code or logs;
//  - voice_calls writes touch ONLY the recording_* columns (Stage B rule).

export function recordingEnv(): RecordingEnv | null {
  return recordingEnvFrom(process.env as Record<string, string | undefined>);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function writeRecordingRow(roomKey: string, ws: string, fields: Record<string, any>): Promise<void> {
  try {
    const { data: existing } = await supabase.from("voice_calls").select("id").eq("vapi_call_id", roomKey).limit(1).maybeSingle();
    const { error } = existing
      ? await supabase.from("voice_calls").update(fields).eq("id", existing.id)
      : await supabase.from("voice_calls").insert({ vapi_call_id: roomKey, workspace_id: ws, ...fields });
    if (error) console.warn(`[recording] row write failed room=${roomKey.slice(0, 40)}: ${error.message}`);
  } catch (e) {
    console.warn(`[recording] row write failed: ${e instanceof Error ? e.message : "error"}`);
  }
}

export interface StartRecordingResult {
  /** Room + agent dispatch were created explicitly (token join is enough). */
  prepared: boolean;
  /** Recording state actually reached: active | failed | skipped. */
  recording: "active" | "failed" | "skipped";
}

/**
 * Prepare a recorded call: write the intent row FIRST (so webhook upserts for
 * this room update the same record), create the room explicitly, dispatch the
 * agent (the join token's room config is ignored for a pre-existing room),
 * then start an audio-only OGG room-composite egress into the private Azure
 * container. Any failure degrades to an unrecorded — but working — call.
 */
export async function startCallRecording(opts: {
  creds: LivekitCreds;
  ws: string;
  room: string;
  agentName: string;
  metadata: string;
}): Promise<StartRecordingResult> {
  const env = recordingEnv();
  if (!env) return { prepared: false, recording: "skipped" };
  const { creds, ws, room, agentName, metadata } = opts;
  const roomKey = `lk:${room}`;
  const path = recordingObjectPath(ws, room);

  // Intent first — before the room exists, so room_started can't race it.
  await writeRecordingRow(roomKey, ws, { recording_status: "active", recording_path: path });

  const rs = roomService(creds);
  try {
    await rs.createRoom({ name: room, emptyTimeout: 300, departureTimeout: 20 });
  } catch (e) {
    // Room creation failed → fall back to the ordinary implicit-creation path
    // (token room config dispatches the agent). Call unaffected, no recording.
    console.warn(`[recording] createRoom failed: ${e instanceof Error ? e.message : "error"}`);
    await writeRecordingRow(roomKey, ws, { recording_status: "failed: room create" });
    return { prepared: false, recording: "failed" };
  }

  try {
    const dispatch = new AgentDispatchClient(lkHttpUrl(creds.url), creds.apiKey, creds.apiSecret);
    await dispatch.createDispatch(room, agentName, { metadata });
  } catch (e) {
    // Without a dispatch the pre-created room would never get an agent, and a
    // pre-existing room ignores the token's room config — remove the room so
    // the token's implicit path takes over cleanly.
    console.warn(`[recording] createDispatch failed: ${e instanceof Error ? e.message : "error"}`);
    try { await rs.deleteRoom(room); } catch { /* emptyTimeout reaps it */ }
    await writeRecordingRow(roomKey, ws, { recording_status: "failed: agent dispatch" });
    return { prepared: false, recording: "failed" };
  }

  try {
    const egress = new EgressClient(lkHttpUrl(creds.url), creds.apiKey, creds.apiSecret);
    const info = await egress.startRoomCompositeEgress(
      room,
      {
        file: new EncodedFileOutput({
          fileType: EncodedFileType.OGG,
          filepath: path,
          output: {
            case: "azure",
            value: new AzureBlobUpload({
              accountName: env.account,
              accountKey: env.key,
              containerName: env.container,
            }),
          },
        }),
      },
      { audioOnly: true }
    );
    await writeRecordingRow(roomKey, ws, { recording_egress_id: String(info?.egressId ?? "") });
    return { prepared: true, recording: "active" };
  } catch (e) {
    // Room + dispatch are healthy — the call proceeds, just unrecorded.
    console.warn(`[recording] egress start failed: ${e instanceof Error ? e.message : "error"}`);
    await writeRecordingRow(roomKey, ws, { recording_status: "failed: egress start" });
    return { prepared: true, recording: "failed" };
  }
}

/** Short-lived, blob-scoped, read-only SAS URL for one stored recording. */
export function recordingReadUrl(path: string, opts?: { download?: boolean; filename?: string }): { url: string; expiresAt: string } | null {
  const env = recordingEnv();
  if (!env || !path) return null;
  const startsOn = new Date(Date.now() - 5 * 60_000); // clock-skew allowance
  const expiresOn = new Date(Date.now() + 5 * 60_000);
  const sas = generateBlobSASQueryParameters(
    {
      containerName: env.container,
      blobName: path,
      permissions: BlobSASPermissions.parse("r"),
      protocol: SASProtocol.Https,
      startsOn,
      expiresOn,
      contentType: "audio/ogg",
      ...(opts?.download
        ? { contentDisposition: `attachment; filename="${(opts.filename ?? "recording.ogg").replace(/[^\w.-]/g, "_")}"` }
        : {}),
    },
    new StorageSharedKeyCredential(env.account, env.key)
  ).toString();
  const blobPath = path.split("/").map(encodeURIComponent).join("/");
  return {
    url: `https://${env.account}.blob.core.windows.net/${env.container}/${blobPath}?${sas}`,
    expiresAt: expiresOn.toISOString(),
  };
}
