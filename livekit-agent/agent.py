"""Pydent LiveKit worker — the ONE agent deployment that runs every Pydent voice
agent on LiveKit.

LiveKit dispatches this worker into a room (browser test call, or an inbound
phone call via a SIP dispatch rule) with job metadata {"pydentAgentId", "ws"}.
The worker asks Pydent for that agent's LIVE configuration — instructions
(with the knowledge base), greeting, STT / LLM / TTS models and voice, tool
permissions, timeouts — and runs the STT → LLM → TTS pipeline with exactly
those settings. Editing an agent in Pydent changes the very next call.

Tools (slots / book / reschedule / cancel / email) call Pydent's existing
/api/agents/tool-exec, so a phone booking lands on the Pydent + Google Calendar
just like chat. At the end of the call the transcript is posted to
/api/livekit/call-log, which shows it in Call Logs tagged "LiveKit".

Deploy once to LiveKit Cloud (see README.md): `lk agent create` in this folder.
"""

import json
import logging
import os
import time
from typing import Any

import aiohttp
from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    RunContext,
    cli,
    function_tool,
    inference,
)

load_dotenv(".env.local")
load_dotenv(".env")

logger = logging.getLogger("pydent-agent")

PYDENT_BASE = os.environ.get("PYDENT_BASE", "https://pydent.ai").rstrip("/")
WORKER_TOKEN = os.environ.get("LIVEKIT_WORKER_TOKEN", "")
AGENT_NAME = os.environ.get("AGENT_NAME", "pydent-agent")


# ── Pydent HTTP helpers ─────────────────────────────────────────────────────
async def pydent_post(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    async with aiohttp.ClientSession() as http:
        async with http.post(f"{PYDENT_BASE}{path}", json=payload, timeout=aiohttp.ClientTimeout(total=30)) as r:
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


async def run_tool(agent_id: str, name: str, args: dict[str, Any]) -> str:
    try:
        data = await pydent_post("/api/agents/tool-exec", {"agentId": agent_id, "name": name, "args": args})
        return str(data.get("result") or data.get("error") or "Tool failed.")
    except Exception as e:  # never crash the call over a tool
        return f"Error: {e}"


# ── The agent (one class, configured per call) ──────────────────────────────
class PydentAgent(Agent):
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.cfg = cfg
        tools = [self.get_available_slots, self.send_email]
        if cfg.get("canBook"):
            tools.append(self.book_appointment)
        if cfg.get("canReschedule"):
            tools.append(self.reschedule_appointment)
        if cfg.get("canCancel"):
            tools.append(self.cancel_appointment)
        super().__init__(instructions=cfg["instructions"], tools=tools)

    @function_tool()
    async def get_available_slots(self, context: RunContext, date: str, doctor: str = "", treatment: str = "") -> str:
        """Check which appointment times are open on a date (YYYY-MM-DD), optionally for a doctor or treatment."""
        return await run_tool(self.cfg["agentId"], "get_available_slots", {"date": date, "doctor": doctor, "treatment": treatment})

    @function_tool()
    async def book_appointment(
        self,
        context: RunContext,
        datetime: str,
        name: str,
        phone: str = "",
        email: str = "",
        treatment: str = "",
        doctor: str = "",
        fee: str = "",
    ) -> str:
        """Book the appointment ONLY after the caller confirmed the summary. datetime is ISO like 2026-08-08T10:00."""
        return await run_tool(
            self.cfg["agentId"],
            "book_appointment",
            {"datetime": datetime, "name": name, "phone": phone, "email": email, "treatment": treatment, "doctor": doctor, "fee": fee},
        )

    @function_tool()
    async def reschedule_appointment(self, context: RunContext, datetime: str, name: str = "", phone: str = "") -> str:
        """Move the caller's upcoming appointment to a new ISO datetime after they confirm."""
        return await run_tool(self.cfg["agentId"], "reschedule_appointment", {"datetime": datetime, "name": name, "phone": phone})

    @function_tool()
    async def cancel_appointment(self, context: RunContext, name: str = "", phone: str = "") -> str:
        """Cancel the caller's upcoming appointment after they confirm."""
        return await run_tool(self.cfg["agentId"], "cancel_appointment", {"name": name, "phone": phone})

    @function_tool()
    async def send_email(self, context: RunContext, to: str, subject: str, body: str) -> str:
        """Email the caller (only an address they gave you) a confirmation or the information they asked for."""
        return await run_tool(self.cfg["agentId"], "send_email", {"to": to, "subject": subject, "body": body})


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

    cfg = await fetch_agent_config(meta)
    logger.info("running %s (%s / %s / %s:%s)", cfg["agentName"], cfg["stt"], cfg["llm"], cfg["tts"], cfg["voice"])

    stt_kwargs: dict[str, Any] = {"model": cfg["stt"]}
    if cfg.get("sttLanguage"):
        stt_kwargs["language"] = cfg["sttLanguage"]
    session = AgentSession(
        stt=inference.STT(**stt_kwargs),
        llm=inference.LLM(model=cfg["llm"]),
        tts=inference.TTS(model=cfg["tts"], voice=cfg["voice"]),
    )

    lines: list[dict[str, Any]] = []
    caller_phone = ""

    # Post the transcript to Pydent when the call ends (shows in Call Logs).
    async def post_call_log() -> None:
        try:
            history = session.history.to_dict()  # {"items": [{"role", "content"}]}
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
                    "callerPhone": caller_phone,
                    "direction": "outbound" if "_out_" in ctx.room.name else "inbound",
                    "source": meta.get("source", ""),
                    "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)),
                    "endedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "messages": lines,
                },
            )
        except Exception as e:
            logger.warning("call-log post failed: %s", e)

    ctx.add_shutdown_callback(post_call_log)

    await session.start(agent=PydentAgent(cfg), room=ctx.room)
    await ctx.connect()

    # SIP callers carry their number as a participant attribute.
    for p in ctx.room.remote_participants.values():
        phone = (p.attributes or {}).get("sip.phoneNumber")
        if phone:
            caller_phone = phone

    if cfg.get("greetFirst") and cfg.get("greeting"):
        await session.say(cfg["greeting"], allow_interruptions=True)
    elif not cfg.get("greetFirst"):
        pass  # user speaks first
    else:
        await session.generate_reply(instructions="Greet the caller warmly in one short sentence and ask how you can help.")


if __name__ == "__main__":
    cli.run_app(server)
