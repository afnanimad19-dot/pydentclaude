"use client";

import { useState } from "react";
import { ChevronDown, Plus, Trash2, Info } from "lucide-react";
import { Field, inputCls } from "@/components/modal";
import {
  AGENT_TOOLS,
  BACKGROUND_AUDIO,
  RANGES,
  type RangeKey,
  type AgentToolState,
} from "@/lib/agent-config";
import type { VoiceSettings, ExtractionField } from "@/lib/db";

// Advanced voice-agent configuration panels used by the Edit Agent screen.
// Every control here writes into the agent's `voice_settings` blob, is clamped
// again server-side, and is consumed by the LiveKit worker at call time — none
// of these are cosmetic.

export function Section({
  title,
  subtitle,
  children,
  defaultOpen = true,
  right,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  right?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-ink-200">
      <div className="flex items-center gap-2 px-4 py-3">
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ChevronDown className={`h-4 w-4 shrink-0 text-ink-400 transition-transform ${open ? "" : "-rotate-90"}`} />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-ink-900">{title}</span>
            {subtitle && <span className="block text-xs text-ink-500">{subtitle}</span>}
          </span>
        </button>
        {right}
      </div>
      {open && <div className="space-y-4 border-t border-ink-100 px-4 py-4">{children}</div>}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? "bg-brand-600" : "bg-ink-300"}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${checked ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

export function SliderRow({
  label,
  rangeKey,
  value,
  onChange,
  unit = "s",
  hint,
}: {
  label: string;
  rangeKey: RangeKey;
  value: number;
  onChange: (v: number) => void;
  unit?: string;
  hint: string;
}) {
  const r = RANGES[rangeKey];
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-ink-700">{label}</span>
        <span className="rounded-md bg-ink-100 px-2 py-0.5 font-mono text-[11px] text-ink-700">
          {value}
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={r.min}
        max={r.max}
        step={r.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[#7c3aed]"
      />
      <p className="mt-1 text-[11px] leading-relaxed text-ink-400">{hint}</p>
    </div>
  );
}

function NumberRow({
  label,
  rangeKey,
  value,
  onChange,
  hint,
}: {
  label: string;
  rangeKey: RangeKey;
  value: number;
  onChange: (v: number) => void;
  hint: string;
}) {
  const r = RANGES[rangeKey];
  return (
    <Field label={label}>
      <input
        type="number"
        min={r.min}
        max={r.max}
        step={r.step}
        className={inputCls}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <p className="mt-1 text-[11px] text-ink-400">{hint}</p>
    </Field>
  );
}

type Setter = <K extends keyof VoiceSettings>(k: K, v: VoiceSettings[K]) => void;

// ── Tools ────────────────────────────────────────────────────────────────────
export function AgentToolsPanel({ value, onChange }: { value: VoiceSettings; onChange: (v: VoiceSettings) => void }) {
  const tools = ((value as VoiceSettings & { tools?: AgentToolState }).tools ?? {}) as AgentToolState;
  const setTool = (id: string, on: boolean) =>
    onChange({ ...value, tools: { ...tools, [id]: on } } as VoiceSettings);

  return (
    <Section
      title="Tools the agent can use"
      subtitle="A tool that is off is never given to the AI — it cannot be called, not just hidden."
    >
      <div className="space-y-2">
        {AGENT_TOOLS.map((t) => {
          const missingNumber = t.requires === "transferNumber" && !value.transferNumber;
          const on = t.always ? true : !!tools[t.id] && !missingNumber;
          return (
            <div key={t.id} className="flex items-start justify-between gap-3 rounded-xl border border-ink-100 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink-800">
                  {t.label} <span className="font-mono text-[11px] text-ink-400">{t.id}</span>
                </p>
                <p className="text-xs text-ink-500">{t.description}</p>
                {missingNumber && (
                  <p className="mt-1 text-[11px] text-amber-600">Add a transfer number below to enable this.</p>
                )}
                {t.always && <p className="mt-1 text-[11px] text-ink-400">Always available.</p>}
              </div>
              <Toggle
                checked={on}
                onChange={(v) => !t.always && !missingNumber && setTool(t.id, v)}
                label={t.label}
              />
            </div>
          );
        })}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Transfer number (E.164)">
          <input
            className={inputCls}
            placeholder="+97141234567"
            value={value.transferNumber}
            onChange={(e) => onChange({ ...value, transferNumber: e.target.value })}
          />
        </Field>
        <Field label="What the agent says before transferring">
          <input
            className={inputCls}
            placeholder="Let me put you through to the team."
            value={value.transferMessage}
            onChange={(e) => onChange({ ...value, transferMessage: e.target.value })}
          />
        </Field>
      </div>
    </Section>
  );
}

// ── Advanced (VAD / turn detection / noise / AMD / duration) ─────────────────
type InterruptionMode = "adaptive" | "eager" | "off";
const INTERRUPTION_DEFAULTS = { mode: "adaptive" as InterruptionMode, minDuration: 0.5, minWords: 1, resumeFalseInterruption: true };

export function AgentAdvancedPanel({ value, onChange }: { value: VoiceSettings; onChange: (v: VoiceSettings) => void }) {
  const set: Setter = (k, v) => onChange({ ...value, [k]: v });
  const inter = value.interruptions ?? INTERRUPTION_DEFAULTS;
  // The mode is also mirrored onto voiceSettings.livekit.interruptions, which is
  // where it lived before this panel existed and what older configs still read.
  const setInter = (patch: Partial<typeof INTERRUPTION_DEFAULTS>) => {
    const next = { ...inter, ...patch };
    onChange({
      ...value,
      interruptions: next,
      ...(value.livekit ? { livekit: { ...value.livekit, interruptions: next.mode } } : {}),
    });
  };

  return (
    <div className="space-y-4">
      <Section title="Agent speaking — Voice Activity Detection (VAD)" subtitle="How the agent decides the caller is speaking. Applied to silero VAD on the next call.">
        <div className="grid gap-5 md:grid-cols-2">
          <SliderRow
            label="Minimum speech duration"
            rangeKey="minSpeechDuration"
            value={value.minSpeechDuration}
            onChange={(v) => set("minSpeechDuration", v)}
            hint="How long sound must look like speech before it counts. Lower reacts faster but can trigger on noise. Recommended 0.1s."
          />
          <SliderRow
            label="Minimum silence duration"
            rangeKey="minSilenceDuration"
            value={value.minSilenceDuration}
            onChange={(v) => set("minSilenceDuration", v)}
            hint="How much silence means the caller has stopped. Shorter feels snappier but can cut people off. Recommended 0.3s."
          />
          <SliderRow
            label="Activation threshold"
            rangeKey="activationThreshold"
            value={value.activationThreshold}
            onChange={(v) => set("activationThreshold", v)}
            unit=""
            hint="Sensitivity of voice detection. Lower hears quiet callers but also background noise. Recommended 0.5."
          />
          <SliderRow
            label="Prefix padding duration"
            rangeKey="prefixPaddingDuration"
            value={value.prefixPaddingDuration}
            onChange={(v) => set("prefixPaddingDuration", v)}
            hint="Audio kept from just before speech starts, so the first word isn't clipped. Recommended 0.3s."
          />
          <SliderRow
            label="End of speech timeout"
            rangeKey="endOfSpeechTimeout"
            value={value.endOfSpeechTimeout}
            onChange={(v) => set("endOfSpeechTimeout", v)}
            hint="Wait after speech stops before the agent takes its turn. Shorter = faster replies. Recommended 0.2s."
          />
        </div>
      </Section>

      <Section
        title="Turn detection"
        subtitle="Decides when the caller has finished their sentence."
        right={<Toggle checked={value.turnDetectionEnabled} onChange={(v) => set("turnDetectionEnabled", v)} label="Turn detection" />}
      >
        {value.turnDetectionEnabled ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Detection mode">
              <select
                className={inputCls}
                value={value.detectionMode}
                onChange={(e) => set("detectionMode", e.target.value as VoiceSettings["detectionMode"])}
              >
                <option value="smart">Smart — AI decides when the caller is done (recommended)</option>
                <option value="fixed">Fixed — wait a set pause every time</option>
              </select>
            </Field>
            <SliderRow
              label="Detection timeout"
              rangeKey="detectionTimeout"
              value={value.detectionTimeout}
              onChange={(v) => set("detectionTimeout", v)}
              hint="Longest the agent waits before replying anyway. Higher is more patient with slow speakers. Recommended 2.0s."
            />
          </div>
        ) : (
          <p className="text-xs text-ink-500">
            Off — the agent falls back to plain silence-based endpointing using the VAD settings above. Barge-in still works.
          </p>
        )}
      </Section>

      <Section
        title="Interruptions (barge-in)"
        subtitle="What happens when the caller talks over the agent."
      >
        <Field label="Interruption mode">
          <select
            className={inputCls}
            value={inter.mode}
            onChange={(e) => setInter({ mode: e.target.value as InterruptionMode })}
          >
            <option value="adaptive">Adaptive — wait for a real word before stopping (recommended)</option>
            <option value="eager">Eager — stop the moment the caller makes a sound</option>
            <option value="off">Off — the agent always finishes its sentence</option>
          </select>
        </Field>
        {inter.mode === "off" ? (
          <p className="text-xs text-ink-500">
            The caller cannot interrupt. Their speech is still transcribed and answered on the next turn.
          </p>
        ) : (
          <>
            <div className="grid gap-5 md:grid-cols-2">
              <SliderRow
                label="Minimum interruption duration"
                rangeKey="interruptionMinDuration"
                value={inter.minDuration}
                onChange={(v) => setInter({ minDuration: v })}
                hint="How long the caller must speak before the agent stops. Higher ignores coughs and background bumps."
              />
              <SliderRow
                label="Minimum words"
                rangeKey="interruptionMinWords"
                value={inter.minWords}
                onChange={(v) => setInter({ minWords: Math.round(v) })}
                unit=""
                hint='Words the caller must say before the agent stops. 0 interrupts on any sound; 1 ignores "mhm" noises. Ignored in Eager mode.'
              />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-ink-100 px-3 py-2.5">
              <span>
                <span className="text-sm font-medium text-ink-800">Resume after a false interruption</span>
                <span className="block text-xs text-ink-500">
                  If the agent stopped but the caller never actually spoke, it picks its sentence back up.
                </span>
              </span>
              <Toggle
                checked={inter.resumeFalseInterruption}
                onChange={(v) => setInter({ resumeFalseInterruption: v })}
                label="Resume after a false interruption"
              />
            </div>
          </>
        )}
      </Section>

      <Section
        title="Noise reduction"
        subtitle="Cleans the caller's audio before the agent hears it."
        right={<Toggle checked={value.noiseReductionEnabled} onChange={(v) => set("noiseReductionEnabled", v)} label="Noise reduction" />}
      >
        {value.noiseReductionEnabled ? (
          <>
            <Field label="Reduction level">
              <select
                className={inputCls}
                value={value.reductionLevel}
                onChange={(e) => set("reductionLevel", e.target.value as VoiceSettings["reductionLevel"])}
              >
                <option value="low">Low — remove background noise</option>
                <option value="medium">Medium — also remove background voices</option>
                <option value="high">High — background voices, tuned for phone calls</option>
              </select>
            </Field>
            <div className="flex items-start gap-2 rounded-lg border border-ink-100 bg-ink-50/60 p-3 text-[11px] text-ink-500">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              LiveKit provides three distinct algorithms rather than an intensity dial, so these map to:
              Low → <span className="mx-1 font-mono">NC</span>, Medium → <span className="mx-1 font-mono">BVC</span>,
              High → <span className="mx-1 font-mono">BVCTelephony</span> (best for SIP/landline calls).
            </div>
          </>
        ) : (
          <p className="text-xs text-ink-500">Off — the caller&apos;s audio reaches the agent unprocessed.</p>
        )}
      </Section>

      <Section
        title="Answering machine detection"
        subtitle="Detects voicemail on outbound calls."
        right={<Toggle checked={value.amdEnabled} onChange={(v) => set("amdEnabled", v)} label="Answering machine detection" />}
      >
        {value.amdEnabled ? (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex items-center justify-between gap-3 rounded-xl border border-ink-100 px-3 py-2.5">
                <span>
                  <span className="text-sm font-medium text-ink-800">Multilingual AMD</span>
                  <span className="block text-xs text-ink-500">Detect voicemail greetings in other languages.</span>
                </span>
                <Toggle checked={value.multilingualAmd} onChange={(v) => set("multilingualAmd", v)} label="Multilingual AMD" />
              </div>
              <NumberRow
                label="AMD timeout (seconds)"
                rangeKey="amdTimeout"
                value={value.amdTimeout}
                onChange={(v) => set("amdTimeout", v)}
                hint="How long to listen to the greeting before deciding. Recommended 10s."
              />
            </div>
            <p className="text-[11px] text-ink-500">
              Policy when a machine is detected: the agent hangs up instead of talking to voicemail. This matters for outbound
              campaigns — on inbound calls it stays out of the way.
            </p>
          </>
        ) : (
          <p className="text-xs text-ink-500">Off — nothing runs, and calls are never ended by detection.</p>
        )}
      </Section>

      <Section title="Reminder & call duration" subtitle="What happens when the caller goes quiet, and how long a call may run.">
        <div className="grid gap-4 md:grid-cols-2">
          <NumberRow
            label="Silence before check (seconds)"
            rangeKey="silenceBeforeCheck"
            value={value.silenceBeforeCheck}
            onChange={(v) => set("silenceBeforeCheck", v)}
            hint='How long the caller may be silent before the agent asks "Are you still there?"'
          />
          <NumberRow
            label="Max check attempts"
            rangeKey="maxCheckAttempts"
            value={value.maxCheckAttempts}
            onChange={(v) => set("maxCheckAttempts", v)}
            hint="How many times it checks in before ending the call."
          />
          <NumberRow
            label="Max silence duration (seconds)"
            rangeKey="maxSilenceDuration"
            value={value.maxSilenceDuration}
            onChange={(v) => set("maxSilenceDuration", v)}
            hint="Total silence before the call ends, whatever the check-ins say."
          />
          <NumberRow
            label="Maximum call duration (minutes)"
            rangeKey="maxCallDuration"
            value={value.maxCallDuration}
            onChange={(v) => set("maxCallDuration", v)}
            hint="Hard limit. The agent gives a short warning ~30s before it ends the call."
          />
        </div>
        {value.maxSilenceDuration < value.silenceBeforeCheck && (
          <p className="text-[11px] text-rose-600">
            Max silence duration must be at least the silence-before-check value, or the call ends before the agent ever checks in.
          </p>
        )}
      </Section>
    </div>
  );
}

// ── Post-call data extraction ───────────────────────────────────────────────
const EXTRACTION_TYPE_OPTIONS: { id: ExtractionField["type"]; label: string }[] = [
  { id: "text", label: "Text" },
  { id: "number", label: "Number" },
  { id: "boolean", label: "Yes / No" },
  { id: "date", label: "Date" },
  { id: "datetime", label: "Date & time" },
  { id: "enum", label: "One of a list" },
];

const SUGGESTED_FIELDS: ExtractionField[] = [
  { name: "Caller name", description: "The caller's full name.", type: "text" },
  { name: "Phone number", description: "The best number to reach them on.", type: "text" },
  { name: "New patient", description: "True if this is a first-time patient.", type: "boolean" },
  { name: "Requested service", description: "The treatment or service they asked about.", type: "text" },
  { name: "Preferred date", description: "The date they'd like to come in.", type: "date" },
  { name: "Appointment status", description: "Whether an appointment was booked, rescheduled, cancelled or not made.", type: "enum", options: ["booked", "rescheduled", "cancelled", "none"] },
  { name: "Call outcome", description: "What the call achieved in a few words.", type: "text" },
  { name: "Follow-up required", description: "True if someone from the clinic needs to call back.", type: "boolean" },
  { name: "Call summary", description: "A two-sentence summary of the conversation.", type: "text" },
];

export function PostCallPanel({ value, onChange }: { value: VoiceSettings; onChange: (v: VoiceSettings) => void }) {
  const fields = value.extractionFields ?? [];
  const setFields = (f: ExtractionField[]) => onChange({ ...value, extractionFields: f });
  const update = (i: number, patch: Partial<ExtractionField>) =>
    setFields(fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const analysisOff = value.dataStorage !== "store_analyze";

  return (
    <Section
      title="Post-call data extraction"
      subtitle="After each call the transcript is read and these fields are filled in automatically."
      right={
        <button
          type="button"
          onClick={() => setFields([...fields, { name: "", description: "", type: "text" }])}
          className="flex items-center gap-1.5 rounded-lg border border-brand-300 px-2.5 py-1.5 text-xs font-semibold text-brand-600 hover:bg-brand-50"
        >
          <Plus className="h-3.5 w-3.5" /> Add field
        </button>
      }
    >
      {analysisOff && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700">
          Privacy is set to “{value.dataStorage === "no_store" ? "Don't store calls" : "Store only"}”, so extraction will not run.
          Set privacy to “Store and analyze calls” to use these fields.
        </p>
      )}

      {fields.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ink-200 p-4 text-center">
          <p className="text-xs text-ink-500">No fields yet — nothing is extracted after a call.</p>
          <button
            type="button"
            onClick={() => setFields(SUGGESTED_FIELDS)}
            className="mt-2 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"
          >
            Add the 9 common clinic fields
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {fields.map((f, i) => (
            <div key={i} className="rounded-xl border border-ink-100 p-3">
              <div className="grid gap-2 md:grid-cols-[1fr_1fr_150px_auto]">
                <input
                  className={inputCls}
                  placeholder="Field name (e.g. Caller name)"
                  value={f.name}
                  onChange={(e) => update(i, { name: e.target.value })}
                />
                <input
                  className={inputCls}
                  placeholder="What to extract / instructions"
                  value={f.description}
                  onChange={(e) => update(i, { description: e.target.value })}
                />
                <select
                  className={inputCls}
                  value={f.type === "string" ? "text" : f.type}
                  onChange={(e) => update(i, { type: e.target.value as ExtractionField["type"] })}
                >
                  {EXTRACTION_TYPE_OPTIONS.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setFields(fields.filter((_, idx) => idx !== i))}
                  className="rounded-lg p-2 text-ink-400 hover:bg-rose-500/10 hover:text-rose-500"
                  title="Delete field"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              {f.type === "enum" && (
                <input
                  className={`${inputCls} mt-2`}
                  placeholder="Allowed values, comma separated (e.g. booked, cancelled, none)"
                  value={(f.options ?? []).join(", ")}
                  onChange={(e) => update(i, { options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// ── Privacy ──────────────────────────────────────────────────────────────────
export function PrivacyPanel({ value, onChange }: { value: VoiceSettings; onChange: (v: VoiceSettings) => void }) {
  const store = value.dataStorage;
  return (
    <Section title="Privacy — data storage preference" subtitle="What Pydent is allowed to keep from each call.">
      <Field label="Data storage">
        <select
          className={inputCls}
          value={store}
          onChange={(e) => onChange({ ...value, dataStorage: e.target.value as VoiceSettings["dataStorage"] })}
        >
          <option value="store_analyze">Store and analyze calls</option>
          <option value="store_only">Store calls only — no analysis</option>
          <option value="no_store">Don&apos;t store call content</option>
        </select>
      </Field>
      <div className="rounded-lg border border-ink-100 bg-ink-50/60 p-3 text-[11px] text-ink-600">
        {store === "store_analyze" && (
          <>
            <p className="font-semibold text-ink-800">Stored and analyzed:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>Call transcript and per-turn timeline</li>
              <li>Call outcome and summary</li>
              <li>Post-call extracted fields</li>
              <li>Latency metrics for troubleshooting</li>
            </ul>
          </>
        )}
        {store === "store_only" && (
          <p>The transcript and call record are kept, but no post-call extraction or analysis runs.</p>
        )}
        {store === "no_store" && (
          <p>
            Only the call metadata (time, number, duration, outcome) is kept. No transcript, no messages, no extraction — the
            call still works normally.
          </p>
        )}
      </div>
    </Section>
  );
}

// ── Background audio (Agent details tab) ─────────────────────────────────────
export function BackgroundAudioField({ value, onChange }: { value: VoiceSettings; onChange: (v: VoiceSettings) => void }) {
  const current = (value as VoiceSettings & { backgroundAudio?: string }).backgroundAudio ?? "none";
  return (
    <Field label="Background audio">
      <select
        className={inputCls}
        value={current}
        onChange={(e) => onChange({ ...value, backgroundAudio: e.target.value } as VoiceSettings)}
      >
        {BACKGROUND_AUDIO.map((b) => (
          <option key={b.id} value={b.id}>
            {b.label}
          </option>
        ))}
      </select>
      <p className="mt-1 text-[11px] text-ink-400">Quiet ambience played under the call so it doesn&apos;t sound like a dead line.</p>
    </Field>
  );
}
