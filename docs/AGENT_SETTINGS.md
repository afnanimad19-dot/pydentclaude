# Agent settings — defaults, ranges and what each one actually does

Every control in **Dashboard → AI Agents → Edit agent** is stored per agent in
`agents.voice_settings` (JSONB) and read by the Pydent LiveKit worker at the
**start of every call**. There is no sync step and no redeploy: save the agent
and the very next call uses the new values.

Where the settings live:

| Layer | File | Role |
| --- | --- | --- |
| Contract + defaults + clamping | `src/lib/agent-config.ts` | The only place defaults live. Used by the UI, on save, and again server-side. |
| UI | `src/components/dashboard/agent-advanced.tsx`, `agents-shared.tsx` | Tabs inside the Edit Agent modal. |
| Server | `src/lib/livekit.ts` → `livekitAgentConfig()` | Normalizes, compiles the prompt, returns only safe values. |
| Worker | `livekit-agent/agent.py` | Turns the config into real LiveKit objects. |
| Storage of results | migration `0061` | `voice_calls.extracted_data`, `.latency_metrics`, `.config_version`. |

## Backward compatibility

`normalizeVoiceSettings()` fills any missing key from the defaults below, so an
agent saved before these settings existed keeps working and simply picks up the
defaults. Two legacy shapes are migrated in place:

* per-tool state is derived from the agent's old `can_book` / `can_reschedule` /
  `can_cancel` flags when `voice_settings.tools` is absent;
* barge-in mode is read from the old `voice_settings.livekit.interruptions`
  string when the structured `interruptions` object is absent (and the legacy key
  is kept in step afterwards).

The server also still sends the pre-existing keys (`canBook`, `maxCallMinutes`,
`interruptions` as a bare string, …) so a worker deployed before this build keeps
running unchanged.

## Agent details

| Setting | Default | Range | Runtime effect |
| --- | --- | --- | --- |
| STT / STT language | `deepgram/nova-3` / auto | — | `inference.STT(model=, language=)` |
| LLM | see `livekit-models.ts` | — | `inference.LLM(model=)` |
| TTS / Voice | see `livekit-models.ts` | — | `inference.TTS(model=, voice=)` |
| Background audio | `none` | none · office · city · crowd · forest | `BackgroundAudioPlayer(ambient_sound=BuiltinAudioClip.*)` |

## Conversation

| Setting | Default | Runtime effect |
| --- | --- | --- |
| Who speaks first | Assistant speaks first | `session.say(greeting)`, `session.generate_reply(...)`, or silence |
| First message | — | Spoken word-for-word when the assistant speaks first |

## Prompt configuration

Agent Identity, Tasks and Style Guardrails stay in **separate database columns**
(`agent_identity`, `instructions`, `behavior`). They are compiled into one system
prompt at call time in `livekitAgentConfig()`, together with the knowledge base
and the rules for whichever tools are enabled — so editing any one section
changes the next call without touching the others.

## Tools

A tool that is switched off is **never created** in the worker, so it is absent
from the LLM's tool schema — it cannot be called, not merely hidden.

`end_call` is always on. `transfer_call` is forced off until a transfer number is
set, because it could not succeed without one.

## Voice activity detection (VAD)

All five reach `silero.VAD.load(...)` / endpointing.

| Setting | Default | Range | LiveKit parameter |
| --- | --- | --- | --- |
| Minimum speech duration | 0.1 s | 0.0 – 1.0 | `min_speech_duration` |
| Minimum silence duration | 0.3 s | 0.1 – 3.0 | `min_silence_duration` |
| Activation threshold | 0.5 | 0.1 – 0.9 | `activation_threshold` |
| Prefix padding duration | 0.3 s | 0.0 – 3.0 | `prefix_padding_duration` |
| End of speech timeout | 0.2 s | 0.0 – 3.0 | `EndpointingOptions.min_delay` |

## Turn detection

| Setting | Default | Range | LiveKit parameter |
| --- | --- | --- | --- |
| Enabled | on | — | `TurnHandlingOptions.turn_detection` = `inference.TurnDetector()` when on, `"vad"` when off |
| Mode | Smart | smart · fixed | `EndpointingOptions.mode` = `dynamic` / `fixed` |
| Detection timeout | 2.0 s | 0.5 – 10.0 | `EndpointingOptions.max_delay` |

## Interruptions (barge-in)

| Setting | Default | Range | LiveKit parameter |
| --- | --- | --- | --- |
| Mode | Adaptive | adaptive · eager · off | `InterruptionOptions.enabled` + `.mode` (`adaptive` / `vad`) |
| Minimum interruption duration | 0.5 s (0.2 s in eager) | 0.0 – 2.0 | `min_duration` |
| Minimum words | 1 (0 in eager) | 0 – 5 | `min_words` |
| Resume after a false interruption | on | — | `resume_false_interruption` |

## Noise reduction

LiveKit does **not** expose an intensity dial — it exposes three distinct
algorithms. Pydent's Low / Medium / High therefore map to models, not levels:

| Pydent level | LiveKit algorithm | Use for |
| --- | --- | --- |
| Low | `noise_cancellation.NC()` | background noise only |
| Medium | `noise_cancellation.BVC()` | background noise **and** background voices |
| High | `noise_cancellation.BVCTelephony()` | the same, tuned for telephony/SIP audio |

Off builds nothing at all, and the caller's audio reaches the agent unprocessed.
The mapping is repeated in the UI so nobody has to read this file to know it.

## Answering machine detection

| Setting | Default | Range | Runtime effect |
| --- | --- | --- | --- |
| Enabled | off | — | `livekit.agents.voice.amd.AMD(session, llm=, detection_options=…)`; nothing runs when off |
| Multilingual | off | — | recorded on the config; detection itself is LLM-based |
| Timeout | 10 s | 5 – 60 | `detection_options={"timeout": …}` |

On an `amd_prediction` whose category starts with `machine`, the worker hangs up
instead of talking to voicemail. Meaningful on outbound calls.

## Reminder & call duration

Enforced by worker-owned asyncio watchdogs, all cancelled in `CallLifecycle.aclose()`.

| Setting | Default | Range | Behaviour |
| --- | --- | --- | --- |
| Silence before check | 60 s | 5 – 600 | agent asks "Are you still there?" |
| Max check attempts | 4 | 1 – 10 | after this many unanswered check-ins the call ends |
| Max silence duration | 120 s | 10 – 1800 | total silence before the call ends regardless of check-ins |
| Maximum call duration | 60 min | 1 – 180 | a spoken warning ~30 s before the hard hang-up |

## Post-call data extraction

Typed fields (`text`, `number`, `boolean`, `date`, `datetime`, `enum`) are
extracted from the transcript **after** the call is stored, so extraction never
delays call termination, and the result is written to
`voice_calls.extracted_data`. Anything the transcript does not clearly state is
stored as `null` — the extractor never guesses.

Extraction only runs when privacy is set to *Store and analyze calls*.

## Privacy — data storage preference

| Value | Transcript | Messages | Analysis / extraction |
| --- | --- | --- | --- |
| `store_analyze` (default) | yes | yes | yes |
| `store_only` | yes | yes | no |
| `no_store` | no | no | no |

Metadata (time, number, duration, outcome) is always kept — the call itself works
identically in all three modes.

## Latency metrics

Collected from LiveKit's own `metrics_collected` events (nothing re-invented) and
stored per call in `voice_calls.latency_metrics`:

| Metric | Source |
| --- | --- |
| EOU delay | `EOUMetrics.end_of_utterance_delay` |
| STT | `STTMetrics.duration` |
| LLM TTFT | `LLMMetrics.ttft` |
| TTS TTFB | `TTSMetrics.ttfb` |
| End-to-end | EOU + LLM TTFT + TTS TTFB for that turn |

Each turn is also logged by the worker as
`Turn #N  EOU: …  STT: …  LLM TTFT: …  TTS TTFB: …  E2E: …`.

## Security

The config sent to the worker (and anything reaching the browser) contains only
safe values. Provider credentials — the LiveKit API secret, STT/TTS/LLM keys and
the Supabase service key — stay server-side and are never part of an agent
config. The worker authenticates to Pydent with a per-workspace worker token that
also pins it to that workspace's agents.

## Tests

```bash
npm test                                   # config contract + post-call coercion
cd livekit-agent && python test_agent.py   # worker mapping, against real livekit-agents
```
