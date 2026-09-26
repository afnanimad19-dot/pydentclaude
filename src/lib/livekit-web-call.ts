// Browser client for a live LiveKit test call. Gets a room join token from
// /api/livekit/session (whose room config auto-dispatches the Pydent worker for
// this agent), joins the room with the mic, plays the agent's audio, and turns
// LiveKit transcription streams into transcript lines — same handler shape the
// Vapi test call uses, so the Test Call modal treats both engines alike.
//
// Connection state and audio playback are handled explicitly:
//  - the call reports LIVE as soon as the room connects; the microphone is
//    acquired separately and its failure is surfaced (onMicError) without
//    ending the call or masking it as a disconnect;
//  - every subscribed audio track is attached unmuted at full volume, its
//    play() promise is observed, and blocked autoplay is reported through
//    onAudioBlocked so the UI can offer an "Enable audio" action that calls
//    enableAudio() from a real user gesture (room.startAudio() + retries).

import { Room, RoomEvent, Track, type RemoteTrack, type Participant, type TranscriptionSegment } from "livekit-client";
import { WebCallState } from "@/lib/web-call-state";

export interface LivekitCallHandlers {
  onState: (s: "live" | "ended" | "error") => void;
  onError: (msg: string) => void;
  onSpeaking: (speaking: boolean) => void;
  onLine: (speaker: "user" | "assistant", text: string) => void;
  /** Browser refused/failed audio playback (true) or it recovered (false). */
  onAudioBlocked?: (blocked: boolean) => void;
  /** Microphone permission/device problem — the call stays live. */
  onMicError?: (msg: string) => void;
}

export class LivekitWebCall {
  private room: Room | null = null;
  private state: WebCallState | null = null;
  private audioEls: HTMLAudioElement[] = [];
  private attached = new Set<string>(); // track sids — one element per track, ever
  private seen = new Set<string>();

  async start(agentId: string, handlers: LivekitCallHandlers): Promise<void> {
    const res = await fetch("/api/livekit/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId }),
    });
    const cfg = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(cfg.error ?? "Could not start the LiveKit session.");

    const state = new WebCallState(handlers);
    this.state = state;
    const room = new Room({ adaptiveStream: true, dynacast: true });
    this.room = room;

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind !== Track.Kind.Audio) return;
      const sid = String(track.sid ?? "");
      if (sid && this.attached.has(sid)) return; // never duplicate elements
      if (sid) this.attached.add(sid);
      const el = track.attach() as HTMLAudioElement;
      el.autoplay = true;
      el.muted = false;
      el.volume = 1;
      el.style.display = "none";
      document.body.appendChild(el);
      this.audioEls.push(el);
      this.tryPlay(el);
    });

    // The browser's own signal for blocked/recovered audio playback.
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      state.playback(!room.canPlaybackAudio);
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
      if (state.ended()) this.cleanup();
    });

    try {
      await room.connect(cfg.url, cfg.token);
    } catch (e) {
      state.failed();
      this.cleanup();
      throw new Error(e instanceof Error ? e.message : "Could not connect to LiveKit.");
    }
    // The ROOM is up — the call is live. The agent can already be heard even
    // if the mic prompt below is still open or gets denied.
    state.connected();
    void this.enableMic(state);
  }

  // Microphone acquisition, separate from connection state: a pending
  // permission prompt no longer holds the UI in "Connecting…", and a denied
  // mic is reported as a mic problem — never as a dead call. WebCallState
  // guarantees a late result can't touch the UI after the call ended.
  private async enableMic(state: WebCallState): Promise<void> {
    try {
      await this.room?.localParticipant.setMicrophoneEnabled(true);
    } catch (e) {
      state.micFailed(e instanceof Error ? e.message : "Microphone permission was not granted.");
    }
  }

  // Observe the play() promise: browsers reject it when autoplay is blocked.
  private tryPlay(el: HTMLAudioElement): void {
    el.play().then(
      () => this.state?.playback(false),
      () => this.state?.playback(true)
    );
  }

  /**
   * Recover blocked playback. MUST be called from a user gesture (the modal's
   * "Enable audio" button): unlocks the room's audio context and retries every
   * attached element. WebCallState de-duplicates the recovered notification.
   */
  async enableAudio(): Promise<void> {
    const room = this.room;
    if (!room || this.state?.closed) return;
    try {
      await room.startAudio();
    } catch { /* elements are retried below either way */ }
    for (const el of this.audioEls) this.tryPlay(el);
    this.state?.playback(!room.canPlaybackAudio);
  }

  private cleanup() {
    for (const el of this.audioEls) {
      try { el.pause(); el.remove(); } catch { /* already gone */ }
    }
    this.audioEls = [];
    this.attached.clear();
    // Drop every listener so a discarded Room can't leak handlers or keep
    // firing into a closed call.
    try { this.room?.removeAllListeners(); } catch { /* already gone */ }
  }

  stop() {
    if (!this.state || this.state.closed) {
      this.state?.closeQuietly();
      return;
    }
    this.state.closeQuietly();
    try { void this.room?.disconnect(); } catch { /* already closed */ }
    this.room = null;
    this.cleanup();
  }
}
