// Connection/audio state machine for the browser test call — pure and
// dependency-free so every transition is unit-testable (livekit-web-call.ts
// wires it to the real Room events).
//
// Rules it enforces:
//  - "live" is reported when the ROOM connects; microphone acquisition is a
//    separate concern whose failure never ends the call or flips it to error.
//  - blocked-playback notifications are edge-triggered (no repeats).
//  - once the call has ended or failed, NOTHING can update the UI any more
//    (late mic-permission results, stray playback events, double ends).

export interface WebCallStateEvents {
  onState: (s: "live" | "ended" | "error") => void;
  onAudioBlocked?: (blocked: boolean) => void;
  onMicError?: (msg: string) => void;
}

export type WebCallPhase = "connecting" | "live" | "ended" | "error";

export class WebCallState {
  private phase: WebCallPhase = "connecting";
  private blocked: boolean | null = null;
  private ev: WebCallStateEvents;

  constructor(ev: WebCallStateEvents) {
    this.ev = ev;
  }

  get closed(): boolean {
    return this.phase === "ended" || this.phase === "error";
  }

  get isBlocked(): boolean {
    return this.blocked === true;
  }

  /** The room connected — the call is live (mic comes separately). */
  connected(): void {
    if (this.closed || this.phase === "live") return;
    this.phase = "live";
    this.ev.onState("live");
  }

  /** Mic permission/device failed. Surfaced, but the call STAYS live. */
  micFailed(msg: string): void {
    if (this.closed) return;
    this.ev.onMicError?.(msg);
  }

  /** Playback blocked/recovered — edge-triggered. */
  playback(blocked: boolean): void {
    if (this.closed) return;
    if (this.blocked === blocked) return;
    this.blocked = blocked;
    this.ev.onAudioBlocked?.(blocked);
  }

  /** Remote disconnect → notify once. Returns false if already closed. */
  ended(): boolean {
    if (this.closed) return false;
    this.phase = "ended";
    this.ev.onState("ended");
    return true;
  }

  /** Local stop() — close WITHOUT an event (the UI already knows). */
  closeQuietly(): void {
    if (this.closed) return;
    this.phase = "ended";
  }

  /** Connect failed — close without events (start() throws to the caller). */
  failed(): void {
    if (this.closed) return;
    this.phase = "error";
  }
}
