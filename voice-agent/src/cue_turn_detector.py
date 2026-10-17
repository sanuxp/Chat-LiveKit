"""Turn detector backed by Pype/cue-v1 served via a llama.cpp (OpenAI-compatible) server.

Plugs into AgentSession(turn_detection=...) using LiveKit's turn-detector protocol:
``predict_end_of_turn`` returns P(caller is finished); when it falls below
``unlikely_threshold`` the session waits ``max_endpointing_delay`` instead of the minimum.

Run the server with:
    llama-server -m cue-v1-q8_0.gguf -c 8192 -np 4 -ngl 999 --jinja --port 8090
and set CUE_SERVER_URL (default http://localhost:8090).
"""

import asyncio
import math
import os
import time

import httpx
from livekit.agents import llm

from .log import setup_logger

logger = setup_logger("cue_turn_detector")

_LABELS = {"A": "DONE", "B": "LIKELY_DONE", "C": "MID_THOUGHT", "D": "HOLDING"}

# Rebuilt from prompts/end_of_turn_phone.json in the Pype/cue-v1 repo.
_SYSTEM_PROMPT = """\
The caller has paused on a phone call with an agent. Is it the agent's turn now? The caller is done once they have asked their question, made their request, or answered what the agent asked (even in a different form than asked: a name, a date, a code read out), in a complete sentence. They are not done if the last words leave the sentence hanging, if they are partway through reading out a number, or if they have only greeted, given their name or set the scene without yet saying what they want. How the transcript ends is given below: a question mark almost always means they are done; no sentence end usually means more is coming.

Options:
A. DONE - finished: they asked a question, made a request, answered the agent, or confirmed or declined, in a complete sentence. Reply now
B. LIKELY_DONE - probably finished: a complete answer or statement that might still get one more sentence
C. MID_THOUGHT - not finished: the sentence is left hanging (it stops on 'and', 'the', 'with', 'for', a repeated word, or a noun that needs more), a number is only partly read out, or they have only greeted, given their name or the background, without yet saying what they want. They will continue
D. HOLDING - telling something long, a story or an explanation: a pause is them thinking. They will continue

Examples:
agent_question: How can I help you today? | caller_text: Hi, this is Priya. | transcript_end: a full stop -> C
agent_question: How can I help you today? | caller_text: Hello, I booked a room with you last week and I need to change the dates. | transcript_end: a full stop -> A
agent_question: How can I help you today? | caller_text: Is there a slot on Friday morning? | transcript_end: a question mark -> A
agent_question: What is your booking reference? | caller_text: it's K L nine four two two | transcript_end: no sentence end -> A
agent_question: What's your phone number? | caller_text: sure, it's three one two, five five | transcript_end: no sentence end -> C
agent_question: Anything else with the pizza? | caller_text: yes, can I get that with extra | transcript_end: no sentence end -> C
agent_question: Which city are you in? | caller_text: I stay in Pune but | transcript_end: no sentence end -> C
agent_question: Does that sound right? | caller_text: Yes, that's right. | transcript_end: a full stop -> A
caller_text: yeah it was fine I guess | transcript_end: no sentence end -> B
caller_earlier: can I tell you what happened last year? | caller_text: So in March my father was admitted to the hospital. | transcript_end: a full stop -> D
agent_question: Is there anything else I can help with? | caller_text: No, that's all, thank you so much. | transcript_end: a full stop -> A

Answer with a single letter."""


def _transcript_end(text: str) -> str:
    text = text.rstrip()
    if text.endswith("?"):
        return "a question mark"
    if text.endswith((".", "!")):
        return "a full stop"
    return "no sentence end"


class CueTurnDetector:
    def __init__(
        self,
        base_url: str | None = None,
        *,
        unlikely_threshold: float = 0.5,
        timeout: float | None = None,
    ) -> None:
        # 0.4s suits a GPU; raise CUE_TIMEOUT (e.g. 10) when testing on CPU.
        timeout = timeout if timeout is not None else float(os.getenv("CUE_TIMEOUT", "0.4"))
        self._url = (base_url or os.getenv("CUE_SERVER_URL", "http://localhost:8090")).rstrip("/")
        self._unlikely = unlikely_threshold
        self._timeout = timeout
        self._client = httpx.AsyncClient(timeout=timeout)

    @property
    def model(self) -> str:
        return "cue-v1"

    @property
    def provider(self) -> str:
        return "pype"

    async def unlikely_threshold(self, language) -> float | None:
        return self._unlikely

    async def supports_language(self, language) -> bool:
        return True  # model is multilingual (14 languages)

    def _build_user_block(self, chat_ctx: llm.ChatContext) -> str:
        msgs = [
            (m.role, m.text_content or "")
            for m in chat_ctx.messages()
            if m.role in ("user", "assistant") and (m.text_content or "").strip()
        ]
        caller_text = ""
        agent_question = ""
        earlier: list[str] = []
        # last user message = current turn; last assistant message before it = question
        for i in range(len(msgs) - 1, -1, -1):
            if msgs[i][0] == "user":
                caller_text = msgs[i][1].strip()
                for j in range(i - 1, -1, -1):
                    if msgs[j][0] == "assistant":
                        agent_question = msgs[j][1].strip()
                        break
                earlier = [t.strip() for r, t in msgs[:i] if r == "user"][-3:]
                break

        lines = []
        if agent_question:
            lines.append(f"agent_question: {agent_question}")
        if earlier:
            lines.append(f"caller_earlier: {' '.join(earlier)}")
        lines.append(f"caller_text: {caller_text}")
        lines.append(f"transcript_end: {_transcript_end(caller_text)}")
        return "\n".join(lines)

    async def predict_end_of_turn(
        self, chat_ctx: llm.ChatContext, *, timeout: float | None = None
    ) -> float:
        started = time.perf_counter()
        user_block = self._build_user_block(chat_ctx)
        resp = await self._client.post(
            f"{self._url}/v1/chat/completions",
            json={
                "messages": [
                    {"role": "system", "content": _SYSTEM_PROMPT},
                    {"role": "user", "content": user_block + "\nAnswer:"},
                ],
                "max_tokens": 1,
                "temperature": 0,
                "logprobs": True,
                "top_logprobs": 20,
            },
            timeout=timeout or self._timeout,
        )
        resp.raise_for_status()
        top = resp.json()["choices"][0]["logprobs"]["content"][0]["top_logprobs"]

        probs = {name: 0.0 for name in _LABELS.values()}
        for entry in top:
            label = _LABELS.get(entry["token"].strip().upper())
            if label:
                probs[label] += math.exp(entry["logprob"])
        total = sum(probs.values())
        if total <= 0:
            logger.warning(f"cue: no label tokens in top logprobs: {top[:5]}")
            return 1.0  # fail open: behave like a finished turn
        probs = {k: v / total for k, v in probs.items()}
        p_end = probs["DONE"] + probs["LIKELY_DONE"]

        logger.warning(
            f"cue: p_end={p_end:.2f} "
            + " ".join(f"{k}={v:.2f}" for k, v in probs.items())
            + f" ({(time.perf_counter() - started) * 1000:.0f}ms) | {user_block!r}"
        )
        return p_end
