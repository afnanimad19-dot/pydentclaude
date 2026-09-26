"""Pydent LiveKit worker — the ONE agent deployment that runs every Pydent voice
agent, configured per call from Pydent.

LiveKit dispatches this worker into a room (browser test call, or an inbound
phone call via a SIP dispatch rule) with job metadata {"pydentAgentId", "ws"}.
The worker fetches THAT agent's live configuration from Pydent and builds the
session from it, so editing an agent in Pydent changes the very next call.

Every setting in Pydent's Edit Agent screen maps to a real LiveKit API here:

  Pydent setting            -> LiveKit runtime
  ------------------------------------------------------------------
  STT / STT language        -> inference.STT(model=, language=)
  LLM                       -> inference.LLM(model=)
  TTS / Voice               -> inference.TTS(model=, voice=)
  VAD (4 sliders)           -> silero.VAD.load(min_speech_duration=,
                               min_silence_duration=, activation_threshold=,
                               prefix_padding_duration=)
  End of speech timeout     -> EndpointingOptions.min_delay
  Turn detection timeout    -> EndpointingOptions.max_delay
  Turn detection mode       -> EndpointingOptions.mode ("dynamic"|"fixed")
  Turn detection on/off     -> TurnHandlingOptions.turn_detection
                               (inference.TurnDetector() | "vad")
  Interruptions             -> InterruptionOptions(enabled, mode, min_duration,
                               min_words, resume_false_interruption)
                               mode "eager"->vad, "adaptive"->adaptive, "off"->disabled
  Noise reduction level     -> noise_cancellation NC() / BVC() / BVCTelephony()
  Background audio          -> BackgroundAudioPlayer(ambient_sound=BuiltinAudioClip.*)
  Answering machine det.    -> livekit.agents.voice.amd.AMD(llm=, stt=,
                               detection_options={timeout, prompt})
  Silence / call duration   -> worker-managed asyncio watchdogs
  Tools (per tool on/off)   -> only enabled tools are registered with the LLM
  Who speaks first          -> session.say(greeting) or stay silent
  Post-call extraction      -> transcript posted to Pydent, extracted there
  Privacy (data storage)    -> controls what the transcript post includes
  Latency metrics           -> official metrics_collected events

Deploy once (see README.md): `lk agent create` in this folder.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from typing import Any

import aiohttp
from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    BackgroundAudioPlayer,
    BuiltinAudioClip,
    JobContext,
    MetricsCollectedEvent,
    TurnHandlingOptions,
    cli,
    function_tool,
    inference,
    metrics as lk_metrics,
    room_io,
)

load_dotenv(".env.local")
load_dotenv(".env")

logger = logging.getLogger("pydent-agent")

PYDENT_BASE = os.environ.get("PYDENT_BASE", "https://pydent.ai").rstrip("/")


def resolve_worker_token(env: dict[str, str] | None = None) -> str:
    """The Pydent worker token from the environment.

    Reads PYDENT_WORKER_TOKEN first. The old name (LIVEKIT_WORKER_TOKEN) is
    kept as a fallback for local development, but is NOT reliable on LiveKit
    Cloud: custom agent secrets in the LIVEKIT_ namespace are silently
    dropped server-side (submitted successfully, never persisted, never
    listed) — verified against deployments #7–#9 and a manual console add.
    """
    e = os.environ if env is None else env
    return e.get("PYDENT_WORKER_TOKEN") or e.get("LIVEKIT_WORKER_TOKEN", "")


WORKER_TOKEN = resolve_worker_token()
if not WORKER_TOKEN:
    logger.warning("no worker token configured (set the PYDENT_WORKER_TOKEN secret) — Pydent API calls will be rejected")
AGENT_NAME = os.environ.get("AGENT_NAME", "pydent-agent")

# Optional plugins. The worker still runs (with LiveKit's built-in defaults) if
# they are not installed, instead of failing the call.
try:
    from livekit.plugins import silero  # type: ignore
except Exception:  # pragma: no cover - depends on deployment image
    silero = None  # type: ignore
    logger.warning("livekit-plugins-silero not installed — VAD sliders will use LiveKit defaults")

try:
    from livekit.plugins import noise_cancellation  # type: ignore
except Exception:  # pragma: no cover
    noise_cancellation = None  # type: ignore
    logger.warning("livekit-plugins-noise-cancellation not installed — noise reduction disabled")


# ── Pydent HTTP helpers ─────────────────────────────────────────────────────
async def pydent_post(path: str, payload: dict[str, Any], timeout: float = 30) -> dict[str, Any]:
    async with aiohttp.ClientSession() as http:
        async with http.post(f"{PYDENT_BASE}{path}", json=payload, timeout=aiohttp.ClientTimeout(total=timeout)) as r:
            try:
                data = await r.json()
            except Exception:
                data = {"error": await r.text()}
            if r.status >= 400:
                raise RuntimeError(data.get("error") or f"HTTP {r.status}")
            return data


async def fetch_agent_config(meta: dict[str, Any]) -> dict[str, Any]:
    data = await pydent_post(
        "/api/livekit/agent-config",
        {"token": WORKER_TOKEN, "pydentAgentId": meta.get("pydentAgentId"), "ws": meta.get("ws")},
    )
    return data["config"]


# Per-call record of tool invocations (name, latency, ok), included in the call
# log so Call Logs shows what the agent actually did. A ContextVar keeps the
# list per job — one worker process can serve several calls concurrently, and
# their tool records must never interleave.
import contextvars

_tool_calls_var: contextvars.ContextVar[list[dict[str, Any]] | None] = contextvars.ContextVar(
    "pydent_tool_calls", default=None
)


async def run_tool(agent_id: str, name: str, args: dict[str, Any]) -> str:
    started = time.monotonic()
    ok = True
    try:
        data = await pydent_post("/api/agents/tool-exec", {"agentId": agent_id, "name": name, "args": args})
        return str(data.get("result") or data.get("error") or "Tool failed.")
    except Exception as e:  # never crash the call over a tool
        ok = False
        logger.warning("tool %s failed: %s", name, e)
        return f"Error: {e}"
    finally:
        ms = round((time.monotonic() - started) * 1000)
        calls = _tool_calls_var.get()
        if calls is not None:
            calls.append({"name": name, "ms": ms, "ok": ok})
        logger.info("TOOL_CALL name=%s ok=%s ms=%s", name, ok, ms)


# ── Caller identity ──────────────────────────────────────────────────────────
# The caller's number arrives as the SIP participant attribute
# "sip.phoneNumber". It is normalized here and kept in a PRIVATE per-call
# holder (call_state) that only the tool layer reads — it is never written
# into the spoken instructions, so the agent cannot leak raw SIP attributes
# verbally, and it is only ever logged masked (last 3 digits).
def normalize_phone(raw: Any) -> str:
    """A safe phone string: '+' plus 7–15 digits (or bare digits). '' if invalid."""
    s = str(raw or "").strip()
    if not s:
        return ""
    plus = s.lstrip().startswith("+")
    digits = re.sub(r"\D", "", s)
    if not (7 <= len(digits) <= 15):
        return ""
    return ("+" + digits) if plus else digits


ASK_FOR_NUMBER = (
    "No caller number was captured on this call — ask the caller for their complete "
    "phone number (with country code), then call this tool again with it. Do not guess a number."
)


# ── Tools (only the ones enabled for this agent are registered) ──────────────
def build_tools(cfg: dict[str, Any], on_end_call, call_state: dict[str, Any] | None = None) -> list[Any]:
    """Return the LiveKit tool list for this agent.

    A tool that is switched off in Pydent is never created, so it is not in the
    LLM's tool schema at all — it cannot be invoked, not merely hidden.

    call_state carries per-call runtime facts (currently the normalized caller
    phone); when a tool is invoked without a phone argument the caller's own
    number is substituted, so lookups Just Work without the agent reading
    numbers aloud — and a lookup with NO identifiers at all never reaches the
    server.
    """
    enabled: dict[str, bool] = cfg.get("tools") or {}
    agent_id: str = cfg["agentId"]
    tools: list[Any] = []
    state: dict[str, Any] = call_state if call_state is not None else {}

    def caller_number() -> str:
        return str(state.get("caller_phone") or "")

    if enabled.get("end_call", True):

        @function_tool(name="end_call", description="End the call politely once the conversation is genuinely finished.")
        async def end_call(reason: str = "conversation finished") -> str:
            await on_end_call(reason)
            return "Call ended."

        tools.append(end_call)

    # Always available: per-turn knowledge retrieval. The initial prompt holds at
    # most ~48k chars of knowledge; this tool searches the WHOLE knowledge base
    # (documents + crawled website) server-side with the same retrieval code the
    # chat agents use, so no fact is out of reach and follow-ups can carry the
    # entity ("where did she study" -> query includes the doctor's name).
    @function_tool(
        name="search_knowledge",
        description=(
            "Search the clinic's full knowledge base (documents and website) for specific facts you cannot "
            "see in your prompt: doctor profiles, education, expertise, services, prices, policies. "
            "Include names and context in the query, e.g. 'Dr. Anmol Batria education university'."
        ),
    )
    async def search_knowledge(query: str, context: str = "") -> str:
        return await run_tool(agent_id, "search_knowledge", {"query": query, "context": context})

    tools.append(search_knowledge)

    if enabled.get("get_available_slots"):

        @function_tool(
            name="get_available_slots",
            description="Check which appointment times are open on a date (YYYY-MM-DD), optionally for a doctor or treatment.",
        )
        async def get_available_slots(date: str, doctor: str = "", treatment: str = "") -> str:
            return await run_tool(agent_id, "get_available_slots", {"date": date, "doctor": doctor, "treatment": treatment})

        tools.append(get_available_slots)

    if enabled.get("book_appointment"):

        @function_tool(
            name="book_appointment",
            description="Book the appointment ONLY after the caller confirmed the summary. datetime is ISO like 2026-08-08T10:00.",
        )
        async def book_appointment(
            datetime: str,
            name: str,
            phone: str = "",
            email: str = "",
            treatment: str = "",
            doctor: str = "",
            fee: str = "",
        ) -> str:
            phone = phone.strip() or caller_number()
            return await run_tool(
                agent_id,
                "book_appointment",
                {"datetime": datetime, "name": name, "phone": phone, "email": email, "treatment": treatment, "doctor": doctor, "fee": fee},
            )

        tools.append(book_appointment)

    if enabled.get("reschedule_appointment"):

        @function_tool(
            name="reschedule_appointment",
            description=(
                "Move an upcoming appointment to a new ISO datetime after the caller confirms. "
                "If the tool lists several upcoming appointments, ask the caller which one and call again "
                "with that exact appointment_id — never pick one yourself."
            ),
        )
        async def reschedule_appointment(datetime: str, name: str = "", phone: str = "", appointment_id: str = "") -> str:
            phone = phone.strip() or caller_number()
            return await run_tool(agent_id, "reschedule_appointment", {"datetime": datetime, "name": name, "phone": phone, "appointment_id": appointment_id})

        tools.append(reschedule_appointment)

    if enabled.get("cancel_appointment"):

        @function_tool(
            name="cancel_appointment",
            description=(
                "Cancel an upcoming appointment after the caller confirms. If the tool lists several upcoming "
                "appointments, ask the caller which one and call again with that exact appointment_id — never pick one yourself."
            ),
        )
        async def cancel_appointment(name: str = "", phone: str = "", appointment_id: str = "") -> str:
            phone = phone.strip() or caller_number()
            return await run_tool(agent_id, "cancel_appointment", {"name": name, "phone": phone, "appointment_id": appointment_id})

        tools.append(cancel_appointment)

    if enabled.get("lookup_patient"):

        @function_tool(
            name="lookup_patient",
            description=(
                "Find an existing patient record. The caller's own number (when captured from telephony) is used "
                "automatically — you may call this with no arguments at the start of the call. Otherwise pass a phone "
                "number, full name, or email."
            ),
        )
        async def lookup_patient(phone: str = "", name: str = "", email: str = "") -> str:
            phone = phone.strip() or caller_number()
            if not phone and not name.strip() and not email.strip():
                return ASK_FOR_NUMBER
            return await run_tool(agent_id, "lookup_patient", {"phone": phone, "name": name, "email": email})

        tools.append(lookup_patient)

        @function_tool(
            name="list_upcoming_appointments",
            description=(
                "List ALL of the caller's upcoming appointments (date, time, doctor, service and appointment_id). "
                "Use it before rescheduling or cancelling when the caller may have more than one."
            ),
        )
        async def list_upcoming_appointments(phone: str = "", email: str = "", patient_id: str = "") -> str:
            phone = phone.strip() or caller_number()
            if not phone and not email.strip() and not patient_id.strip():
                return ASK_FOR_NUMBER
            return await run_tool(agent_id, "list_upcoming_appointments", {"phone": phone, "email": email, "patient_id": patient_id})

        tools.append(list_upcoming_appointments)

    if enabled.get("create_patient"):

        @function_tool(name="create_patient", description="Create a new patient/lead record for a first-time caller.")
        async def create_patient(name: str, phone: str = "", email: str = "") -> str:
            return await run_tool(agent_id, "create_patient", {"name": name, "phone": phone, "email": email})

        tools.append(create_patient)

    if enabled.get("send_email"):

        @function_tool(name="send_email", description="Email the caller (only an address they gave you) a confirmation or the information they asked for.")
        async def send_email(to: str, subject: str, body: str) -> str:
            return await run_tool(agent_id, "send_email", {"to": to, "subject": subject, "body": body})

        tools.append(send_email)

    # Transfer is only offered with a VALID configured destination (E.164-style:
    # optional '+', 7–15 digits). An invalid value never becomes a tool — the
    # agent cannot invent or mangle a transfer destination.
    transfer_number = normalize_phone(cfg.get("transferNumber"))
    if str(cfg.get("transferNumber") or "").strip() and not transfer_number:
        logger.warning("transfer number configured but not a valid phone — transfer_call NOT registered")
    if enabled.get("transfer_call") and transfer_number:

        @function_tool(name="transfer_call", description="Transfer the caller to a human at the clinic when they ask for a person or you cannot help.")
        async def transfer_call() -> str:
            from livekit.agents import get_job_context

            try:
                jctx = get_job_context()
                participant = next(iter(jctx.room.remote_participants.values()), None)
                if participant is None:
                    return "No caller to transfer."
                await jctx.transfer_sip_participant(participant, f"tel:{transfer_number}")
                return "Transferring now."
            except Exception as e:
                logger.warning("transfer failed: %s", e)
                return f"Could not transfer the call: {e}"

        tools.append(transfer_call)

    logger.info("tools registered: %s", [getattr(getattr(t, "info", None), "name", "?") for t in tools])
    return tools


class PydentAgent(Agent):
    def __init__(self, cfg: dict[str, Any], tools: list[Any]) -> None:
        super().__init__(instructions=cfg["instructions"], tools=tools)


# ── Latency metrics (official LiveKit metrics events) ───────────────────────
class LatencyTracker:
    """Collects per-turn EOU / STT / LLM TTFT / TTS TTFB and the end-to-end
    'caller stopped speaking -> agent audio starts' time, from LiveKit's own
    metrics events (no re-invention)."""

    def __init__(self) -> None:
        self.turns: list[dict[str, float | int]] = []
        self._cur: dict[str, float] = {}
        self._turn = 0
        # STT for a turn is reported BEFORE the end-of-utterance event that opens
        # the turn's window, so it is parked here and carried in on EOU.
        self._pending_stt = 0.0

    def on_metrics(self, m: Any) -> None:
        try:
            if isinstance(m, lk_metrics.EOUMetrics):
                # A new user turn ended — start a new measurement window.
                self._flush()
                self._turn += 1
                self._cur = {
                    "eou": round(float(getattr(m, "end_of_utterance_delay", 0.0) or 0.0), 3),
                    "transcription_delay": round(float(getattr(m, "transcription_delay", 0.0) or 0.0), 3),
                    "stt": self._pending_stt,
                }
                self._pending_stt = 0.0
            elif isinstance(m, lk_metrics.STTMetrics):
                d = round(float(getattr(m, "duration", 0.0) or 0.0), 3)
                # Before EOU -> park it for the turn about to open; after EOU
                # (streaming STT flushing late) -> attach it to the open turn.
                if self._cur:
                    self._cur["stt"] = d
                else:
                    self._pending_stt = d
            elif isinstance(m, lk_metrics.LLMMetrics):
                if not getattr(m, "cancelled", False):
                    self._cur["llm_ttft"] = round(float(getattr(m, "ttft", 0.0) or 0.0), 3)
            elif isinstance(m, lk_metrics.TTSMetrics):
                if not getattr(m, "cancelled", False):
                    self._cur["tts_ttfb"] = round(float(getattr(m, "ttfb", 0.0) or 0.0), 3)
                    self._flush()  # audio started -> the turn is complete
        except Exception as e:  # metrics must never break a call
            logger.debug("metrics error: %s", e)

    def _flush(self) -> None:
        if not self._cur:
            return
        c = self._cur
        e2e = round(c.get("eou", 0.0) + c.get("llm_ttft", 0.0) + c.get("tts_ttfb", 0.0), 3)
        turn = {
            "turn": self._turn,
            "eou": c.get("eou", 0.0),
            "stt": c.get("stt", 0.0),
            "llm_ttft": c.get("llm_ttft", 0.0),
            "tts_ttfb": c.get("tts_ttfb", 0.0),
            "e2e": e2e,
        }
        self.turns.append(turn)
        logger.info(
            "Turn #%s  EOU: %.2fs  STT: %.2fs  LLM TTFT: %.2fs  TTS TTFB: %.2fs  E2E: %.2fs",
            turn["turn"], turn["eou"], turn["stt"], turn["llm_ttft"], turn["tts_ttfb"], turn["e2e"],
        )
        self._cur = {}

    def summary(self) -> dict[str, Any]:
        self._flush()
        if not self.turns:
            return {"turns": []}

        def avg(key: str) -> float:
            vals = [float(t[key]) for t in self.turns if float(t[key]) > 0]
            return round(sum(vals) / len(vals), 3) if vals else 0.0

        return {
            "turns": self.turns[-50:],
            "averages": {k: avg(k) for k in ("eou", "stt", "llm_ttft", "tts_ttfb", "e2e")},
            "turn_count": len(self.turns),
        }


# ── Config -> LiveKit option builders ───────────────────────────────────────
def build_vad(cfg: dict[str, Any]):
    """Pydent's four VAD sliders -> silero.VAD.load(). Returns None when the
    plugin isn't available (LiveKit then uses its own defaults)."""
    if silero is None:
        return None
    v = cfg.get("vad") or {}
    try:
        return silero.VAD.load(
            min_speech_duration=float(v.get("minSpeechDuration", 0.1)),
            min_silence_duration=float(v.get("minSilenceDuration", 0.3)),
            activation_threshold=float(v.get("activationThreshold", 0.5)),
            prefix_padding_duration=float(v.get("prefixPaddingDuration", 0.3)),
        )
    except Exception as e:
        logger.warning("VAD load failed (%s) — falling back to defaults", e)
        return None


def build_turn_handling(cfg: dict[str, Any]) -> TurnHandlingOptions:
    td = cfg.get("turnDetection") or {}
    enabled = bool(td.get("enabled", True))
    mode = str(td.get("mode", "smart"))
    min_delay = float(td.get("endOfSpeechTimeout", 0.2))
    max_delay = float(td.get("timeout", 2.0))
    if max_delay < min_delay:  # defensive: server validates, but never invert
        max_delay = min_delay + 0.5

    # Turn detection ON  -> LiveKit's semantic turn detector decides when the
    #                       caller is done (falls back to VAD if unavailable).
    # Turn detection OFF -> plain VAD endpointing. Barge-in is unaffected either
    #                       way because interruptions are configured separately.
    turn_detection: Any = inference.TurnDetector() if enabled else "vad"

    # Barge-in. `interruptionOptions` carries the values set per agent in Pydent;
    # `interruptions` is the older bare string and is used when the object is
    # absent, so a config written by an earlier Pydent build still works.
    iopts = cfg.get("interruptionOptions") or {}
    # NB: named imode, not mode — `mode` above is the turn-detection mode.
    imode = str(iopts.get("mode") or cfg.get("interruptions") or "adaptive")
    if imode == "off":
        interruption = {"enabled": False}
    else:
        # Eager reacts on raw voice activity (mode="vad"); adaptive waits for the
        # caller to actually say something (mode="adaptive"), which is what keeps
        # a cough or a door closing from cutting the agent off.
        eager = imode == "eager"
        interruption = {
            "enabled": True,
            "mode": "vad" if eager else "adaptive",
            "min_duration": float(iopts.get("minDuration", 0.2 if eager else 0.5)),
            "min_words": int(iopts.get("minWords", 0 if eager else 1)),
            "resume_false_interruption": bool(iopts.get("resumeFalseInterruption", True)),
            "false_interruption_timeout": 2.0,
        }

    return TurnHandlingOptions(
        turn_detection=turn_detection,
        endpointing={
            "mode": "dynamic" if mode == "smart" else "fixed",
            "min_delay": min_delay,
            "max_delay": max_delay,
        },
        interruption=interruption,
    )


def build_noise_cancellation(cfg: dict[str, Any]):
    """Pydent's Low / Medium / High -> LiveKit's three real algorithms.

    LiveKit does not expose an intensity dial; it exposes distinct models, so
    the levels are mapped (and documented in the UI):
        low    -> NC()            standard background-noise removal
        medium -> BVC()           also removes background *voices*
        high   -> BVCTelephony()  BVC tuned for narrowband phone audio
    """
    noise = cfg.get("noise") or {}
    if not noise.get("enabled") or noise_cancellation is None:
        return None
    level = str(noise.get("level", "medium"))
    try:
        if level == "low":
            return noise_cancellation.NC()
        if level == "high":
            return noise_cancellation.BVCTelephony()
        return noise_cancellation.BVC()
    except Exception as e:
        logger.warning("noise cancellation unavailable: %s", e)
        return None


_BG_CLIPS = {
    "office": "OFFICE_AMBIENCE",
    "city": "CITY_AMBIENCE",
    "crowd": "CROWDED_ROOM",
    "forest": "FOREST_AMBIENCE",
}


def build_background_audio(cfg: dict[str, Any]) -> BackgroundAudioPlayer | None:
    choice = str(cfg.get("backgroundAudio", "none"))
    clip_name = _BG_CLIPS.get(choice)
    if not clip_name:
        return None
    clip = getattr(BuiltinAudioClip, clip_name, None)
    if clip is None:
        return None
    return BackgroundAudioPlayer(ambient_sound=clip)


MULTILINGUAL_AMD_NOTE = (
    "\n\nThe greeting may be in ANY language (Arabic, Hindi, Urdu, Russian, French, ...). "
    "Classify by meaning, not by language: a recorded voicemail greeting in another language is "
    "still machine-vm, and a menu asking the caller to press a key is still machine-ivr."
)


def build_amd_kwargs(cfg: dict[str, Any]) -> dict[str, Any]:
    """Answering-machine detection options for this agent.

    Multilingual AMD is not a flag LiveKit exposes, so it is implemented: the
    greeting is transcribed with the agent's own (language-aware) STT instead of
    AMD's English-tuned default, and the classifier prompt is extended to say the
    greeting may be in any language.
    """
    amd_cfg = cfg.get("amd") or {}
    options: dict[str, Any] = {"timeout": float(amd_cfg.get("timeout", 10))}
    kwargs: dict[str, Any] = {"llm": cfg["llm"], "detection_options": options}
    if amd_cfg.get("multilingual"):
        from livekit.agents.voice.amd.detector import AMD_PROMPT

        kwargs["stt"] = cfg["stt"]
        options["prompt"] = AMD_PROMPT + MULTILINGUAL_AMD_NOTE
    return kwargs


# ── Call lifecycle watchdogs (silence + maximum duration) ───────────────────
class CallLifecycle:
    """Silence check-ins and the hard call-duration limit.

    All timers are asyncio tasks owned here and cancelled in aclose(), so
    nothing keeps running after the call disconnects.
    """

    def __init__(self, session: AgentSession, cfg: dict[str, Any], end_call) -> None:
        limits = cfg.get("limits") or {}
        self.session = session
        self.end_call = end_call
        self.silence_before_check = float(limits.get("silenceBeforeCheck", 60))
        self.max_attempts = int(limits.get("maxCheckAttempts", 4))
        self.max_silence = float(limits.get("maxSilenceDuration", 120))
        self.max_call_seconds = float(limits.get("maxCallMinutes", 60)) * 60
        self.attempts = 0
        self.last_activity = time.monotonic()
        self._tasks: list[asyncio.Task] = []
        self._closed = False

    def note_activity(self) -> None:
        self.last_activity = time.monotonic()
        self.attempts = 0

    def start(self) -> None:
        self._tasks.append(asyncio.create_task(self._silence_watchdog(), name="pydent_silence"))
        self._tasks.append(asyncio.create_task(self._duration_watchdog(), name="pydent_duration"))

    async def _silence_watchdog(self) -> None:
        try:
            while not self._closed:
                await asyncio.sleep(1.0)
                quiet = time.monotonic() - self.last_activity
                if quiet >= self.max_silence:
                    logger.info("ending call: %.0fs total silence >= max %.0fs", quiet, self.max_silence)
                    await self.end_call("max silence reached")
                    return
                if quiet >= self.silence_before_check * (self.attempts + 1):
                    if self.attempts >= self.max_attempts:
                        logger.info("ending call: %s silence check-ins unanswered", self.attempts)
                        await self.end_call("no response after check-ins")
                        return
                    self.attempts += 1
                    logger.info("silence check-in %s/%s after %.0fs", self.attempts, self.max_attempts, quiet)
                    try:
                        await self.session.say("Are you still there?", allow_interruptions=True)
                    except Exception as e:
                        logger.debug("check-in say failed: %s", e)
        except asyncio.CancelledError:
            pass

    async def _duration_watchdog(self) -> None:
        try:
            warn_at = max(0.0, self.max_call_seconds - 30)
            if warn_at > 0:
                await asyncio.sleep(warn_at)
                if self._closed:
                    return
                try:
                    await self.session.say(
                        "We're coming up on the end of the time I have for this call.",
                        allow_interruptions=True,
                    )
                except Exception:
                    pass
            await asyncio.sleep(max(0.0, self.max_call_seconds - warn_at))
            if not self._closed:
                logger.info("ending call: maximum duration %.0f min reached", self.max_call_seconds / 60)
                await self.end_call("maximum call duration reached")
        except asyncio.CancelledError:
            pass

    async def aclose(self) -> None:
        self._closed = True
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        self._tasks.clear()


# ── Worker entrypoint ───────────────────────────────────────────────────────
server = AgentServer()


@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: JobContext):
    started = time.time()
    meta: dict[str, Any] = {}
    try:
        meta = json.loads(ctx.job.metadata or "{}")
    except Exception:
        logger.warning("job metadata was not JSON: %r", ctx.job.metadata)
    ctx.log_context_fields = {"room": ctx.room.name, "agent": meta.get("pydentAgentId")}

    # Configuration is resolved PER CALL for THIS agent — never cached globally.
    tool_calls: list[dict[str, Any]] = []
    _tool_calls_var.set(tool_calls)
    cfg = await fetch_agent_config(meta)
    logger.info(
        "call config: %s | stt=%s llm=%s tts=%s:%s | turn=%s/%s interruptions=%s noise=%s bg=%s",
        cfg["agentName"], cfg["stt"], cfg["llm"], cfg["tts"], cfg["voice"],
        (cfg.get("turnDetection") or {}).get("enabled"), (cfg.get("turnDetection") or {}).get("mode"),
        cfg.get("interruptions"), (cfg.get("noise") or {}).get("enabled") and (cfg.get("noise") or {}).get("level"),
        cfg.get("backgroundAudio"),
    )

    stt_kwargs: dict[str, Any] = {"model": cfg["stt"]}
    if cfg.get("sttLanguage"):
        stt_kwargs["language"] = cfg["sttLanguage"]

    session_kwargs: dict[str, Any] = {
        "stt": inference.STT(**stt_kwargs),
        "llm": inference.LLM(model=cfg["llm"]),
        "tts": inference.TTS(model=cfg["tts"], voice=cfg["voice"]),
        "turn_handling": build_turn_handling(cfg),
    }
    vad = build_vad(cfg)
    if vad is not None:
        session_kwargs["vad"] = vad

    session = AgentSession(**session_kwargs)

    tracker = LatencyTracker()
    lifecycle: CallLifecycle | None = None
    bg_player: BackgroundAudioPlayer | None = None
    closing = asyncio.Event()

    async def end_call(reason: str) -> None:
        if closing.is_set():
            return
        closing.set()
        logger.info("ending call (%s)", reason)
        try:
            await session.aclose()
        except Exception as e:
            logger.debug("session close: %s", e)
        try:
            ctx.shutdown(reason=reason)
        except Exception:
            pass

    lifecycle = CallLifecycle(session, cfg, end_call)

    # Any speech from either side counts as activity for the silence watchdog.
    @session.on("user_input_transcribed")
    def _on_user_input(_ev: Any) -> None:
        lifecycle.note_activity()

    @session.on("conversation_item_added")
    def _on_item(_ev: Any) -> None:
        lifecycle.note_activity()

    @session.on("metrics_collected")
    def _on_metrics(ev: MetricsCollectedEvent) -> None:
        tracker.on_metrics(ev.metrics)

    lines: list[dict[str, Any]] = []
    # Per-call private runtime state shared with the tool layer (never spoken,
    # never logged in full). The SIP caller number lands here once known.
    call_state: dict[str, Any] = {"caller_phone": ""}

    async def post_call_log() -> None:
        """Send the call to Pydent. Privacy setting decides what is included."""
        if lifecycle is not None:
            await lifecycle.aclose()
        if bg_player is not None:
            try:
                await bg_player.aclose()
            except Exception:
                pass

        privacy = (cfg.get("privacy") or {}).get("dataStorage", "store_analyze")
        store_transcript = privacy in ("store_analyze", "store_only")
        analyze = privacy == "store_analyze"

        if store_transcript:
            try:
                history = session.history.to_dict()
                for item in history.get("items", []):
                    role = item.get("role")
                    content = item.get("content")
                    if role not in ("user", "assistant") or not content:
                        continue
                    text = " ".join(c for c in content if isinstance(c, str)) if isinstance(content, list) else str(content)
                    if text.strip():
                        lines.append({"role": role, "text": text.strip()})
            except Exception as e:
                logger.warning("could not read session history: %s", e)

        try:
            await pydent_post(
                "/api/livekit/call-log",
                {
                    "token": WORKER_TOKEN,
                    "ws": cfg["ws"],
                    "room": ctx.room.name,
                    "agentName": cfg["agentName"],
                    "agentId": cfg["agentId"],
                    "callerPhone": str(call_state.get("caller_phone") or ""),
                    "direction": "outbound" if "_out_" in ctx.room.name else "inbound",
                    "source": meta.get("source", ""),
                    "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)),
                    "endedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "messages": lines,
                    "latencyMetrics": tracker.summary(),
                    "structuredData": {"toolCalls": list(tool_calls)},
                    "configVersion": cfg.get("configVersion", 1),
                    # Pydent runs the configured extraction when analysis is allowed.
                    "analyze": analyze,
                    "extractionFields": cfg.get("extractionFields") or [] if analyze else [],
                    "privacy": privacy,
                },
                timeout=60,
            )
        except Exception as e:
            logger.warning("call-log post failed: %s", e)

    ctx.add_shutdown_callback(post_call_log)

    tools = build_tools(cfg, end_call, call_state)

    room_options = None
    nc = build_noise_cancellation(cfg)
    if nc is not None:
        room_options = room_io.RoomOptions(audio_input=room_io.AudioInputOptions(noise_cancellation=nc))

    start_kwargs: dict[str, Any] = {"agent": PydentAgent(cfg, tools), "room": ctx.room}
    if room_options is not None:
        start_kwargs["room_options"] = room_options
    await session.start(**start_kwargs)
    await ctx.connect()

    # Ambient background audio, if the agent asked for it.
    bg_player = build_background_audio(cfg)
    if bg_player is not None:
        try:
            await bg_player.start(room=ctx.room, agent_session=session)
        except Exception as e:
            logger.warning("background audio failed to start: %s", e)
            bg_player = None

    # Answering machine detection — meaningful on OUTBOUND calls. When enabled
    # and a machine is detected we hang up rather than talk to voicemail; when
    # disabled nothing runs at all.
    amd_cfg = cfg.get("amd") or {}
    is_outbound = "_out_" in ctx.room.name
    if amd_cfg.get("enabled") and not is_outbound:
        logger.info("AMD enabled but this is an inbound call — not started")
    if amd_cfg.get("enabled") and is_outbound:
        try:
            from livekit.agents.voice.amd import AMD  # imported lazily

            detector = AMD(session, **build_amd_kwargs(cfg))

            @detector.on("amd_prediction")
            def _on_amd(ev: Any) -> None:
                logger.info("AMD: category=%s reason=%s", getattr(ev, "category", "?"), getattr(ev, "reason", ""))
                category = str(getattr(ev, "category", ""))
                if category.startswith("machine"):
                    asyncio.create_task(end_call(f"answering machine detected ({category})"))

            await detector.start()
        except Exception as e:
            logger.warning("AMD unavailable: %s", e)

    # Capture the caller's number from the SIP participant attribute —
    # normalized, held privately in call_state for the tools and the call log,
    # and logged only masked. Also watch for a participant that connects after
    # us (rare for inbound SIP, but free to handle).
    def _capture_caller(p: Any) -> None:
        phone = normalize_phone((p.attributes or {}).get("sip.phoneNumber"))
        if phone and not call_state.get("caller_phone"):
            call_state["caller_phone"] = phone
            logger.info("caller number captured (ends …%s)", phone[-3:])

    for p in ctx.room.remote_participants.values():
        _capture_caller(p)

    @ctx.room.on("participant_connected")
    def _on_participant(p: Any) -> None:
        _capture_caller(p)

    lifecycle.start()

    # Who speaks first.
    if cfg.get("greetFirst"):
        greeting = str(cfg.get("greeting") or "").strip()
        if greeting:
            await session.say(greeting, allow_interruptions=True)
        else:
            await session.generate_reply(instructions="Greet the caller warmly in one short sentence and ask how you can help.")
    # Caller speaks first -> stay silent and wait.


if __name__ == "__main__":
    cli.run_app(server)
