// Browser client for a live Grok voice call (xAI Voice Agent API). Opens the
// realtime WebSocket with a short-lived client secret from /api/xai/session,
// streams the mic up as PCM16 24kHz and plays the agent's speech back, handles
// interruptions (barge-in), transcripts, and function calls — each tool call is
// executed server-side via /api/agents/tool-exec so bookings/emails are real.

export interface XaiCallHandlers {
  onState: (s: "live" | "ended" | "error") => void;
  onError: (msg: string) => void;
  onSpeaking: (speaking: boolean) => void;
  onLine: (speaker: "user" | "assistant", text: string) => void;
}

function pcm16ToBase64(f32: Float32Array): string {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(i16.buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToF32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const i16 = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000;
  return f32;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export class XaiRealtimeCall {
  private ws: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private nextPlayTime = 0;
  private assistantText = "";
  private pendingUserText = "";
  private agentId = "";
  private handlers: XaiCallHandlers | null = null;
  private closed = false;
  // The API can emit BOTH the GA and the legacy event name for the same audio /
  // transcript chunk. Lock onto whichever name arrives first and ignore the
  // other — otherwise every chunk plays twice (overlapping "double voice") and
  // every line lands in the transcript twice.
  private audioEvt: string | null = null;
  private trDeltaEvt: string | null = null;
  private trDoneEvt: string | null = null;
  private lastLine: { speaker: string; text: string } | null = null;

  async start(agentId: string, handlers: XaiCallHandlers): Promise<void> {
    this.agentId = agentId;
    this.handlers = handlers;

    const res = await fetch("/api/xai/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId }),
    });
    const cfg = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(cfg.error ?? "Could not start the voice session.");

    // Mic first, so the permission prompt happens before the socket opens.
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    this.audioCtx = new AudioContext({ sampleRate: 24000 });

    const ws = new WebSocket(`${cfg.url}?model=${encodeURIComponent(cfg.model)}`, [`xai-client-secret.${cfg.token}`]);
    this.ws = ws;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            voice: cfg.voice,
            instructions: cfg.instructions,
            turn_detection: { type: "server_vad" },
            audio: {
              input: { format: { type: "audio/pcm", rate: 24000 }, transport: "json" },
              output: { format: { type: "audio/pcm", rate: 24000 }, transport: "json" },
            },
            ...(Array.isArray(cfg.tools) && cfg.tools.length ? { tools: cfg.tools } : {}),
          },
        })
      );
      // Speak the configured opener word-for-word (xAI force_message extension).
      if (cfg.greetFirst && cfg.firstMessage) {
        ws.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: { type: "force_message", role: "assistant", interruptible: true, content: [{ type: "output_text", text: cfg.firstMessage }] },
          })
        );
        this.commitLine("assistant", cfg.firstMessage);
      }
      this.startMicPump();
      handlers.onState("live");
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      void this.handleEvent(msg);
    };

    ws.onerror = () => {
      if (!this.closed) handlers.onError("The voice connection failed.");
    };
    ws.onclose = () => {
      if (!this.closed) {
        this.closed = true;
        this.teardownAudio();
        handlers.onState("ended");
      }
    };
  }

  private commitLine(speaker: "user" | "assistant", text: string) {
    const t = (text ?? "").trim();
    if (!t) return;
    // Drop exact repeats (e.g. the greeting we logged locally arriving again as
    // a server transcript, or a duplicate .done event).
    if (this.lastLine && this.lastLine.speaker === speaker && this.lastLine.text === t) return;
    this.lastLine = { speaker, text: t };
    this.handlers?.onLine(speaker, t);
  }

  private async handleEvent(msg: any): Promise<void> {
    const type: string = msg?.type ?? "";
    if (type === "response.output_audio.delta" || type === "response.audio.delta") {
      if (!this.audioEvt) this.audioEvt = type;
      if (type !== this.audioEvt) return; // duplicate stream under the other name
      if (typeof msg.delta === "string") this.playDelta(msg.delta);
      this.handlers?.onSpeaking(true);
    } else if (type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta") {
      if (!this.trDeltaEvt) this.trDeltaEvt = type;
      if (type !== this.trDeltaEvt) return;
      this.assistantText += msg.delta ?? "";
    } else if (type === "response.output_audio_transcript.done" || type === "response.audio_transcript.done") {
      if (!this.trDoneEvt) this.trDoneEvt = type;
      if (type !== this.trDoneEvt) return;
      this.commitLine("assistant", msg.transcript ?? this.assistantText);
      this.assistantText = "";
    } else if (type === "response.done") {
      if (this.assistantText) {
        this.commitLine("assistant", this.assistantText);
        this.assistantText = "";
      }
      this.handlers?.onSpeaking(false);
    } else if (type === "conversation.item.input_audio_transcription.updated") {
      // xAI sends the CUMULATIVE user transcript as it firms up.
      this.pendingUserText = msg.transcript ?? msg.delta ?? this.pendingUserText;
    } else if (type === "conversation.item.input_audio_transcription.completed") {
      this.commitLine("user", msg.transcript ?? this.pendingUserText);
      this.pendingUserText = "";
    } else if (type === "response.created") {
      // The agent started answering — the user's turn is final now.
      if (this.pendingUserText) {
        this.commitLine("user", this.pendingUserText);
        this.pendingUserText = "";
      }
    } else if (type === "input_audio_buffer.speech_started") {
      // Barge-in: the caller started talking — cut the agent's audio.
      this.interruptPlayback();
    } else if (type === "response.function_call_arguments.done") {
      await this.runToolCall(msg);
    } else if (type === "error") {
      const detail = msg?.error?.message ?? msg?.message ?? "Voice session error";
      this.handlers?.onError(String(detail).slice(0, 300));
    }
  }

  private async runToolCall(msg: any): Promise<void> {
    const name: string = msg?.name ?? msg?.function?.name ?? "";
    const callId: string = msg?.call_id ?? msg?.callId ?? "";
    let args: any = {};
    try {
      args = typeof msg?.arguments === "string" ? JSON.parse(msg.arguments) : msg?.arguments ?? {};
    } catch {
      args = {};
    }
    let result = "Tool failed.";
    try {
      const res = await fetch("/api/agents/tool-exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: this.agentId, name, args }),
      });
      const data = await res.json().catch(() => ({}));
      result = data.result ?? data.error ?? "Tool failed.";
    } catch {
      result = "Error: could not reach the server to run the action.";
    }
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: result } }));
      ws.send(JSON.stringify({ type: "response.create" }));
    }
  }

  private startMicPump() {
    const ctx = this.audioCtx;
    const stream = this.micStream;
    if (!ctx || !stream) return;
    const source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor is deprecated but universally supported; 4096 samples at
    // 24kHz ≈ 170ms chunks, well within the realtime budget.
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    this.processor = proc;
    proc.onaudioprocess = (e) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const data = e.inputBuffer.getChannelData(0);
      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm16ToBase64(data) }));
    };
    source.connect(proc);
    proc.connect(ctx.destination); // required for onaudioprocess to fire in some browsers
  }

  private playDelta(b64: string) {
    const ctx = this.audioCtx;
    if (!ctx) return;
    const f32 = base64ToF32(b64);
    if (!f32.length) return;
    const buf = ctx.createBuffer(1, f32.length, 24000);
    buf.copyToChannel(new Float32Array(f32), 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.05, this.nextPlayTime);
    src.start(startAt);
    this.nextPlayTime = startAt + buf.duration;
    this.sources.push(src);
    src.onended = () => {
      this.sources = this.sources.filter((s) => s !== src);
    };
  }

  private interruptPlayback() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources = [];
    this.nextPlayTime = 0;
    this.handlers?.onSpeaking(false);
    // Ask the model to stop generating the cut-off answer too.
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "response.cancel" }));
      } catch {
        /* best-effort */
      }
    }
  }

  private teardownAudio() {
    try {
      this.processor?.disconnect();
    } catch { /* already gone */ }
    this.processor = null;
    for (const t of this.micStream?.getTracks() ?? []) t.stop();
    this.micStream = null;
    this.interruptPlayback();
    void this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws?.close();
    } catch { /* already closed */ }
    this.ws = null;
    this.teardownAudio();
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
