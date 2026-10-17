# Support Chat on LiveKit

Same product as the Matrix-based `Chat` project (embeddable widget -> AI answers first -> escalates to a human agent in the *same* conversation, host page can pass the customer's name/email/phone/metadata, tools and prompts editable without code), but the realtime layer is **LiveKit** instead of Matrix/Synapse. That makes **voice and video** a switch away: a conversation is a LiveKit room, and mic/camera tracks are just more participants publishing into it.

```
Customer widget ─┐                         ┌─ OpenAI-compatible LLM (LiteLLM, ...)
 (Shadow DOM)    ├─ Caddy :8080 ─ LiveKit  │
Agent console ───┘        └──── Backend ───┼─ Postgres (customers, conversations, messages, agents)
                              (REST + AI + │
                               routing)    ├─ SMTP (Mailpit / Gmail / ...)
                                           └─ your webhooks
```

| Folder                                           | What                                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `backend/`                                     | Node 22 service: REST API, AI agent + tool loop, hand-off routing, LiveKit token minting                           |
| `backend/config/`                              | **Edit these, no code changes:** `tools.yaml`, `prompts/*.md` (unchanged format from the Matrix project) |
| `widget/`                                      | Embeddable customer widget -> `widget.js` (chat now; mic/camera buttons when enabled)                            |
| `agent-ui/`                                    | React console for human agents (served at `/agent/`)                                                             |
| `livekit/`, `caddy/`, `docker-compose.yml` | Infrastructure                                                                                                     |
| `scripts/`                                     | `init.sh`, `mock-llm.mjs` (fake LLM for testing), browser e2e tests                                            |

## How it differs from the Matrix version

|                    | Matrix version          | LiveKit version                                                                                                             |
| ------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Conversation       | Matrix room             | LiveKit room `conv_<id>`                                                                                                  |
| Message history    | Synapse                 | Postgres `messages` table (LiveKit does not store messages)                                                               |
| Hand-off state     | Matrix room state event | Columns on `conversations`                                                                                                |
| Sending a message  | Matrix client SDK       | `POST /api/conversations/:id/messages`                                                                                    |
| Receiving          | Matrix `sync`         | Backend pushes events as LiveKit data packets (`chat` topic); clients ignore any packet that did not come from the server |
| AI streaming       | `m.replace` edits     | `stream` events, replaced by the final `message` with the same id                                                       |
| Agent login        | Matrix account          | `agents` table + password (scrypt) -> backend JWT                                                                         |
| Agent-only summary | message flag            | `internal` message, delivered only to the assigned agent and omitted from the customer's history API                      |

Escalation never auto-assigns: the conversation goes to *Waiting* and an agent must open it (read-only review) and press **Accept conversation**. If nobody accepts within `fallback_after_seconds`, it returns to the AI.

Everything else (AI prompt/tool loop, `tools.yaml`, escalation tools, queue + presence + max concurrent, fallback timer, customer profile headers/JWT, defaults) is carried over.

## Quick start

Prerequisites: Docker Desktop, Node 20+, Bash (Git Bash on Windows) with `openssl`.

```bash
bash scripts/init.sh                       # creates .env, generates secrets and the LiveKit API key pair
# edit .env: LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
(cd widget   && npm install && npm run build)
(cd agent-ui && npm install && npm run build)
docker compose up -d --build
docker compose exec backend node dist/cli/create-agent.js alice 'a-strong-password' 'Alice'
```

- Demo site with the widget: http://localhost:8080/
- Agent console: http://localhost:8080/agent/ (sign in, click *Offline* -> *Online*). Escalated chats appear under *Waiting*; open one to review the AI summary banner and the whole conversation, then press **Accept conversation** to take it and reply.
- Test emails (Mailpit): http://localhost:8025

No LLM at hand? Run `node scripts/mock-llm.mjs`, then `docker compose -f docker-compose.yml -f docker-compose.mock-llm.yml up -d backend` (a message containing "human" triggers an escalation). Switch back with `docker compose up -d backend`.

Dev servers: `cd widget && npm run dev` (5173) and `cd agent-ui && npm run dev` (5174), both talking to Caddy on :8080.

## Embedding

Identical to the Matrix version, plus an optional `calls` switch:

```html
<script src="https://your-host/widget.js"></script>
<script>
  SupportChat.init({
    backendUrl: "https://your-host",
    user: { name: "Priya Nair", email: "priya@example.com", phone: "+91 98123 45678" },  // all optional
    metadata: { plan: "pro", orders: 3 },        // optional free-form facts for the AI and agents
    customHeaders: { "X-Tenant-Id": "acme" },    // optional
    calls: { voice: true, video: true },         // optional; buttons appear only if the backend enables them
    theme: "auto"                                // optional: "light" | "dark" | "auto" (follows the visitor OS)
  });
</script>
```

The customer details headers (`X-Customer-Name/Email/Phone/Meta`), validation limits, defaults, and `CUSTOMER_AUTH_MODE=external_jwt` behave exactly as described in the Matrix project's README.

## Voice and video

**Works today (human <-> customer):** set `ENABLE_VOICE=true` and/or `ENABLE_VIDEO=true` in `.env` and restart the backend. Tokens then allow publishing microphone/camera; the widget shows 🎤/📷 buttons and the agent console shows 🎤/📷 buttons plus the customer's video. Tested with fake media devices (`scripts/call-e2e.mjs`).

### AI voice assistant (branch `voice-feat`)

A LiveKit Agents worker (`voice-agent/`, Python, `livekit-agents` 1.6.10, same versions as AXLAI voicekit) answers by voice.

```
customer turns on the mic (AI is handling the chat)
  -> widget: POST /api/conversations/:id/voice/start
  -> backend dispatches the worker "support-voice" into the room conv_<id>
  -> worker: GET /api/internal/voice/session/:id   (chosen pipeline, system prompt + voice rules, history, tools)
  -> VAD -> turn detection -> STT -> LLM (+ tools) -> TTS, in the same LiveKit room
  -> every spoken line is stored as a normal chat message (widget, history, agent console, emails)
  -> escalation tool (same tools.yaml) => the assistant says the hand-over line and leaves; a human accepts in the same room
```

**Turn it on**

1. `.env`: `ENABLE_VOICE=true`, `INTERNAL_API_TOKEN` (`init.sh` generates it) and the API keys of the providers you want (see `.env.example`).
2. `docker compose --profile voice up -d --build` (builds `voice-agent/`; the first build downloads the turn-detector models). Set `VOICE_IDLE_PROCESSES` to your expected number of simultaneous calls (one warm process per call; a cold one takes about 10 s).
3. Agent console -> **Voice settings**: pick the pipeline and save. New calls use it; calls in progress keep theirs.

**The stack you can choose from** (catalog: `backend/config/voice.yaml`, same provider ids as AXLAI voicekit)

| Component | Options |
|---|---|
| VAD | Silero (presets balanced / sensitive / noise robust + tuning), ai-coustics, none |
| Noise suppression | off, DTLN (self-hosted), ai-coustics |
| Turn detection | LiveKit multilingual, LiveKit English, Pype cue-v1 (llama.cpp server), STT end-of-turn (Deepgram Flux), VAD only |
| STT | OpenAI-compatible (LiteLLM), Deepgram (nova-3 / nova-2), Deepgram Flux, Azure Speech, Azure OpenAI |
| LLM | OpenAI-compatible (LiteLLM), OpenAI, Azure OpenAI |
| TTS | OpenAI-compatible (LiteLLM), OpenAI, Azure OpenAI, ElevenLabs (`11labs`), Azure Speech, Cartesia, Neuphonic, Murf, Gemini, Google Cloud |

The console cascades provider -> model -> language / voice like the AXLAI console, shows which providers still miss an API key, and blocks invalid pairings on save (for example a non-streaming STT or the multilingual turn detector without a VAD, or "STT end-of-turn" without Deepgram Flux). The LLM can call every tool in `tools.yaml` (escalate to a human, email, webhooks, ...): the worker only relays them to the backend.

**Add a provider:** add it to `backend/config/voice.yaml` and a branch in `voice-agent/src/factories.py` (plus its `livekit-plugins-*` package in `voice-agent/pyproject.toml`). `voice-agent/tests/build_all.py` builds every catalog entry with dummy keys to catch mismatches.

**Run the worker without Docker:**

```bash
cd voice-agent && uv venv --python 3.12 && uv sync
uv run python main.py download-files
LIVEKIT_URL=ws://localhost:7880 BACKEND_URL=http://localhost:3000 uv run python main.py dev   # LIVEKIT_API_KEY/SECRET and the rest come from ../.env
```

**Good to know**

- The default "OpenAI-compatible" STT and TTS need a LiteLLM proxy that actually serves a transcription model and a speech model. Many proxies only serve chat models: then pick Deepgram / Azure / ElevenLabs / ... and add their keys. `gpt-4o-mini-tts` streams over SSE, `tts-1` over plain bytes; `OPENAI_TTS_RESPONSE_FORMAT=pcm` skips MP3 decoding where the endpoint supports it.
- ai-coustics needs `AIC_SDK_LICENSE` (the worker falls back to Silero / no suppression without it). cue-v1 needs its llama.cpp server at `CUE_SERVER_URL`.
- Customer audio goes to the STT provider you choose and transcripts are stored in Postgres like any chat message.
- Only the AI-handling phase is voice-assisted: when a human accepts the conversation, the assistant leaves and the human talks to the customer in the same room.
- Logging rule applies to the worker too: no transcripts, prompts or tool arguments in logs.

## Notes and limits (v1)

- Single backend instance: the agent-assignment lock is in-process. To scale out, replace `exclusive()` in `backend/src/routing/agents.ts` with a Postgres advisory lock.
- The agent queue is polled every 4 s (the room events are live; the queue list is not).
- No typing indicator for humans, no file attachments, no end-to-end encryption.
- `widget/src/useConversation.ts` and `agent-ui/src/useConversation.ts` are identical copies; keep them in sync (or extract a shared package).
- Logging rule (same as the Matrix project): never log message bodies, prompts or tool arguments.

## Tests

```bash
npm install
node scripts/mock-llm.mjs &        # fake LLM
docker compose -f docker-compose.yml -f docker-compose.mock-llm.yml up -d backend
npm run e2e:ui                     # chat, AI streaming, escalation, hand-off, reload (needs Edge + agent alice)
node scripts/call-e2e.mjs          # human voice/video tracks (needs ENABLE_VOICE/VIDEO=true)

# AI voice (mock STT/TTS/LLM, no provider keys): start the worker as above with LLM_BASE_URL=http://localhost:4000
# LLM_API_KEY=mock OPENAI_TTS_RESPONSE_FORMAT=pcm, then:
node scripts/voice-e2e.mjs         # assistant joins, greets, transcribes, answers, audio reaches the browser
MOCK_STT_TEXT="I want to talk to a human please" node scripts/mock-llm.mjs   # (restart the mock) then:
node scripts/voice-handoff-e2e.mjs # spoken request -> escalation -> assistant leaves -> agent accepts
voice-agent/.venv/Scripts/python voice-agent/tests/build_all.py              # builds every provider in the catalog
```
