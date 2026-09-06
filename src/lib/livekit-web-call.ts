// Browser client for a live LiveKit test call. Gets a room join token from
// /api/livekit/session (whose room config auto-dispatches the Pydent worker for
// this agent), joins the room with the mic, plays the agent's audio, and turns
// LiveKit transcription streams into transcript lines — same handler shape the
// Vapi test call uses, so the Test Call modal treats both engines alike.

import { Room, RoomEvent, Track, type RemoteTrack, type Participant, type TranscriptionSegment } from "livekit-client";

export interface LivekitCallHandlers {
  onState: (s: "live" | "ended" | "error") => void;
  onError: (msg: string) => void;
  onSpeaking: (speaking: boolean) => void;
  onLine: (speaker: "user" | "assistant", text: string) => void;
}

export class LivekitWebCall {
  private room: Room | null = null;
  private audioEls: HTMLAudioElement[] = [];
  private seen = new Set<string>();
  private closed = false;

  async start(agentId: string, handlers: LivekitCallHandlers): Promise<void> {
    const res = await fetch("/api/livekit/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId }),
    });
    const cfg = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(cfg.error ?? "Could not start the LiveKit session.");

    const room = new Room({ adaptiveStream: true, dynacast: true });
    this.room = room;

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind !== Track.Kind.Audio) return;
      const el = track.attach() as HTMLAudioElement;
      el.autoplay = true;
      el.style.display = "none";
      document.body.appendChild(el);
      this.audioEls.push(el);
    });

    // Final transcript segments → lines. The agent's own speech comes from the
    // agent participant; the caller's from the local participant.
    room.on(RoomEvent.TranscriptionReceived, (segments: TranscriptionSegment[], participant?: Participant) => {
      for (const s of segments) {
        if (!s.final || !s.text?.trim()) continue;
        if (this.seen.has(s.id)) continue;
        this.seen.add(s.id);
        const isLocal = participant?.identity === room.localParticipant.identity;
        handlers.onLine(isLocal ? "user" : "assistant", s.text.trim());
      }
    });

    room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      handlers.onSpeaking(speakers.some((p) => p.identity !== room.localParticipant.identity));
    });

    room.on(RoomEvent.Disconnected, () => {
      if (!this.closed) {
        this.closed = true;
        this.cleanup();
        handlers.onState("ended");
      }
    });

    try {
      await room.connect(cfg.url, cfg.token);
      await room.localParticipant.setMicrophoneEnabled(true);
    } catch (e) {
      this.cleanup();
      throw new Error(e instanceof Error ? e.message : "Could not connect to LiveKit.");
    }
    handlers.onState("live");
  }

  private cleanup() {
    for (const el of this.audioEls) {
      try { el.pause(); el.remove(); } catch { /* already gone */ }
    }
    this.audioEls = [];
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    try { void this.room?.disconnect(); } catch { /* already closed */ }
    this.room = null;
    this.cleanup();
  }
}
