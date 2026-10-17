"""One AI voice call: joins the conversation's LiveKit room, runs STT -> LLM -> TTS with the pipeline chosen in the
console, stores the transcript as normal chat messages, and leaves when a human takes over."""
import asyncio
import json
from typing import Any

from livekit import rtc
from livekit.agents import Agent, AgentSession, JobContext, RoomInputOptions, RunContext, StopResponse, function_tool, llm

from .backend import Backend
from .factories import (
    PipelineError, build_llm, build_noise, build_stt, build_tts, build_turn_detection, build_vad, combine_frame_processors,
)
from .log import setup_logger

logger = setup_logger("call")

MIC_OFF_GRACE_SECONDS = 45  # leave if the customer's microphone stays off this long


async def run_call(ctx: JobContext) -> None:
    conversation_id = json.loads(ctx.job.metadata or "{}").get("conversationId")
    if not conversation_id:
        logger.error("job has no conversationId in its metadata")
        return

    backend = Backend()
    ctx.add_shutdown_callback(backend.aclose)
    await ctx.connect()

    cfg = await backend.session(conversation_id)
    if cfg["status"] != "ai":
        logger.info("conversation %s is not with the AI (status=%s); not joining", conversation_id, cfg["status"])
        ctx.shutdown(reason="not in AI mode")
        return
    sel: dict[str, Any] = cfg["selection"]
    customer_identity: str = cfg["customerIdentity"]

    # transcript lines are stored in order, off the audio path
    outbox: asyncio.Queue[tuple[str, str] | None] = asyncio.Queue()

    async def pump() -> None:
        while (item := await outbox.get()) is not None:
            try:
                await backend.post_message(conversation_id, *item)
            except Exception as e:  # never log the text itself
                logger.warning("could not store a transcript line (%s)", type(e).__name__)

    pump_task = asyncio.create_task(pump())

    async def flush_outbox() -> None:
        outbox.put_nowait(None)
        await pump_task

    ctx.add_shutdown_callback(flush_outbox)

    # ---- build the pipeline chosen in Voice settings ------------------------------------------------------------
    try:
        vad, vad_processor = await build_vad(sel)
        noise = await build_noise(sel)
        stt = build_stt(sel)
        llm_ = build_llm(sel)
        tts = build_tts(sel)
        turn_detection = build_turn_detection(sel, has_vad=vad is not None)
    except PipelineError as e:
        logger.error("voice pipeline unavailable: %s", e)
        outbox.put_nowait(("ai", "Sorry, the voice assistant isn't available right now. You can keep typing here."))
        ctx.shutdown(reason="pipeline unavailable")
        return
    logger.info(
        "call %s: vad=%s noise=%s turn=%s stt=%s/%s llm=%s/%s tts=%s/%s",
        conversation_id, sel["vad_provider"], sel["noise_provider"], sel["turn_detection"], sel["stt_provider"], sel["stt_model"],
        sel["llm_provider"], sel["llm_model"], sel["tts_provider"], sel["tts_model"],
    )

    session_kwargs: dict[str, Any] = dict(
        turn_detection=turn_detection, stt=stt, llm=llm_, tts=tts,
        min_interruption_words=int(sel["min_interruption_words"]),
        min_endpointing_delay=sel["min_endpointing_delay"], max_endpointing_delay=sel["max_endpointing_delay"],
    )
    if vad is not None:
        session_kwargs["vad"] = vad
    session = AgentSession(**session_kwargs)

    # ---- tools: the same tools.yaml tools the text chat uses, executed by the backend ---------------------------
    async def leave_after_handoff(text: str) -> None:
        try:
            if text:
                await session.say(text, add_to_chat_ctx=False, allow_interruptions=False).wait_for_playout()
        finally:
            ctx.shutdown(reason="handed over to a human")

    def make_tool(spec: dict[str, Any]):
        async def handler(raw_arguments: dict[str, object], context: RunContext):
            try:
                res = await backend.run_tool(conversation_id, spec["name"], raw_arguments)
            except Exception as e:
                logger.warning("tool %s failed (%s)", spec["name"], type(e).__name__)
                return json.dumps({"error": "The tool failed unexpectedly"})
            if res.get("endTurn"):  # e.g. escalated to a human: say the hand-over line, then leave. No more LLM text.
                asyncio.create_task(leave_after_handoff(res.get("customerText") or ""))
                raise StopResponse()
            return json.dumps(res.get("llmResult"))

        return function_tool(handler, raw_schema={"name": spec["name"], "description": spec["description"], "parameters": spec["parameters"]})

    chat_ctx = llm.ChatContext.empty()
    for h in cfg["history"]:
        chat_ctx.add_message(role=h["role"], content=h["text"])
    agent = Agent(instructions=cfg["systemPrompt"], tools=[make_tool(t) for t in cfg["tools"]], chat_ctx=chat_ctx)

    # ---- transcript -> chat messages ------------------------------------------------------------------------------
    @session.on("conversation_item_added")
    def _on_item(ev) -> None:
        item = ev.item
        text = (getattr(item, "text_content", None) or "").strip()
        if getattr(item, "type", "message") != "message" or not text:
            return
        if item.role == "user":
            outbox.put_nowait(("customer", text))
        elif item.role == "assistant":
            outbox.put_nowait(("ai", text))

    @session.on("error")
    def _on_error(ev) -> None:
        logger.warning("session error: %s", type(getattr(ev, "error", ev)).__name__)

    # ---- leave when a human takes over, or when the customer's microphone has been off for a while ---------------
    def _on_data(pkt: rtc.DataPacket) -> None:
        if pkt.topic != "chat" or pkt.participant is not None:  # only the backend (no participant) may publish chat events
            return
        try:
            ev = json.loads(pkt.data)
        except ValueError:
            return
        if ev.get("t") == "state" and ev.get("status") != "ai":
            logger.info("conversation left AI mode (%s); leaving the room", ev.get("status"))
            ctx.shutdown(reason="conversation left AI mode")

    ctx.room.on("data_received", _on_data)

    idle: dict[str, asyncio.Task | None] = {"task": None}

    def _is_customer_mic(pub: rtc.TrackPublication, participant: rtc.RemoteParticipant) -> bool:
        return participant.identity == customer_identity and pub.kind == rtc.TrackKind.KIND_AUDIO

    def _on_unpublished(pub: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant) -> None:
        if _is_customer_mic(pub, participant) and idle["task"] is None:
            async def _leave() -> None:
                await asyncio.sleep(MIC_OFF_GRACE_SECONDS)
                ctx.shutdown(reason="customer microphone off")
            idle["task"] = asyncio.create_task(_leave())

    def _on_published(pub: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant) -> None:
        if _is_customer_mic(pub, participant) and idle["task"] is not None:
            idle["task"].cancel()
            idle["task"] = None

    ctx.room.on("track_unpublished", _on_unpublished)
    ctx.room.on("track_published", _on_published)

    # ---- go ---------------------------------------------------------------------------------------------------------
    await session.start(
        agent=agent,
        room=ctx.room,
        room_input_options=RoomInputOptions(
            noise_cancellation=combine_frame_processors([vad_processor, noise]),
            participant_identity=customer_identity,  # a human agent joining later must not be treated as the caller
        ),
    )
    await session.say(sel["greeting"])
