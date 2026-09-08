"""Tests for the Pydent LiveKit worker's config -> runtime mapping.

These exercise the real livekit-agents API (no mocks of LiveKit itself), so a
green run means the settings edited in Pydent genuinely reach the objects the
session is built from.

    python -m pip install -r requirements.txt
    python -m pytest test_agent.py        # or: python test_agent.py
"""

from __future__ import annotations

import asyncio
import os
import sys
import unittest

os.environ.setdefault("LIVEKIT_WORKER_TOKEN", "test-token")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import agent as A  # noqa: E402


def base_cfg(**over):
    cfg = {
        "agentId": "agent-1",
        "agentName": "Nora",
        "ws": "ws-1",
        "instructions": "be helpful",
        "greeting": "Hello.",
        "greetFirst": True,
        "stt": "deepgram/nova-3",
        "llm": "openai/gpt-4o-mini",
        "tts": "cartesia/sonic-3",
        "voice": "v1",
        "vad": {
            "minSpeechDuration": 0.1,
            "minSilenceDuration": 0.3,
            "activationThreshold": 0.5,
            "prefixPaddingDuration": 0.3,
        },
        "turnDetection": {"enabled": True, "mode": "smart", "timeout": 2.0, "endOfSpeechTimeout": 0.2},
        "interruptions": "adaptive",
        "noise": {"enabled": False, "level": "medium"},
        "backgroundAudio": "none",
        "amd": {"enabled": False, "multilingual": False, "timeout": 10},
        "limits": {"silenceBeforeCheck": 60, "maxCheckAttempts": 4, "maxSilenceDuration": 120, "maxCallMinutes": 60},
        "tools": {"end_call": True},
        "transferNumber": "",
        "transferMessage": "",
        "extractionFields": [],
        "privacy": {"dataStorage": "store_analyze"},
        "configVersion": 1,
    }
    cfg.update(over)
    return cfg


def tool_names(tools):
    return sorted(t.info.name for t in tools)


async def _noop(_reason: str) -> None:
    return None


class ToolGating(unittest.TestCase):
    def test_only_enabled_tools_are_created(self):
        cfg = base_cfg(tools={"end_call": True, "get_available_slots": True, "book_appointment": True, "send_email": True})
        self.assertEqual(tool_names(A.build_tools(cfg, _noop)), ["book_appointment", "end_call", "get_available_slots", "send_email"])

    def test_a_disabled_tool_is_absent_from_the_llm_schema(self):
        cfg = base_cfg(tools={"end_call": True, "get_available_slots": True, "book_appointment": False})
        names = tool_names(A.build_tools(cfg, _noop))
        self.assertNotIn("book_appointment", names)
        self.assertIn("get_available_slots", names)

    def test_end_call_is_always_registered(self):
        self.assertIn("end_call", tool_names(A.build_tools(base_cfg(tools={}), _noop)))

    def test_transfer_needs_a_number(self):
        no_num = base_cfg(tools={"end_call": True, "transfer_call": True}, transferNumber="")
        self.assertNotIn("transfer_call", tool_names(A.build_tools(no_num, _noop)))
        with_num = base_cfg(tools={"end_call": True, "transfer_call": True}, transferNumber="+97141234567")
        self.assertIn("transfer_call", tool_names(A.build_tools(with_num, _noop)))


class TurnHandling(unittest.TestCase):
    def test_smart_mode_is_dynamic_endpointing_with_the_configured_delays(self):
        th = A.build_turn_handling(base_cfg())
        ep = dict(th["endpointing"])
        self.assertEqual(ep["mode"], "dynamic")
        self.assertAlmostEqual(ep["min_delay"], 0.2)
        self.assertAlmostEqual(ep["max_delay"], 2.0)
        self.assertIsNot(th["turn_detection"], "vad")

    def test_fixed_mode_and_custom_delays_reach_endpointing(self):
        cfg = base_cfg(turnDetection={"enabled": True, "mode": "fixed", "timeout": 4.5, "endOfSpeechTimeout": 0.75})
        ep = dict(A.build_turn_handling(cfg)["endpointing"])
        self.assertEqual(ep["mode"], "fixed")
        self.assertAlmostEqual(ep["min_delay"], 0.75)
        self.assertAlmostEqual(ep["max_delay"], 4.5)

    def test_turn_detection_off_falls_back_to_vad(self):
        cfg = base_cfg(turnDetection={"enabled": False, "mode": "smart", "timeout": 2.0, "endOfSpeechTimeout": 0.2})
        self.assertEqual(A.build_turn_handling(cfg)["turn_detection"], "vad")

    def test_inverted_delays_are_repaired_not_passed_through(self):
        cfg = base_cfg(turnDetection={"enabled": True, "mode": "smart", "timeout": 0.1, "endOfSpeechTimeout": 2.0})
        ep = dict(A.build_turn_handling(cfg)["endpointing"])
        self.assertGreater(ep["max_delay"], ep["min_delay"])


class Interruptions(unittest.TestCase):
    def test_off_disables_barge_in(self):
        th = A.build_turn_handling(base_cfg(interruptions="off"))
        self.assertFalse(dict(th["interruption"])["enabled"])

    def test_legacy_string_still_works(self):
        th = A.build_turn_handling(base_cfg(interruptions="eager"))
        i = dict(th["interruption"])
        self.assertTrue(i["enabled"])
        self.assertEqual(i["mode"], "vad")

    def test_structured_options_win_over_the_legacy_string(self):
        cfg = base_cfg(
            interruptions="eager",
            interruptionOptions={"mode": "adaptive", "minDuration": 0.9, "minWords": 3, "resumeFalseInterruption": False},
        )
        i = dict(A.build_turn_handling(cfg)["interruption"])
        self.assertEqual(i["mode"], "adaptive")
        self.assertAlmostEqual(i["min_duration"], 0.9)
        self.assertEqual(i["min_words"], 3)
        self.assertFalse(i["resume_false_interruption"])


class NoiseAndBackground(unittest.TestCase):
    def test_disabled_noise_reduction_builds_nothing(self):
        self.assertIsNone(A.build_noise_cancellation(base_cfg(noise={"enabled": False, "level": "high"})))

    def test_each_level_maps_to_a_distinct_algorithm(self):
        if A.noise_cancellation is None:
            self.skipTest("livekit-plugins-noise-cancellation not installed")
        built = {}
        for level in ("low", "medium", "high"):
            nc = A.build_noise_cancellation(base_cfg(noise={"enabled": True, "level": level}))
            self.assertIsNotNone(nc, level)
            built[level] = nc.model if hasattr(nc, "model") else repr(nc)
        self.assertEqual(len({str(v) for v in built.values()}), 3, f"levels must differ: {built}")

    def test_background_audio_none_builds_no_player(self):
        self.assertIsNone(A.build_background_audio(base_cfg(backgroundAudio="none")))
        self.assertIsNone(A.build_background_audio(base_cfg(backgroundAudio="airhorn")))

    def test_background_audio_builds_a_player_inside_a_loop(self):
        async def go():
            # BackgroundAudioPlayer schedules a task, so it needs a running loop.
            return A.build_background_audio(base_cfg(backgroundAudio="office"))

        player = asyncio.run(go())
        self.assertIsNotNone(player)


class Amd(unittest.TestCase):
    def test_timeout_reaches_detection_options(self):
        k = A.build_amd_kwargs(base_cfg(amd={"enabled": True, "multilingual": False, "timeout": 25}))
        self.assertAlmostEqual(k["detection_options"]["timeout"], 25.0)
        self.assertNotIn("stt", k, "English-only AMD keeps LiveKit's default transcriber")
        self.assertNotIn("prompt", k["detection_options"])

    def test_multilingual_swaps_in_the_agent_stt_and_extends_the_prompt(self):
        cfg = base_cfg(amd={"enabled": True, "multilingual": True, "timeout": 10}, stt="deepgram/nova-3")
        k = A.build_amd_kwargs(cfg)
        self.assertEqual(k["stt"], "deepgram/nova-3")
        prompt = k["detection_options"]["prompt"]
        self.assertIn("machine-vm", prompt, "the stock classification prompt is kept")
        self.assertIn("ANY language", prompt)


class VadSliders(unittest.TestCase):
    def test_sliders_reach_silero(self):
        if A.silero is None:
            self.skipTest("livekit-plugins-silero not installed")
        cfg = base_cfg(vad={
            "minSpeechDuration": 0.25,
            "minSilenceDuration": 0.8,
            "activationThreshold": 0.7,
            "prefixPaddingDuration": 0.6,
        })
        vad = A.build_vad(cfg)
        self.assertIsNotNone(vad)
        opts = getattr(vad, "_opts", None)
        if opts is None:
            self.skipTest("silero VAD does not expose its options on this version")
        self.assertAlmostEqual(float(opts.min_speech_duration), 0.25)
        self.assertAlmostEqual(float(opts.min_silence_duration), 0.8)
        self.assertAlmostEqual(float(opts.activation_threshold), 0.7)
        self.assertAlmostEqual(float(opts.prefix_padding_duration), 0.6)


class Latency(unittest.TestCase):
    def test_per_turn_metrics_are_collected_from_the_official_events(self):
        from livekit.agents.metrics import EOUMetrics, LLMMetrics, STTMetrics, TTSMetrics

        t = A.LatencyTracker()
        t.on_metrics(STTMetrics(label="stt", request_id="r", timestamp=0.0, duration=0.18, audio_duration=1.0, streamed=True))
        t.on_metrics(EOUMetrics(timestamp=0.0, end_of_utterance_delay=0.42, transcription_delay=0.1, on_user_turn_completed_delay=0.0, speech_id="s1"))
        t.on_metrics(LLMMetrics(
            label="llm", request_id="r", timestamp=0.0, duration=0.9, ttft=0.51, cancelled=False,
            completion_tokens=10, prompt_tokens=20, prompt_cached_tokens=0, total_tokens=30,
            tokens_per_second=11.0, speech_id="s1",
        ))
        t.on_metrics(TTSMetrics(
            label="tts", request_id="r", timestamp=0.0, ttfb=0.21, duration=0.5,
            audio_duration=1.2, cancelled=False, characters_count=40, streamed=True, speech_id="s1",
        ))
        s = t.summary()
        turn = s["turns"][0]
        self.assertAlmostEqual(turn["eou"], 0.42)
        self.assertAlmostEqual(turn["stt"], 0.18)
        self.assertAlmostEqual(turn["llm_ttft"], 0.51)
        self.assertAlmostEqual(turn["tts_ttfb"], 0.21)
        # End-to-end is the sum of the stages the caller actually waits through.
        self.assertGreater(turn["e2e"], 0.9)

    def test_summary_of_an_empty_call_is_safe(self):
        s = A.LatencyTracker().summary()
        self.assertEqual(s["turns"], [])


class FakeSession:
    """Just enough AgentSession surface for the lifecycle watchdogs."""

    def __init__(self):
        self.said: list[str] = []

    async def say(self, text, **_kw):
        self.said.append(text)


class Lifecycle(unittest.IsolatedAsyncioTestCase):
    async def test_check_ins_then_end_call(self):
        session = FakeSession()
        ended: list[str] = []

        async def end(reason):
            ended.append(reason)

        cfg = base_cfg(limits={"silenceBeforeCheck": 1, "maxCheckAttempts": 2, "maxSilenceDuration": 30, "maxCallMinutes": 60})
        lc = A.CallLifecycle(session, cfg, end)
        lc.start()
        await asyncio.sleep(3.6)
        await lc.aclose()
        self.assertGreaterEqual(len(session.said), 2)
        self.assertEqual(session.said[0], "Are you still there?")
        self.assertEqual(ended, ["no response after check-ins"])

    async def test_activity_resets_the_silence_timer(self):
        session = FakeSession()
        ended: list[str] = []

        async def end(reason):
            ended.append(reason)

        cfg = base_cfg(limits={"silenceBeforeCheck": 2, "maxCheckAttempts": 2, "maxSilenceDuration": 30, "maxCallMinutes": 60})
        lc = A.CallLifecycle(session, cfg, end)
        lc.start()
        for _ in range(4):
            await asyncio.sleep(0.6)
            lc.note_activity()
        await lc.aclose()
        self.assertEqual(session.said, [])
        self.assertEqual(ended, [])

    async def test_max_silence_ends_the_call_even_mid_check_ins(self):
        session = FakeSession()
        ended: list[str] = []

        async def end(reason):
            ended.append(reason)

        cfg = base_cfg(limits={"silenceBeforeCheck": 1, "maxCheckAttempts": 50, "maxSilenceDuration": 2, "maxCallMinutes": 60})
        lc = A.CallLifecycle(session, cfg, end)
        lc.start()
        await asyncio.sleep(3.2)
        await lc.aclose()
        self.assertEqual(ended, ["max silence reached"])

    async def test_duration_limit_warns_then_ends(self):
        session = FakeSession()
        ended: list[str] = []

        async def end(reason):
            ended.append(reason)

        # 30s max -> warn_at = max(0, 30-30) = 0, so the warning is immediate
        # and the hang-up follows the full window.
        cfg = base_cfg(limits={"silenceBeforeCheck": 600, "maxCheckAttempts": 4, "maxSilenceDuration": 600, "maxCallMinutes": 0.05})
        lc = A.CallLifecycle(session, cfg, end)
        lc.start()
        await asyncio.sleep(4.0)
        await lc.aclose()
        self.assertEqual(ended, ["maximum call duration reached"])

    async def test_aclose_cancels_every_timer(self):
        session = FakeSession()
        cfg = base_cfg(limits={"silenceBeforeCheck": 1, "maxCheckAttempts": 1, "maxSilenceDuration": 5, "maxCallMinutes": 1})
        lc = A.CallLifecycle(session, cfg, _noop)
        lc.start()
        tasks = list(lc._tasks)
        await lc.aclose()
        self.assertTrue(all(t.done() for t in tasks))
        self.assertEqual(lc._tasks, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
