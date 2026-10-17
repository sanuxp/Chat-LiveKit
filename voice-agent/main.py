"""LiveKit Agents worker for the support chat's AI voice assistant.

Run:   python main.py dev      (local, hot reload)     python main.py start     (production)
First: python main.py download-files   (turn-detector / VAD models)

The worker registers under VOICE_AGENT_NAME and only starts when the backend dispatches it into a conversation's room
(customer turns on the microphone while the AI is handling the chat).
"""
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()  # voice-agent/.env, if any
load_dotenv(Path(__file__).resolve().parent.parent / ".env")  # the stack's shared .env (local runs without Docker)

from livekit.agents import AgentServer, JobContext, JobExecutorType, cli  # noqa: E402

from src.call import run_call  # noqa: E402
from src.log import setup_logger  # noqa: E402

logger = setup_logger("voice_agent_main")

# One OS process per call (isolation; also what VOICE_IDLE_PROCESSES pre-warms). Set VOICE_EXECUTOR=thread to run calls as threads.
executor = JobExecutorType.THREAD if os.getenv("VOICE_EXECUTOR", "process").lower() == "thread" else JobExecutorType.PROCESS
server = AgentServer(job_executor_type=executor, num_idle_processes=int(os.getenv("VOICE_IDLE_PROCESSES", "2")))


@server.rtc_session(agent_name=os.getenv("VOICE_AGENT_NAME", "support-voice"))
async def entrypoint(ctx: JobContext) -> None:
    logger.info("job for room %s", ctx.room.name)
    await run_call(ctx)


if __name__ == "__main__":
    cli.run_app(server)
